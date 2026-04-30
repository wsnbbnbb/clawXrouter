import { createHash } from "node:crypto";
import { callChatCompletion } from "../local-model.js";
import { loadPrompt } from "../prompt-loader.js";
import { getGlobalCollector } from "../token-stats.js";
import type {
  ClawXrouterRouter,
  DetectionContext,
  EdgeProviderType,
  RouterDecision,
} from "../types.js";

// ── Types ──

type TierTarget = {
  provider: string;
  model: string;
  description?: string;
};

type TokenSaverConfig = {
  enabled: boolean;
  judgeEndpoint: string;
  judgeModel: string;
  judgeProviderType: EdgeProviderType;
  judgeCustomModule?: string;
  judgeApiKey?: string;
  tiers: Record<string, TierTarget>;
  defaultTier?: string;
  rules?: string[];
  cacheTtlMs: number;
};

const DEFAULT_CONFIG: TokenSaverConfig = {
  enabled: false,
  judgeEndpoint: "http://localhost:11434",
  judgeModel: "openbmb/minicpm4.1",
  judgeProviderType: "openai-compatible",
  tiers: {
    SIMPLE: { provider: "zhipu", model: "glm-4.5-air" },
    MEDIUM: { provider: "minimax", model: "minimax-m2.5" },
    COMPLEX: { provider: "deepseek", model: "deepseek-v3.2" },
    RESEARCH: { provider: "zhipu", model: "glm-5" },
    REASONING: { provider: "moonshot", model: "kimi-k2.5" },
  },
  cacheTtlMs: 300_000,
};

// ── Prompt generation ──

function generateJudgePrompt(tiers: Record<string, TierTarget>, rules?: string[]): string {
  const tierNames = Object.keys(tiers);

  const tierDefs = tierNames
    .map((name) => {
      const desc = tiers[name].description;
      return desc ? `${name} = ${desc}` : name;
    })
    .join("\n");

  const defaultRules = [
    "When unsure, pick the LOWER tier (save tokens).",
    "Short prompts (< 20 words) with no technical depth → the lowest tier.",
  ];
  const allRules = [...defaultRules, ...(rules ?? [])];
  const rulesBlock = allRules.map((r) => `- ${r}`).join("\n");

  const tierList = tierNames.join("|");

  return [
    "You are a task complexity classifier. Classify the user's task into exactly one tier.",
    "",
    tierDefs,
    "",
    "Rules:",
    rulesBlock,
    "",
    `CRITICAL: Output ONLY the raw JSON object. Do NOT wrap in markdown code blocks. Do NOT add any text before or after.`,
    `{"tier":"${tierList}"}`,
  ].join("\n");
}

const FALLBACK_JUDGE_PROMPT = `You are a task complexity classifier. Output ONLY a JSON object: {"tier":"MEDIUM"}`;

// ── Cache ──

type CacheEntry = { tier: string; ts: number };
const classificationCache = new Map<string, CacheEntry>();

const CACHE_CLEANUP_INTERVAL_MS = 60_000;
const CACHE_MAX_AGE_MS = 600_000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCacheCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of classificationCache) {
      if (now - v.ts > CACHE_MAX_AGE_MS) classificationCache.delete(k);
    }
  }, CACHE_CLEANUP_INTERVAL_MS);
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    (cleanupTimer as NodeJS.Timeout).unref();
  }
}

// ── Helpers ──

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

function parseTier(response: string, validTiers: Set<string>, defaultTier: string): string {
  try {
    const cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*?"tier"\s*:\s*"([A-Za-z_]+)"[\s\S]*?\}/);
    if (match) {
      const tier = match[1].toUpperCase();
      if (validTiers.has(tier)) return tier;
    }
  } catch {
    // parse failure
  }
  return defaultTier;
}

function buildDecision(tier: string, config: TokenSaverConfig): RouterDecision {
  const target = config.tiers[tier];
  if (!target) {
    return { level: "S1", action: "passthrough", reason: `no model mapping for tier ${tier}` };
  }
  return {
    level: "S1",
    action: "redirect",
    target: { provider: target.provider, model: target.model },
    reason: `tier=${tier}`,
    confidence: 0.8,
  };
}

