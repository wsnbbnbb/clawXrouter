import { defaultPrivacyConfig } from "../config-schema.js";
import { detectSensitivityLevel } from "../detector.js";
import { getGuardAgentConfig } from "../guard-agent.js";
import { desensitizeWithLocalModel } from "../local-model.js";
import type {
  DetectionContext,
  ClawXrouterRouter,
  PrivacyConfig,
  RouterDecision,
  SensitivityLevel,
} from "../types.js";

/**
 * Map a DetectionResult (from detector.ts) into a RouterDecision.
 * This bridges the legacy detector API to the new router pipeline API.
 */
function detectionToDecision(
  level: SensitivityLevel,
  reason: string | undefined,
  privacyConfig: PrivacyConfig,
): RouterDecision {
  if (level === "S1") {
    return { level: "S1", action: "passthrough", reason };
  }

  if (level === "S3") {
    const guardCfg = getGuardAgentConfig(privacyConfig);
    const defaultProvider = privacyConfig.localModel?.provider ?? "ollama";
    return {
      level: "S3",
      action: "redirect",
      target: {
        provider: guardCfg?.provider ?? defaultProvider,
        model: guardCfg?.modelName ?? privacyConfig.localModel?.model ?? "openbmb/minicpm4.1",
      },
      reason,
    };
  }

  // S2
  const s2Policy = privacyConfig.s2Policy ?? "proxy";
  if (s2Policy === "local") {
    const guardCfg = getGuardAgentConfig(privacyConfig);
    const defaultProvider = privacyConfig.localModel?.provider ?? "ollama";
    return {
      level: "S2",
      action: "redirect",
      target: {
        provider: guardCfg?.provider ?? defaultProvider,
        model: guardCfg?.modelName ?? privacyConfig.localModel?.model ?? "openbmb/minicpm4.1",
      },
      reason,
    };
  }

  // s2Policy === "proxy"
  return {
    level: "S2",
    action: "redirect",
    target: { provider: "clawxrouter-privacy", model: "" },
    reason,
  };
}

function getPrivacyConfig(pluginConfig: Record<string, unknown>): PrivacyConfig {
  const userConfig = (pluginConfig?.privacy as PrivacyConfig) ?? {};
  return {
    ...defaultPrivacyConfig,
    ...userConfig,
    checkpoints: { ...defaultPrivacyConfig.checkpoints, ...userConfig.checkpoints },
    rules: {
      keywords: { ...defaultPrivacyConfig.rules.keywords, ...userConfig.rules?.keywords },
      patterns: { ...defaultPrivacyConfig.rules.patterns, ...userConfig.rules?.patterns },
      tools: {
        S2: { ...defaultPrivacyConfig.rules.tools.S2, ...userConfig.rules?.tools?.S2 },
        S3: { ...defaultPrivacyConfig.rules.tools.S3, ...userConfig.rules?.tools?.S3 },
      },
    },
    localModel: { ...defaultPrivacyConfig.localModel, ...userConfig.localModel },
    guardAgent: { ...defaultPrivacyConfig.guardAgent, ...userConfig.guardAgent },
    session: { ...defaultPrivacyConfig.session, ...userConfig.session },
  };
}

export const privacyRouter: ClawXrouterRouter = {
  id: "privacy",

  async detect(
    context: DetectionContext,
    pluginConfig: Record<string, unknown>,
  ): Promise<RouterDecision> {
    const privacyConfig = getPrivacyConfig(pluginConfig);

    if (privacyConfig.enabled === false && !context.dryRun) {
      return { level: "S1", action: "passthrough", reason: "Privacy detection disabled" };
    }

    const result = await detectSensitivityLevel(context, pluginConfig, privacyConfig);

    return detectionToDecision(result.level, result.reason, privacyConfig);
  },
};
