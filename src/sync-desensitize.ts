/**
 * Synchronous wrapper around the async LLM desensitization function.
 *
 * Uses `synckit` (Worker thread + Atomics.wait) to run `desensitizeWithLocalModel`
 * synchronously so that the `tool_result_persist` hook (sync-only) can desensitize
 * S2 tool results before they enter the persisted transcript.
 *
 * Timeout (45s) gracefully falls back to a failed result, leaving the caller
 * to decide whether to pass content through or apply regex-only redaction.
 */

import { fileURLToPath } from "node:url";
import { createSyncFn } from "synckit";
import type { PrivacyConfig } from "./types.js";

export type SyncDesensitizeResult = {
  desensitized: string;
  wasModelUsed: boolean;
  failed?: boolean;
};

const workerPath = fileURLToPath(new URL("./llm-desensitize-worker.ts", import.meta.url));
const loaderPath = fileURLToPath(new URL("./worker-loader.mjs", import.meta.url));

let _syncDesensitize:
  | ((content: string, config: PrivacyConfig, sessionKey?: string) => SyncDesensitizeResult)
  | null = null;

function getSyncDesensitize() {
  if (!_syncDesensitize) {
    _syncDesensitize = createSyncFn<
      (content: string, config: PrivacyConfig, sessionKey?: string) => SyncDesensitizeResult
    >(workerPath, { timeout: 45_000, execArgv: ["--import", loaderPath] });
  }
  return _syncDesensitize;
}

export function syncDesensitizeWithLocalModel(
  content: string,
  config: PrivacyConfig,
  sessionKey?: string,
): SyncDesensitizeResult {
  try {
    return getSyncDesensitize()(content, config, sessionKey);
  } catch (err) {
    console.warn(
      "[ClawXrouter] syncDesensitize fallback to failed:",
      (err as Error)?.message?.slice(0, 120),
    );
    return { desensitized: content, wasModelUsed: false, failed: true };
  }
}