function resolveConfig(pluginConfig: Record<string, unknown>): TokenSaverConfig {
  const routers = (pluginConfig?.privacy as Record<string, unknown>)?.routers as
    | Record<string, { options?: Record<string, unknown>; enabled?: boolean }>
    | undefined;
  const tsConfig = routers?.["token-saver"];
  const options = (tsConfig?.options ?? {}) as Record<string, unknown>;

  const privacyLocalModel = (pluginConfig?.privacy as Record<string, unknown>)?.localModel as
    | {
        endpoint?: string;
        model?: string;
        type?: EdgeProviderType;
        module?: string;
        apiKey?: string;
      }
    | undefined;

  return {
    enabled: tsConfig?.enabled ?? DEFAULT_CONFIG.enabled,
    judgeEndpoint:
      (options.judgeEndpoint as string) ??
      privacyLocalModel?.endpoint ??
      DEFAULT_CONFIG.judgeEndpoint,
    judgeModel:
      (options.judgeModel as string) ?? privacyLocalModel?.model ?? DEFAULT_CONFIG.judgeModel,
    judgeProviderType:
      (options.judgeProviderType as EdgeProviderType) ??
      privacyLocalModel?.type ??
      DEFAULT_CONFIG.judgeProviderType,
    judgeCustomModule: (options.judgeCustomModule as string) ?? privacyLocalModel?.module,
    judgeApiKey: (options.judgeApiKey as string) ?? privacyLocalModel?.apiKey,
    tiers: (options.tiers as Record<string, TierTarget>) ?? DEFAULT_CONFIG.tiers,
    defaultTier: (options.defaultTier as string) ?? undefined,
    rules: (options.rules as string[]) ?? undefined,
    cacheTtlMs: (options.cacheTtlMs as number) ?? DEFAULT_CONFIG.cacheTtlMs,
  };
}

function hasAnyDescription(tiers: Record<string, TierTarget>): boolean {
  return Object.values(tiers).some((t) => t.description);
}

// ── Router ──

export const tokenSaverRouter: ClawXrouterRouter = {
  id: "token-saver",

  async detect(
    context: DetectionContext,
    pluginConfig: Record<string, unknown>,
  ): Promise<RouterDecision> {
    const config = resolveConfig(pluginConfig);
    if (!config.enabled && !context.dryRun) {
      return { level: "S1", action: "passthrough" };
    }

    const isSubagent = context.sessionKey?.includes(":subagent:") ?? false;
    if (isSubagent) {
      return { level: "S1", action: "passthrough", reason: "subagent — skipped" };
    }

    const tierNames = Object.keys(config.tiers);
    if (tierNames.length === 0) {
      return { level: "S1", action: "passthrough", reason: "no tiers configured" };
    }

    const prompt = context.message ?? "";
    if (!prompt.trim()) {
      return { level: "S1", action: "passthrough" };
    }

    startCacheCleanup();
    const validTiers = new Set(tierNames);
    const defaultTier =
      config.defaultTier && validTiers.has(config.defaultTier)
        ? config.defaultTier
        : (tierNames[Math.floor(tierNames.length / 2)] ?? "MEDIUM");

    const cacheKey = hashPrompt(prompt);
    const cached = classificationCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < config.cacheTtlMs) {
      if (validTiers.has(cached.tier)) {
        return buildDecision(cached.tier, config);
      }
    }

    try {
      const promptFileContent = loadPrompt("token-saver-judge", "");
      let judgeSystemPrompt: string;

      if (promptFileContent) {
        judgeSystemPrompt = promptFileContent;
      } else if (hasAnyDescription(config.tiers)) {
        judgeSystemPrompt = generateJudgePrompt(config.tiers, config.rules);
      } else {
        judgeSystemPrompt = FALLBACK_JUDGE_PROMPT;
      }

      const result = await callChatCompletion(
        config.judgeEndpoint,
        config.judgeModel,
        [
          { role: "system", content: judgeSystemPrompt },
          { role: "user", content: prompt },
        ],
        {
          temperature: 0,
          maxTokens: 1024,
          providerType: config.judgeProviderType,
          customModule: config.judgeCustomModule,
          apiKey: config.judgeApiKey,
        },
      );

      if (result.usage) {
        const collector = getGlobalCollector();
        collector?.record({
          sessionKey: context.sessionKey ?? "",
          provider: "edge",
          model: config.judgeModel,
          source: "router",
          usage: result.usage,
        });
      }

      const tier = parseTier(result.text, validTiers, defaultTier);
      classificationCache.set(cacheKey, { tier, ts: Date.now() });
      return buildDecision(tier, config);
    } catch (err) {
      console.error(`[ClawXrouter] [TokenSaver] judge call failed:`, err);
      return { level: "S1", action: "passthrough", reason: "judge call failed — passthrough" };
    }
  },
};

// ── Exports for testing ──

export {
  parseTier,
  hashPrompt,
  classificationCache,
  resolveConfig,
  generateJudgePrompt,
  DEFAULT_CONFIG,
  FALLBACK_JUDGE_PROMPT as DEFAULT_JUDGE_PROMPT,
};
export type { TierTarget, TokenSaverConfig };
