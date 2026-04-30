import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const OPENCLAW_DIR = resolveStateDir(process.env);

export const CLAWXROUTER_CONFIG_PATH = join(OPENCLAW_DIR, "clawxrouter.json");

export function saveClawXrouterConfig(privacy: Record<string, unknown>): void {
  try {
    mkdirSync(OPENCLAW_DIR, { recursive: true });
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(CLAWXROUTER_CONFIG_PATH, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      /* file may not exist yet */
    }
    const updated = { ...existing, privacy };
    writeFileSync(CLAWXROUTER_CONFIG_PATH, JSON.stringify(updated, null, 2), "utf-8");
  } catch {
    // best-effort persistence
  }
}
