import type { ProxyHandle } from "./privacy-proxy.js";
import { registerModelTarget, type OriginalProviderTarget } from "./privacy-proxy.js";
import { resolveDefaultBaseUrl } from "./utils.js";

let activeProxy: ProxyHandle | null = null;

export function setActiveProxy(proxy: ProxyHandle): void {
  activeProxy = proxy;
}

export const clawXrouterPrivacyProvider = {
  id: "clawxrouter-privacy",
  label: "ClawXrouter Privacy Proxy",
  aliases: [] as string[],
  envVars: [] as string[],
  auth: [] as never[],
};

// ---------------------------------------------------------------------------
// Phase 1: Init-time model collection
// ---------------------------------------------------------------------------

/**
 * Mirror all model definitions from every configured provider and
 * build the model→target map for proxy routing.
 */
export function mirrorAllProviderModels(config: {
  models?: {
    providers?: Record<
      string,
      { models?: unknown; baseUrl?: string; apiKey?: string; api?: string }
    >;
  };
}): unknown[] {
  const seen = new Set<string>();
  const mirrored: unknown[] = [];
  const providers = config.models?.providers ?? {};

  for (const [provName, provCfg] of Object.entries(providers)) {
    if (provName === "clawxrouter-privacy") continue;
    if (!provCfg.models) continue;

    const target: OriginalProviderTarget = {
      baseUrl: provCfg.baseUrl ?? resolveDefaultBaseUrl(provName, provCfg.api),
      apiKey: provCfg.apiKey ?? "",
      provider: provName,
      api: provCfg.api,
    };

    const models = provCfg.models;
    if (Array.isArray(models)) {
      for (const m of models) {
        const id = (m as Record<string, unknown>)?.id as string | undefined;
        if (id && !seen.has(id)) {
          seen.add(id);
          mirrored.push(m);
          registerModelTarget(id, target);
        }
      }
    } else if (typeof models === "object" && models !== null) {
      for (const [modelId, modelDef] of Object.entries(models as Record<string, unknown>)) {
        if (!seen.has(modelId)) {
          seen.add(modelId);
          mirrored.push({
            id: modelId,
            ...(typeof modelDef === "object" && modelDef !== null
              ? (modelDef as Record<string, unknown>)
              : {}),
          });
          registerModelTarget(modelId, target);
        }
      }
    }
  }

  return mirrored;
}

/**
 * Scan router tier configs for model IDs that may not be in any provider's
 * explicit model list.  Returns { provider, modelId } pairs.
 */
