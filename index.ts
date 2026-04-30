import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { clawXrouterConfigSchema, defaultPrivacyConfig } from "./src/config-schema.js";
import { registerHooks } from "./src/hooks.js";
import { initLiveConfig, watchConfigFile } from "./src/live-config.js";
import {
  startPrivacyProxy,
  setDefaultProviderTarget,
  registerModelTarget,
} from "./src/privacy-proxy.js";
import type { ProxyHandle } from "./src/privacy-proxy.js";
import {
  clawXrouterPrivacyProvider,
  setActiveProxy,
  mirrorAllProviderModels,
  collectTierModelIds,
  ensureModelMirrored,
} from "./src/provider.js";
import { RouterPipeline, setGlobalPipeline } from "./src/router-pipeline.js";
import { privacyRouter } from "./src/routers/privacy.js";
import { tokenSaverRouter } from "./src/routers/token-saver.js";
import { initDashboard, statsHttpHandler } from "./src/stats-dashboard.js";
import { TokenStatsCollector, setGlobalCollector } from "./src/token-stats.js";
import type { PrivacyConfig, PipelineConfig, RouterRegistration } from "./src/types.js";
import { resolveDefaultBaseUrl } from "./src/utils.js";

const OPENCLAW_DIR = resolveStateDir(process.env);
const CLAWXROUTER_CONFIG_PATH = join(OPENCLAW_DIR, "clawxrouter.json");
const LEGACY_DASHBOARD_PATH = join(OPENCLAW_DIR, "clawxrouter-dashboard.json");

