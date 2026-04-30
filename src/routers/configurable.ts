import { getGuardAgentConfig } from "../guard-agent.js";
import { callChatCompletion } from "../local-model.js";
import { getKeywordRegex } from "../rules.js";
import type {
  DetectionContext,
  ClawXrouterRouter,
  RouterAction,
  RouterDecision,
  SensitivityLevel,
  RouterRegistration,
} from "../types.js";
import { maxLevel } from "../types.js";
import type { PrivacyConfig } from "../types.js";

export interface ConfigurableRouterOptions {
  keywords?: { S2?: string[]; S3?: string[] };
  patterns?: { S2?: string[]; S3?: string[] };
  prompt?: string;
  action?: string;
}

function getOptions(
  routerId: string,
  pluginConfig: Record<string, unknown>,
): ConfigurableRouterOptions {
  const privacy = (pluginConfig?.privacy ?? {}) as Record<string, unknown>;
  const routers = (privacy.routers ?? {}) as Record<string, RouterRegistration>;
  const reg = routers[routerId];
  return (reg?.options ?? {}) as ConfigurableRouterOptions;
}

function getPrivacyConfig(pluginConfig: Record<string, unknown>): PrivacyConfig {
  return (pluginConfig?.privacy ?? {}) as PrivacyConfig;
}

function checkKeywords(
  text: string,
  keywords: { S2?: string[]; S3?: string[] },
): { level: SensitivityLevel; reason?: string } {
  for (const kw of keywords.S3 ?? []) {
    if (getKeywordRegex(kw).test(text)) {
      return { level: "S3", reason: `S3 keyword: ${kw}` };
    }
  }
  for (const kw of keywords.S2 ?? []) {
    if (getKeywordRegex(kw).test(text)) {
      return { level: "S2", reason: `S2 keyword: ${kw}` };
    }
  }
  return { level: "S1" };
}

function checkPatterns(
  text: string,
  patterns: { S2?: string[]; S3?: string[] },
): { level: SensitivityLevel; reason?: string } {
  for (const pat of patterns.S3 ?? []) {
    try {
      if (new RegExp(pat, "i").test(text)) {
        return { level: "S3", reason: `S3 pattern: ${pat}` };
      }
    } catch {
      /* skip invalid regex */
    }
  }
  for (const pat of patterns.S2 ?? []) {
    try {
      if (new RegExp(pat, "i").test(text)) {
        return { level: "S2", reason: `S2 pattern: ${pat}` };
      }
    } catch {
      /* skip invalid regex */
    }
  }
  return { level: "S1" };
}

async function classifyWithPrompt(
  message: string,
  systemPrompt: string,
  pluginConfig: Record<string, unknown>,
): Promise<{ level: SensitivityLevel; reason?: string } | null> {
  const pCfg = getPrivacyConfig(pluginConfig);
  const lm = pCfg.localModel;
  if (!lm?.enabled || !lm.endpoint) return null;

  try {
    const raw = await callChatCompletion(
      lm.endpoint,
      lm.model ?? "",
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      {
        temperature: 0,
        maxTokens: 256,
        apiKey: lm.apiKey,
        providerType: (lm.type ?? "openai-compatible") as
          | "openai-compatible"
          | "ollama-native"
          | "custom",
        customModule: lm.module,
      },
    );
    const text = raw.text.trim();
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    const level = String(parsed.level ?? "S1").toUpperCase();
    if (level === "S2" || level === "S3") {
      return { level: level as SensitivityLevel, reason: parsed.reason ?? "LLM classification" };
    }
    return { level: "S1" };
  } catch {
    return null;
  }
}

/**
 * Resolve the routing target for S2/S3, aligned with the privacy router's
 * target resolution so hooks.ts can route correctly.
 */
function resolveTargetForLevel(
  level: SensitivityLevel,
  pluginConfig: Record<string, unknown>,
): { provider: string; model: string } {
  const pCfg = getPrivacyConfig(pluginConfig);
  if (level === "S3") {
    const guardCfg = getGuardAgentConfig(pCfg);
    const defaultProvider = pCfg.localModel?.provider ?? "ollama";
    return {
      provider: guardCfg?.provider ?? defaultProvider,
      model: guardCfg?.modelName ?? pCfg.localModel?.model ?? "openbmb/minicpm4.1",
    };
  }
  // S2
  const s2Policy = pCfg.s2Policy ?? "proxy";
  if (s2Policy === "local") {
    const guardCfg = getGuardAgentConfig(pCfg);
    const defaultProvider = pCfg.localModel?.provider ?? "ollama";
    return {
      provider: guardCfg?.provider ?? defaultProvider,
      model: guardCfg?.modelName ?? pCfg.localModel?.model ?? "openbmb/minicpm4.1",
    };
  }
  return { provider: "clawxrouter-privacy", model: "" };
}

/**
 * Create a configurable router instance with the given ID.
 * The router reads its options (keywords, patterns, prompt) from the
 * plugin config at runtime so dashboard changes take effect immediately.
 */
export function createConfigurableRouter(id: string): ClawXrouterRouter {
  return {
    id,
    async detect(
      context: DetectionContext,
      pluginConfig: Record<string, unknown>,
    ): Promise<RouterDecision> {
      const opts = getOptions(id, pluginConfig);
      const text = context.message ?? "";
      const levels: SensitivityLevel[] = [];
      const reasons: string[] = [];

      // Keyword matching
      if (opts.keywords && text) {
        const kw = checkKeywords(text, opts.keywords);
        if (kw.level !== "S1") {
          levels.push(kw.level);
          if (kw.reason) reasons.push(kw.reason);
        }
      }

      // Pattern matching
      if (opts.patterns && text) {
        const pat = checkPatterns(text, opts.patterns);
        if (pat.level !== "S1") {
          levels.push(pat.level);
          if (pat.reason) reasons.push(pat.reason);
        }
      }

      // LLM prompt classification (only if no keyword/pattern hit or for extra accuracy)
      if (opts.prompt && text) {
        const llm = await classifyWithPrompt(text, opts.prompt, pluginConfig);
        if (llm && llm.level !== "S1") {
          levels.push(llm.level);
          if (llm.reason) reasons.push(llm.reason);
        }
      }

      if (levels.length === 0) {
        return { level: "S1", action: "passthrough", reason: "No match" };
      }

      const finalLevel = maxLevel(...levels);
      const action = (opts.action ?? "redirect") as RouterAction;

      let target: { provider: string; model: string } | undefined;
      if (finalLevel !== "S1" && action === "redirect") {
        target = resolveTargetForLevel(finalLevel, pluginConfig);
      }

      return {
        level: finalLevel,
        action,
        target,
        reason: reasons.join("; "),
        confidence: levels.some((l) => l !== "S1") ? 0.8 : 0.5,
      };
    },
  };
}