export function collectTierModelIds(
  pluginConfig: Record<string, unknown>,
): Array<{ provider: string; modelId: string }> {
  const privacy = (pluginConfig?.privacy ?? {}) as Record<string, unknown>;
  const routers = (privacy.routers ?? {}) as Record<
    string,
    { options?: { tiers?: Record<string, { provider?: string; model?: string }> } }
  >;
  const result: Array<{ provider: string; modelId: string }> = [];

  for (const reg of Object.values(routers)) {
    const tiers = reg.options?.tiers;
    if (!tiers) continue;
    for (const tier of Object.values(tiers)) {
      if (tier.provider && tier.model) {
        result.push({ provider: tier.provider, modelId: tier.model });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Phase 2: JIT (runtime) model registration
// ---------------------------------------------------------------------------

type ProviderCfg = Record<string, unknown> & {
  models?: Array<Record<string, unknown>>;
};

/**
 * Look up a model definition across all configured providers (excluding
 * clawxrouter-privacy).  Returns the full model object if found, null otherwise.
 */
function findModelInProviders(
  providers: Record<string, ProviderCfg>,
  modelId: string,
  preferProvider?: string,
): Record<string, unknown> | null {
  const order = preferProvider
    ? [
        preferProvider,
        ...Object.keys(providers).filter(
          (p) => p !== preferProvider && p !== "clawxrouter-privacy",
        ),
      ]
    : Object.keys(providers).filter((p) => p !== "clawxrouter-privacy");

  for (const provName of order) {
    const provModels = providers[provName]?.models;
    if (!Array.isArray(provModels)) continue;
    const found = provModels.find((m) => (m as Record<string, unknown>).id === modelId);
    if (found) return { ...(found as Record<string, unknown>) };
  }
  return null;
}

/**
 * Build a minimal model entry that matches OpenClaw's resolveModelWithRegistry
 * fallback for the given provider.  This ensures contextWindow / maxTokens /
 * reasoning align with what the model would get if routed directly.
 */
function buildFallbackModelEntry(
  providers: Record<string, ProviderCfg>,
  modelId: string,
  originalProvider: string,
): Record<string, unknown> {
  const origModels = providers[originalProvider]?.models;
  const firstModel =
    Array.isArray(origModels) && origModels.length > 0
      ? (origModels[0] as Record<string, unknown>)
      : null;
  return {
    id: modelId,
    name: modelId,
    ...(firstModel?.contextWindow != null ? { contextWindow: firstModel.contextWindow } : {}),
    ...(firstModel?.maxTokens != null ? { maxTokens: firstModel.maxTokens } : {}),
  };
}

/**
 * Ensure `modelId` is registered under the clawxrouter-privacy provider.
 *
 * Called at decision time (JIT) so that models selected by token-saver or
 * other routers — which may not have been in the init snapshot — are available
 * with correct properties before OpenClaw's resolveModel runs.
 *
 * Also propagates reasoning/thinking defaults into agents.defaults.models so
 * thinking-model output isn't stripped.
 */
export function ensureModelMirrored(
  config: Record<string, unknown>,
  modelId: string,
  originalProvider: string,
  runtimeLoadConfig?: () => Record<string, unknown> | undefined,
): void {
  const providers = (
    config as Record<string, unknown> & { models?: { providers?: Record<string, ProviderCfg> } }
  ).models?.providers;
  if (!providers?.["clawxrouter-privacy"]) return;

  const privacyModels = providers["clawxrouter-privacy"].models;
  if (!Array.isArray(privacyModels)) return;

  const alreadyMirrored = privacyModels.some((m) => (m as Record<string, unknown>).id === modelId);

  let source: Record<string, unknown>;
  if (alreadyMirrored) {
    source = privacyModels.find((m) => (m as Record<string, unknown>).id === modelId) as Record<
      string,
      unknown
    >;
  } else {
    source =
      findModelInProviders(providers, modelId, originalProvider) ??
      buildFallbackModelEntry(providers, modelId, originalProvider);
    privacyModels.push(source);
  }

  // Register model→provider target for proxy routing (idempotent)
  const provCfg = providers[originalProvider];
  if (provCfg) {
    registerModelTarget(modelId, {
      baseUrl:
        ((provCfg as Record<string, unknown>).baseUrl as string) ??
        resolveDefaultBaseUrl(
          originalProvider,
          (provCfg as Record<string, unknown>).api as string | undefined,
        ),
      apiKey: ((provCfg as Record<string, unknown>).apiKey as string) ?? "",
      provider: originalProvider,
      api: (provCfg as Record<string, unknown>).api as string | undefined,
    });
  }

  if (source.reasoning === true) {
    propagateThinkingForModel(config, modelId);
  }

  // Patch the runtime config snapshot (structuredClone of api.config)
  if (runtimeLoadConfig) {
    try {
      const rtCfg = runtimeLoadConfig();
      if (rtCfg) {
        if (!alreadyMirrored) {
          const rtProviders = (
            rtCfg as Record<string, unknown> & {
              models?: { providers?: Record<string, ProviderCfg> };
            }
          ).models?.providers;
          const rtModels = rtProviders?.["clawxrouter-privacy"]?.models;
          if (
            Array.isArray(rtModels) &&
            !rtModels.some((m) => (m as Record<string, unknown>).id === modelId)
          ) {
            rtModels.push(source);
          }
        }
        if (source.reasoning === true) {
          propagateThinkingForModel(rtCfg, modelId);
        }
      }
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Set `params.thinking: "low"` for a clawxrouter-privacy model so the agent SDK
 * enables thinking mode for reasoning models routed through the proxy.
 */
function propagateThinkingForModel(config: Record<string, unknown>, modelId: string): void {
  const agents = (config as Record<string, unknown> & { agents?: Record<string, unknown> }).agents;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  if (!defaults) return;
  if (!defaults.models) defaults.models = {};
  const modelsOverrides = defaults.models as Record<string, Record<string, unknown>>;
  const proxyKey = `clawxrouter-privacy/${modelId}`;
  const existing = modelsOverrides[proxyKey] ?? {};
  if (!existing.params || !(existing.params as Record<string, unknown>).thinking) {
    modelsOverrides[proxyKey] = {
      ...existing,
      params: { ...((existing.params as Record<string, unknown>) ?? {}), thinking: "low" },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers for hooks.ts: resolve original provider for a model
// ---------------------------------------------------------------------------

/**
 * Given a model ID selected by the pipeline (e.g. from token-saver), find
 * which real provider owns it.  Returns the provider name, or the supplied
 * fallback if no explicit match is found.
 */
export function resolveOriginalProvider(
  config: Record<string, unknown>,
  modelId: string,
  fallbackProvider: string,
): string {
  const providers =
    (config as Record<string, unknown> & { models?: { providers?: Record<string, ProviderCfg> } })
      .models?.providers ?? {};

  for (const [provName, provCfg] of Object.entries(providers)) {
    if (provName === "clawxrouter-privacy") continue;
    const provModels = provCfg.models;
    if (!Array.isArray(provModels)) continue;
    if (provModels.some((m) => (m as Record<string, unknown>).id === modelId)) {
      return provName;
    }
  }
  return fallbackProvider;
}