function loadClawXrouterConfigFile(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(CLAWXROUTER_CONFIG_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function loadLegacyDashboardOverrides(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(LEGACY_DASHBOARD_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function writeClawXrouterConfigFile(config: Record<string, unknown>): void {
  try {
    mkdirSync(OPENCLAW_DIR, { recursive: true });
    writeFileSync(CLAWXROUTER_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
}

function getPrivacyConfig(pluginConfig: Record<string, unknown> | undefined): PrivacyConfig {
  const userConfig = (pluginConfig?.privacy ?? {}) as PrivacyConfig;
  return { ...defaultPrivacyConfig, ...userConfig } as PrivacyConfig;
}

/**
 * Determine the API type to register for the clawxrouter-privacy provider.
 *
 * The proxy is a transparent HTTP relay, so we need the SDK to send requests
 * in a format that both the proxy can parse and the downstream provider accepts.
 *
 * - For Google-native APIs: use "openai-completions" since most Google gateways
 *   accept OpenAI format, and Google's native SDK may bypass the HTTP proxy.
 * - For Anthropic: use "anthropic-messages" so the SDK sends the right format
 *   and auth scheme. The proxy handles forwarding transparently.
 * - For everything else: use the original API type (usually "openai-completions").
 */

function resolveProxyApi(originalApi: string): string {
  const api = originalApi.toLowerCase();
  // Google native SDKs construct their own URLs and may bypass the HTTP proxy;
  // fall back to openai-completions which Google gateways typically accept.
  if (api.includes("google") || api.includes("gemini")) {
    return "openai-completions";
  }
  // Anthropic's native API is proxy-friendly (standard HTTP POST to /v1/messages)
  if (api === "anthropic-messages") {
    return "anthropic-messages";
  }
  return originalApi;
}

export default definePluginEntry({
  id: "ClawXRouter",
  name: "ClawXRouter",
  description:
    "Privacy-aware plugin with extensible router pipeline, guard agent, and built-in privacy proxy",
  configSchema: clawXrouterConfigSchema,

  register(api: OpenClawPluginApi) {
    if (api.registrationMode !== "full") {
      return;
    }

    // ── Resolve config: clawxrouter.json > (openclaw.json + legacy overrides) ──
    let resolvedPluginConfig: Record<string, unknown>;
    const fileConfig = loadClawXrouterConfigFile();
    if (fileConfig) {
      resolvedPluginConfig = fileConfig;
      api.logger.info("[ClawXrouter] Config loaded from clawxrouter.json");
    } else {
      // First run: generate clawxrouter.json from openclaw.json plugin config + defaults
      const userPrivacy = ((api.pluginConfig ?? {}) as Record<string, unknown>).privacy as
        | Record<string, unknown>
        | undefined;
      const legacyOverrides = loadLegacyDashboardOverrides();
      const mergedPrivacy = {
        ...defaultPrivacyConfig,
        ...(userPrivacy ?? {}),
        ...(legacyOverrides ?? {}),
      };
      if (legacyOverrides) {
        api.logger.info("[ClawXrouter] Migrated legacy clawxrouter-dashboard.json overrides");
      }
      resolvedPluginConfig = { privacy: mergedPrivacy };
      writeClawXrouterConfigFile(resolvedPluginConfig);
      api.logger.info("[ClawXrouter] Generated clawxrouter.json with full defaults");
    }

    const privacyConfig = getPrivacyConfig(resolvedPluginConfig);

    if (privacyConfig.enabled === false) {
      api.logger.info("[ClawXrouter] Plugin disabled via config");
      return;
    }

    api.registerProvider(clawXrouterPrivacyProvider as Parameters<typeof api.registerProvider>[0]);

    const proxyPort = privacyConfig.proxyPort ?? 8403;
    if (!api.config.models) {
      (api.config as Record<string, unknown>).models = { providers: {} };
    }
    const models = api.config.models as { providers?: Record<string, unknown> };
    if (!models.providers) models.providers = {};

    // Detect the default provider's API type so the proxy can adapt
    const agentDefaults = (api.config.agents as Record<string, unknown> | undefined)?.defaults as
      | Record<string, unknown>
      | undefined;
    const primaryModelStr =
      ((agentDefaults?.model as Record<string, unknown> | undefined)?.primary as string) ?? "";
    const defaultProvider =
      (agentDefaults?.provider as string) || primaryModelStr.split("/")[0] || "openai";
    const providerConfig = models.providers?.[defaultProvider] as
      | Record<string, unknown>
      | undefined;
    const originalApi = (providerConfig?.api as string) ?? "openai-completions";

    // Use openai-completions for the proxy provider: the proxy acts as a transparent
    // HTTP relay and most providers (including Google gateways) accept OpenAI format.
    // For Anthropic-native, we match the API so the SDK sends the right format.
    const proxyApi = resolveProxyApi(originalApi);

    // Phase 1a: mirror all models explicitly listed in provider configs
    const mirroredModels = mirrorAllProviderModels(
      api.config as { models?: { providers?: Record<string, { models?: unknown }> } },
    );

    // Phase 1b: also pre-register models referenced by router tier configs
    // (e.g. token-saver tiers) that may not appear in any provider's models list
    const tierModels = collectTierModelIds(resolvedPluginConfig);
    const mirroredIds = new Set(mirroredModels.map((m) => (m as Record<string, unknown>).id));
    for (const { provider: tierProv, modelId: tierModel } of tierModels) {
      if (mirroredIds.has(tierModel)) continue;
      const tierProvConfig = models.providers?.[tierProv] as Record<string, unknown> | undefined;
      const tierProvModels = tierProvConfig?.models;
      let entry: Record<string, unknown> | undefined;
      if (Array.isArray(tierProvModels)) {
        const found = tierProvModels.find(
          (m: unknown) => (m as Record<string, unknown>).id === tierModel,
        );
        if (found) entry = { ...(found as Record<string, unknown>) };
      }
      if (!entry) {
        const firstModel =
          Array.isArray(tierProvModels) && tierProvModels.length > 0
            ? (tierProvModels[0] as Record<string, unknown>)
            : null;
        entry = {
          id: tierModel,
          name: tierModel,
          ...(firstModel?.contextWindow != null ? { contextWindow: firstModel.contextWindow } : {}),
          ...(firstModel?.maxTokens != null ? { maxTokens: firstModel.maxTokens } : {}),
        };
      }
      mirroredModels.push(entry);
      mirroredIds.add(tierModel);
      if (tierProvConfig) {
        registerModelTarget(tierModel, {
          baseUrl:
            (tierProvConfig.baseUrl as string) ??
            resolveDefaultBaseUrl(tierProv, tierProvConfig.api as string | undefined),
          apiKey: (tierProvConfig.apiKey as string) ?? "",
          provider: tierProv,
          api: tierProvConfig.api as string | undefined,
        });
      }
    }

    const privacyProviderEntry = {
      baseUrl: `http://127.0.0.1:${proxyPort}/v1`,
      api: proxyApi,
      apiKey: "clawxrouter-proxy-handles-auth",
      models: mirroredModels,
    };
    models.providers["clawxrouter-privacy"] = privacyProviderEntry;

    // Patch the runtime config snapshot (structuredClone of api.config) so
    // that model resolution inside the embedded agent runner can find the
    // clawxrouter-privacy virtual provider.
    const runtimeLoadConfig = (): Record<string, unknown> | undefined => {
      try {
        return api.runtime.config.loadConfig();
      } catch {
        return undefined;
      }
    };
    try {
      const runtimeCfg = runtimeLoadConfig();
      if (runtimeCfg && runtimeCfg !== api.config) {
        if (!runtimeCfg.models) {
          (runtimeCfg as Record<string, unknown>).models = { providers: {} };
        }
        const rtModels = runtimeCfg.models as { providers?: Record<string, unknown> };
        if (!rtModels.providers) rtModels.providers = {};
        rtModels.providers["clawxrouter-privacy"] = privacyProviderEntry;
      }
    } catch {
      // Non-fatal: runtime config patching is best-effort
    }

    // Propagate thinking + streaming defaults for all mirrored models.
    // Uses ensureModelMirrored's internal propagateThinkingForModel for
    // reasoning models; streaming propagation is handled separately below.
    for (const m of mirroredModels as Array<Record<string, unknown>>) {
      if (m.reasoning === true && typeof m.id === "string") {
        ensureModelMirrored(
          api.config as Record<string, unknown>,
          m.id as string,
          defaultProvider,
          runtimeLoadConfig,
        );
      }
    }

    // Propagate streaming=false for models that have it set in agent defaults
    const existingModelsOverrides =
      (agentDefaults?.models as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [key, override] of Object.entries(existingModelsOverrides)) {
      if (override?.streaming === false) {
        const modelId = key.includes("/") ? key.split("/").slice(1).join("/") : key;
        const proxyKey = `clawxrouter-privacy/${modelId}`;
        if (!existingModelsOverrides[proxyKey]) {
          existingModelsOverrides[proxyKey] = { streaming: false };
        }
      }
    }
    try {
      const runtimeCfg = runtimeLoadConfig();
      if (runtimeCfg) {
        const rtAgents = (runtimeCfg as Record<string, unknown>).agents as
          | Record<string, unknown>
          | undefined;
        const rtDefaults = rtAgents?.defaults as Record<string, unknown> | undefined;
        if (rtDefaults) {
          const rtModelsOverrides = (rtDefaults.models ?? {}) as Record<
            string,
            Record<string, unknown>
          >;
          for (const [key, override] of Object.entries(existingModelsOverrides)) {
            if (key.startsWith("clawxrouter-privacy/")) {
              rtModelsOverrides[key] = override;
            }
          }
          rtDefaults.models = rtModelsOverrides;
        }
      }
    } catch {
      // Non-fatal
    }

    // Set default provider target for the proxy
    if (providerConfig) {
      const defaultBaseUrl = resolveDefaultBaseUrl(defaultProvider, originalApi);
      const modelsOverrides =
        (agentDefaults?.models as Record<string, Record<string, unknown>> | undefined) ?? {};
      const modelStreamingPref = modelsOverrides[primaryModelStr]?.streaming;
      setDefaultProviderTarget({
        baseUrl: (providerConfig.baseUrl as string) ?? defaultBaseUrl,
        apiKey: (providerConfig.apiKey as string) ?? "",
        provider: defaultProvider,
        api: originalApi,
        ...(modelStreamingPref === false ? { streaming: false } : {}),
      });
    }

    api.logger.info(`[ClawXrouter] Privacy provider registered (proxy port: ${proxyPort})`);

    const patchExtraPaths = (cfg: Record<string, unknown>) => {
      const agts = (cfg.agents ?? {}) as Record<string, unknown>;
      const defs = (agts.defaults ?? {}) as Record<string, unknown>;
      const ms = (defs.memorySearch ?? {}) as Record<string, unknown>;
      const existing = (ms.extraPaths ?? []) as string[];
      const requiredPaths = ["MEMORY-FULL.md", "memory-full"];
      const missing = requiredPaths.filter((p) => !existing.includes(p));
      if (missing.length === 0) return false;
      const updated = [...existing, ...missing];
      if (!cfg.agents) cfg.agents = { defaults: {} };
      const a = cfg.agents as Record<string, unknown>;
      if (!a.defaults) a.defaults = {};
      const d = a.defaults as Record<string, unknown>;
      if (!d.memorySearch) d.memorySearch = {};
      (d.memorySearch as Record<string, unknown>).extraPaths = updated;
      return true;
    };
    if (patchExtraPaths(api.config as Record<string, unknown>)) {
      api.logger.info(
        `[ClawXrouter] Added to memorySearch.extraPaths: MEMORY-FULL.md, memory-full`,
      );
    }
    try {
      const runtimeCfg = api.runtime.config.loadConfig();
      if (runtimeCfg && runtimeCfg !== api.config) {
        patchExtraPaths(runtimeCfg as Record<string, unknown>);
      }
    } catch {
      /* best-effort */
    }

    let proxyHandle: ProxyHandle | null = null;
    api.registerService({
      id: "clawxrouter-proxy",
      start: async () => {
        try {
          proxyHandle = await startPrivacyProxy(proxyPort, api.logger);
          setActiveProxy(proxyHandle);
          api.logger.info(`[ClawXrouter] Privacy proxy started on port ${proxyPort}`);
        } catch (err) {
          api.logger.error(`[ClawXrouter] Failed to start privacy proxy: ${String(err)}`);
        }
      },
      stop: async () => {
        if (proxyHandle) {
          try {
            await proxyHandle.close();
            api.logger.info("[ClawXrouter] Privacy proxy stopped");
          } catch (err) {
            api.logger.warn(`[ClawXrouter] Failed to close proxy: ${String(err)}`);
          }
        }
      },
    });

    const pipeline = new RouterPipeline(api.logger);

    // Register built-in routers
    const routerConfigs = (privacyConfig as Record<string, unknown>).routers as
      | Record<string, RouterRegistration>
      | undefined;
    pipeline.register(privacyRouter, routerConfigs?.privacy ?? { enabled: true, type: "builtin" });
    pipeline.register(
      tokenSaverRouter,
      routerConfigs?.["token-saver"] ?? { enabled: false, type: "builtin" },
    );

    // Configure pipeline from user config
    pipeline.configure({
      routers: routerConfigs,
      pipeline: (privacyConfig as Record<string, unknown>).pipeline as PipelineConfig | undefined,
    });

    // Load custom routers (async, non-blocking)
    pipeline
      .loadCustomRouters()
      .then(() => {
        const routers = pipeline.listRouters();
        if (routers.length > 1) {
          api.logger.info(`[ClawXrouter] Pipeline routers: ${routers.join(", ")}`);
        }
      })
      .catch((err) => {
        api.logger.error(`[ClawXrouter] Failed to load custom routers: ${String(err)}`);
      });

    setGlobalPipeline(pipeline);
    api.logger.info(`[ClawXrouter] Router pipeline initialized (built-in: privacy)`);

    initLiveConfig(resolvedPluginConfig);
    watchConfigFile(CLAWXROUTER_CONFIG_PATH, api.logger);

    const statsPath = join(OPENCLAW_DIR, "clawxrouter-stats.json");
    const collector = new TokenStatsCollector(statsPath);
    setGlobalCollector(collector);
    collector
      .load()
      .then(() => {
        collector.startAutoFlush();
        api.logger.info(`[ClawXrouter] Token stats initialized (${statsPath})`);
      })
      .catch((err) => {
        api.logger.error(`[ClawXrouter] Failed to load token stats: ${String(err)}`);
      });

    initDashboard({
      pluginId: "clawxrouter",
      pluginConfig: resolvedPluginConfig,
      pipeline,
    });

    api.registerHttpRoute({
      path: "/plugins/clawxrouter/stats",
      auth: "plugin",
      match: "prefix",
      handler: async (req, res) => {
        const handled = await statsHttpHandler(req, res);
        if (!handled) {
          res.writeHead(404);
          res.end("Not Found");
        }
      },
    });

    api.logger.info("[ClawXrouter] Dashboard registered at /plugins/clawxrouter/stats");

    registerHooks(api);

    api.logger.info(
      "[ClawXrouter] Plugin initialized (pipeline + privacy proxy + guard agent + dashboard)",
    );

    const c = "\x1b[36m",
      g = "\x1b[32m",
      y = "\x1b[33m",
      b = "\x1b[1m",
      d = "\x1b[2m",
      r = "\x1b[0m",
      bg = "\x1b[46m\x1b[30m";
    const W = 70;
    const bar = "═".repeat(W);
    const pad = (colored: string, visLen: number) => {
      const sp = " ".repeat(Math.max(0, W - visLen));
      return `${c}  ║${r}${colored}${sp}${c}║${r}`;
    };

    api.logger.info("");
    api.logger.info(`${c}  ╔${bar}╗${r}`);
    api.logger.info(pad(`  ${bg}${b} 🛡️  ClawXrouter ${r}${g}${b}  Ready!${r}`, 25));
    api.logger.info(pad("", 0));
    const gwPort =
      ((api.config as Record<string, unknown>).gateway &&
        ((api.config as Record<string, unknown>).gateway as Record<string, unknown>).port) ||
      18789;
    api.logger.info(
      pad(
        `  ${y}Dashboard${r} ${d}→${r}  ${b}http://127.0.0.1:${gwPort}/plugins/clawxrouter/stats${r}`,
        62,
      ),
    );
    api.logger.info(pad(`  ${y}Config${r}    ${d}→${r}  ${b}${CLAWXROUTER_CONFIG_PATH}${r}`, 40));
    api.logger.info(pad("", 0));
    api.logger.info(pad(`  ${d}Use the Dashboard to configure routers, rules & prompts.${r}`, 58));
    api.logger.info(`${c}  ╚${bar}╝${r}`);
    api.logger.info("");
  },
});
