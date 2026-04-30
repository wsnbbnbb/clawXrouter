import { defaultPrivacyConfig } from "./config-schema.js";
import { detectByLocalModel } from "./local-model.js";
import { detectByRules } from "./rules.js";
import type {
  Checkpoint,
  DetectionContext,
  DetectionResult,
  DetectorType,
  PrivacyConfig,
  SensitivityLevel,
} from "./types.js";
import { maxLevel } from "./types.js";

/**
 * Main detection function that coordinates all detectors.
 *
 * Accepts either a raw `pluginConfig` (legacy — will merge with defaults)
 * or a pre-merged `PrivacyConfig` via the `resolvedConfig` option to avoid
 * double-merging when called from routers that already merged config.
 */
export async function detectSensitivityLevel(
  context: DetectionContext,
  pluginConfig: Record<string, unknown>,
  resolvedConfig?: PrivacyConfig,
): Promise<DetectionResult> {
  const privacyConfig =
    resolvedConfig ??
    mergeWithDefaults((pluginConfig?.privacy as PrivacyConfig) ?? {}, defaultPrivacyConfig);

  // Check if privacy is enabled (skip when dry-run so dashboards get real classification)
  if (privacyConfig.enabled === false && !context.dryRun) {
    return {
      level: "S1",
      levelNumeric: 1,
      reason: "Privacy detection disabled",
      detectorType: "ruleDetector",
      confidence: 1.0,
    };
  }

  // Get detectors for this checkpoint
  const detectors = getDetectorsForCheckpoint(context.checkpoint, privacyConfig);

  if (detectors.length === 0) {
    // No detectors configured for this checkpoint, default to S1
    return {
      level: "S1",
      levelNumeric: 1,
      reason: "No detectors configured",
      detectorType: "ruleDetector",
      confidence: 1.0,
    };
  }

  // Run all configured detectors
  const results = await runDetectors(detectors, context, privacyConfig);

  // Merge results (take maximum level)
  return mergeDetectionResults(results);
}

/**
 * Get configured detectors for a specific checkpoint
 */
function getDetectorsForCheckpoint(checkpoint: Checkpoint, config: PrivacyConfig): DetectorType[] {
  const checkpoints = config.checkpoints ?? {};

  switch (checkpoint) {
    case "onUserMessage":
      return checkpoints.onUserMessage ?? ["ruleDetector", "localModelDetector"];
    case "onToolCallProposed":
      return checkpoints.onToolCallProposed ?? ["ruleDetector"];
    case "onToolCallExecuted":
      return checkpoints.onToolCallExecuted ?? ["ruleDetector"];
    default:
      return ["ruleDetector"];
  }
}

/**
 * Run detectors and collect results.
 *
 * Short-circuits on S3: once any detector returns S3 (highest level),
 * remaining detectors are skipped — no further detection can raise the
 * level and running an LLM judge for a message that will stay local is
 * both wasteful and a needless exposure of sensitive content.
 */
async function runDetectors(
  detectors: DetectorType[],
  context: DetectionContext,
  config: PrivacyConfig,
): Promise<DetectionResult[]> {
  const results: DetectionResult[] = [];

  for (const detector of detectors) {
    try {
      let result: DetectionResult;

      switch (detector) {
        case "ruleDetector":
          result = detectByRules(context, config);
          break;
        case "localModelDetector":
          result = await detectByLocalModel(context, config);
          break;
        default:
          console.warn(`[ClawXrouter] Unknown detector type: ${detector}`);
          continue;
      }

      results.push(result);

      if (result.level === "S3") break;
    } catch (err) {
      console.error(`[ClawXrouter] Detector ${detector} failed:`, err);
    }
  }

  return results;
}

/**
 * Merge multiple detection results into a single result
 * Takes the highest severity level and combines reasons
 */
