import { readFileSync, watch, type FSWatcher } from "node:fs";
import { defaultPrivacyConfig } from "./config-schema.js";
import type { PrivacyConfig } from "./types.js";

let liveConfig: PrivacyConfig = { ...defaultPrivacyConfig } as PrivacyConfig;
let configWatcher: FSWatcher | null = null;

/** Initialize live config from the plugin's startup config snapshot. */
export function initLiveConfig(pluginConfig: Record<string, unknown> | undefined): void {
  const userConfig = (pluginConfig?.privacy ?? {}) as PrivacyConfig;
  liveConfig = mergeConfig(userConfig);
}

/**
 * Watch clawxrouter.json for external edits and hot-reload into liveConfig.
 * Uses a debounce to avoid reloading multiple times on rapid writes.
 */
export function watchConfigFile(configPath: string, logger: { info: (msg: string) => void }): void {
  if (configWatcher) return;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  try {
    configWatcher = watch(configPath, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        try {
          const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
          const privacy = (raw.privacy ?? {}) as PrivacyConfig;
          liveConfig = mergeConfig(privacy);
          logger.info("[ClawXrouter] clawxrouter.json changed — config hot-reloaded");
        } catch {
          /* ignore parse errors from partial writes */
        }
      }, 300);
    });
  } catch {
    /* file may not exist yet — non-fatal */
  }
}

/** Get the current live config (mutable, always up-to-date). */
export function getLiveConfig(): PrivacyConfig {
  return liveConfig;
}

/** Hot-update the live config. Called from Dashboard save handler. */
export function updateLiveConfig(patch: Partial<PrivacyConfig>): void {
  liveConfig = mergeConfig({ ...liveConfig, ...patch });
}

function mergeConfig(userConfig: PrivacyConfig): PrivacyConfig {
  return {
    ...defaultPrivacyConfig,
    ...userConfig,
    checkpoints: { ...defaultPrivacyConfig.checkpoints, ...userConfig.checkpoints },
    rules: {
      keywords: { ...defaultPrivacyConfig.rules?.keywords, ...userConfig.rules?.keywords },
      patterns: { ...defaultPrivacyConfig.rules?.patterns, ...userConfig.rules?.patterns },
      tools: {
        S2: { ...defaultPrivacyConfig.rules?.tools?.S2, ...userConfig.rules?.tools?.S2 },
        S3: { ...defaultPrivacyConfig.rules?.tools?.S3, ...userConfig.rules?.tools?.S3 },
      },
    },
    localModel: { ...defaultPrivacyConfig.localModel, ...userConfig.localModel },
    guardAgent: { ...defaultPrivacyConfig.guardAgent, ...userConfig.guardAgent },
    session: { ...defaultPrivacyConfig.session, ...userConfig.session },
    localProviders: [...defaultPrivacyConfig.localProviders, ...(userConfig.localProviders ?? [])],
    modelPricing: {
      ...defaultPrivacyConfig.modelPricing,
      ...userConfig.modelPricing,
    },
    redaction: { ...defaultPrivacyConfig.redaction, ...userConfig.redaction },
  } as PrivacyConfig;
}
