import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { PrivacyConfig, SensitivityLevel } from "./types.js";

/**
 * Check if guard agent is properly configured
 */
export function isGuardAgentConfigured(config: PrivacyConfig): boolean {
  return Boolean(config.guardAgent?.id && config.guardAgent?.model && config.guardAgent?.workspace);
}

/**
 * Get guard agent configuration (returns null if not fully configured).
 *
 * The model field uses "provider/model" format (e.g. "ollama/llama3.2:3b", "vllm/qwen2.5:7b").
 * When no slash is present, the provider is inferred from localModel.provider config,
 * falling back to "ollama" only if nothing else is configured.
 */
export function getGuardAgentConfig(config: PrivacyConfig): {
  id: string;
  model: string;
  workspace: string;
  provider: string;
  modelName: string;
} | null {
  if (!isGuardAgentConfigured(config)) {
    return null;
  }

  const fullModel = config.guardAgent?.model ?? "ollama/openbmb/minicpm4.1";
  const firstSlash = fullModel.indexOf("/");
  const defaultProvider = config.localModel?.provider ?? "ollama";
  const [provider, modelName] =
    firstSlash >= 0
      ? [fullModel.slice(0, firstSlash), fullModel.slice(firstSlash + 1)]
      : [defaultProvider, fullModel];

  return {
    id: config.guardAgent?.id ?? "guard",
    model: fullModel,
    workspace:
      config.guardAgent?.workspace ?? path.join(resolveStateDir(process.env), "workspace-guard"),
    provider,
    modelName,
  };
}

/**
 * Check if a session key belongs to a guard subsession
 */
export function isGuardSessionKey(sessionKey: string): boolean {
  return sessionKey.endsWith(":guard") || sessionKey.includes(":guard:");
}

/**
 * Build a placeholder message to insert into the main (cloud-visible) session history
 * when a message is redirected to the guard subsession.
 *
 * This ensures the cloud model never sees the actual sensitive content,
 * but knows that something was handled privately.
 */
export function buildMainSessionPlaceholder(
  level: SensitivityLevel,
  reason?: string,
  timestamp?: number,
): string {
  const emoji = level === "S3" ? "🔒" : "🔑";
  const levelLabel = level === "S3" ? "Private" : "Sensitive";
  const reasonSuffix = reason ? ` (${reason})` : "";
  const tsSuffix = timestamp ? ` [ts=${new Date(timestamp).toISOString()}]` : "";
  return `${emoji} [${levelLabel} message — processed locally${reasonSuffix}]${tsSuffix}`;
}

const BUILTIN_LOCAL_PROVIDERS = [
  "ollama",
  "llama.cpp",
  "localai",
  "llamafile",
  "lmstudio",
  "vllm",
  "mlx",
  "sglang",
  "tgi",
  "koboldcpp",
  "tabbyapi",
  "nitro",
];

/**
 * Validate that a model reference is local-only (not a cloud provider).
 * Used to enforce the constraint that guard sessions only use local models.
 *
 * Checks against built-in list + any extra providers from config.localProviders.
 */
export function isLocalProvider(provider: string, extraProviders?: string[]): boolean {
  const lower = provider.toLowerCase();
  if (BUILTIN_LOCAL_PROVIDERS.includes(lower)) return true;
  if (extraProviders?.some((p) => p.toLowerCase() === lower)) return true;
  return false;
}