function mergeDetectionResults(results: DetectionResult[]): DetectionResult {
  if (results.length === 0) {
    return {
      level: "S1",
      levelNumeric: 1,
      reason: "No detection results",
      detectorType: "ruleDetector",
      confidence: 0,
    };
  }

  if (results.length === 1) {
    return results[0];
  }

  // Find the highest level
  const levels = results.map((r) => r.level);
  const finalLevel = maxLevel(...levels);

  // Collect reasons from all detectors that contributed to the decision
  const relevantResults = results.filter((r) => r.level === finalLevel);
  const reasons = relevantResults.map((r) => r.reason).filter((r): r is string => Boolean(r));

  // Calculate average confidence
  const confidences = results.map((r) => r.confidence ?? 0.5);
  const avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;

  // Determine primary detector type (the one that found the highest level)
  const primaryDetector = relevantResults[0]?.detectorType ?? "ruleDetector";

  return {
    level: finalLevel,
    levelNumeric: results.find((r) => r.level === finalLevel)?.levelNumeric ?? 1,
    reason: reasons.length > 0 ? reasons.join("; ") : undefined,
    detectorType: primaryDetector,
    confidence: avgConfidence,
  };
}

/**
 * Merge user config with defaults
 */
function mergeWithDefaults(userConfig: PrivacyConfig, defaults: PrivacyConfig): PrivacyConfig {
  return {
    enabled: userConfig.enabled ?? defaults.enabled,
    checkpoints: {
      onUserMessage: userConfig.checkpoints?.onUserMessage ?? defaults.checkpoints?.onUserMessage,
      onToolCallProposed:
        userConfig.checkpoints?.onToolCallProposed ?? defaults.checkpoints?.onToolCallProposed,
      onToolCallExecuted:
        userConfig.checkpoints?.onToolCallExecuted ?? defaults.checkpoints?.onToolCallExecuted,
    },
    rules: {
      keywords: {
        S2: userConfig.rules?.keywords?.S2 ?? defaults.rules?.keywords?.S2,
        S3: userConfig.rules?.keywords?.S3 ?? defaults.rules?.keywords?.S3,
      },
      patterns: {
        S2: userConfig.rules?.patterns?.S2 ?? defaults.rules?.patterns?.S2,
        S3: userConfig.rules?.patterns?.S3 ?? defaults.rules?.patterns?.S3,
      },
      tools: {
        S2: {
          tools: userConfig.rules?.tools?.S2?.tools ?? defaults.rules?.tools?.S2?.tools,
          paths: userConfig.rules?.tools?.S2?.paths ?? defaults.rules?.tools?.S2?.paths,
        },
        S3: {
          tools: userConfig.rules?.tools?.S3?.tools ?? defaults.rules?.tools?.S3?.tools,
          paths: userConfig.rules?.tools?.S3?.paths ?? defaults.rules?.tools?.S3?.paths,
        },
      },
    },
    localModel: {
      enabled: userConfig.localModel?.enabled ?? defaults.localModel?.enabled,
      type: userConfig.localModel?.type ?? defaults.localModel?.type,
      provider: userConfig.localModel?.provider ?? defaults.localModel?.provider,
      model: userConfig.localModel?.model ?? defaults.localModel?.model,
      endpoint: userConfig.localModel?.endpoint ?? defaults.localModel?.endpoint,
      apiKey: userConfig.localModel?.apiKey ?? defaults.localModel?.apiKey,
      module: userConfig.localModel?.module ?? defaults.localModel?.module,
    },
    guardAgent: {
      id: userConfig.guardAgent?.id ?? defaults.guardAgent?.id,
      workspace: userConfig.guardAgent?.workspace ?? defaults.guardAgent?.workspace,
      model: userConfig.guardAgent?.model ?? defaults.guardAgent?.model,
    },
    session: {
      isolateGuardHistory:
        userConfig.session?.isolateGuardHistory ?? defaults.session?.isolateGuardHistory,
      baseDir: userConfig.session?.baseDir ?? defaults.session?.baseDir,
      injectDualHistory:
        userConfig.session?.injectDualHistory ?? defaults.session?.injectDualHistory,
      historyLimit: userConfig.session?.historyLimit ?? defaults.session?.historyLimit,
    },
  };
}
