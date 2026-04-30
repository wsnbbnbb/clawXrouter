import * as fs from "node:fs";
import * as path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { desensitizeWithLocalModel } from "./local-model.js";
import type { PrivacyConfig } from "./types.js";
import { redactSensitiveInfo } from "./utils.js";

export const GUARD_SECTION_BEGIN = "<!-- clawxrouter:guard-begin -->";
export const GUARD_SECTION_END = "<!-- clawxrouter:guard-end -->";

export class MemoryIsolationManager {
  private workspaceDir: string;

  constructor(workspaceDir?: string) {
    const resolved = workspaceDir ?? path.join(resolveStateDir(process.env), "workspace-main");
    // Expand ~ to home directory for explicitly-passed user paths
    this.workspaceDir = resolved.startsWith("~")
      ? path.join(process.env.HOME || process.env.USERPROFILE || "~", resolved.slice(2))
      : resolved;
  }

  /**
   * Get memory directory path based on model type and content type
   */
  getMemoryDir(isCloudModel: boolean): string {
    const memoryType = isCloudModel ? "memory" : "memory-full";
    return path.join(this.workspaceDir, memoryType);
  }

  /**
   * Get MEMORY.md path based on model type
   */
  getMemoryFilePath(isCloudModel: boolean): string {
    if (isCloudModel) {
      // Cloud models use the standard MEMORY.md
      return path.join(this.workspaceDir, "MEMORY.md");
    } else {
      // Local models can access the full memory
      return path.join(this.workspaceDir, "MEMORY-FULL.md");
    }
  }

  /**
   * Get daily memory file path
   */
  getDailyMemoryPath(isCloudModel: boolean, date?: Date): string {
    const memoryDir = this.getMemoryDir(isCloudModel);
    const today = date ?? new Date();
    const dateStr = today.toISOString().split("T")[0]; // YYYY-MM-DD
    return path.join(memoryDir, `${dateStr}.md`);
  }

  /**
   * Write to memory file
   */
  async writeMemory(
    content: string,
    isCloudModel: boolean,
    options?: { append?: boolean; daily?: boolean },
  ): Promise<void> {
    try {
      const filePath = options?.daily
        ? this.getDailyMemoryPath(isCloudModel)
        : this.getMemoryFilePath(isCloudModel);

      // Ensure directory exists
      const dir = path.dirname(filePath);
      await fs.promises.mkdir(dir, { recursive: true });

      // Write or append
      if (options?.append) {
        await fs.promises.appendFile(filePath, content, "utf-8");
      } else {
        await fs.promises.writeFile(filePath, content, "utf-8");
      }
    } catch (err) {
      console.error(`[ClawXrouter] Failed to write memory (cloud=${isCloudModel}):`, err);
    }
  }

  /**
   * Read from memory file
   */
  async readMemory(
    isCloudModel: boolean,
    options?: { daily?: boolean; date?: Date },
  ): Promise<string> {
    try {
      const filePath = options?.daily
        ? this.getDailyMemoryPath(isCloudModel, options.date)
        : this.getMemoryFilePath(isCloudModel);

      if (!fs.existsSync(filePath)) {
        return "";
      }

      return await fs.promises.readFile(filePath, "utf-8");
    } catch (err) {
      console.error(`[ClawXrouter] Failed to read memory (cloud=${isCloudModel}):`, err);
      return "";
    }
  }

  /**
   * Merge clean memory content into full memory so FULL is always the superset.
   * Cloud models write to MEMORY.md; this step captures those additions into
   * MEMORY-FULL.md before we sanitize back. Lines already present in FULL
   * (by trimmed content) are skipped to avoid duplicates.
   */
  async mergeCleanIntoFull(options?: { daily?: boolean; date?: Date }): Promise<number> {
    try {
      const cleanContent = await this.readMemory(true, options);
      const fullContent = await this.readMemory(false, options);

      if (!cleanContent.trim()) {
        return 0;
      }

      // Build a set of trimmed lines already in FULL for dedup
      const fullLines = new Set(
        fullContent
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      );

      // Find lines in CLEAN that don't exist in FULL
      // Skip [REDACTED:...] tags — those are artifacts of previous sync, not real content
      const newLines: string[] = [];
      for (const line of cleanContent.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !fullLines.has(trimmed) && !trimmed.includes("[REDACTED:")) {
          newLines.push(line);
        }
      }

      if (newLines.length === 0) {
        return 0;
      }

      // Append new lines to FULL under a merged section
      const appendBlock = `\n\n## Cloud Session Additions\n${newLines.join("\n")}\n`;
      await this.writeMemory(fullContent + appendBlock, false, options);
      console.log(`[ClawXrouter] Merged ${newLines.length} line(s) from clean → full`);
      return newLines.length;
    } catch (err) {
      console.error("[ClawXrouter] Failed to merge clean into full:", err);
      return 0;
    }
  }

  /**
   * Sync memory from full to clean (removing guard agent content + redacting PII).
   *
   * Flow:
   *   1. Merge MEMORY.md → MEMORY-FULL.md (capture cloud model additions)
   *   2. Filter guard agent sections from MEMORY-FULL.md
   *   3. Redact PII (local model → regex fallback)
   *   4. Write result to MEMORY.md
   *
   * @param privacyConfig - When provided, PII redaction uses the local model
   *   (same `desensitizeWithLocalModel` pipeline as real-time S2 messages).
   *   If the model is unavailable or config is omitted, falls back to
   *   rule-based `redactSensitiveInfo()`.
   */
  async syncMemoryToClean(privacyConfig?: PrivacyConfig): Promise<void> {
    try {
      // Step 0: Merge cloud additions into FULL so nothing is lost
      await this.mergeCleanIntoFull();

      // Read full memory (now includes any cloud additions)
      const fullMemory = await this.readMemory(false);

      if (!fullMemory) {
        return;
      }

      // Phase 1: Filter out guard agent related sections
      const guardStripped = this.filterGuardContent(fullMemory);

      // Phase 2: Redact PII — prefer local model, fall back to regex rules
      const cleanMemory = await this.redactContent(guardStripped, privacyConfig);

      // Write to clean memory
      await this.writeMemory(cleanMemory, true);

      console.log("[ClawXrouter] MEMORY-FULL.md synced to MEMORY.md");
    } catch (err) {
      console.error("[ClawXrouter] Failed to sync memory:", err);
    }
  }

  /**
   * Sync ALL daily memory files from memory-full/ → memory/
   * Each file goes through: merge clean→full, guard-strip, PII-redact.
   */
  async syncDailyMemoryToClean(privacyConfig?: PrivacyConfig): Promise<number> {
    let synced = 0;
    try {
      const fullDir = this.getMemoryDir(false); // memory-full/
      const cleanDir = this.getMemoryDir(true); // memory/

      if (!fs.existsSync(fullDir)) {
        return 0;
      }

      await fs.promises.mkdir(cleanDir, { recursive: true });

      // Collect all daily .md files from BOTH directories (cloud may have files full doesn't)
      const fullFiles = fs.existsSync(fullDir)
        ? (await fs.promises.readdir(fullDir)).filter((f) => f.endsWith(".md"))
        : [];
      const cleanFiles = fs.existsSync(cleanDir)
        ? (await fs.promises.readdir(cleanDir)).filter((f) => f.endsWith(".md"))
        : [];
      const allFiles = [...new Set([...fullFiles, ...cleanFiles])];

      for (const file of allFiles) {
        try {
          const fullPath = path.join(fullDir, file);
          const cleanPath = path.join(cleanDir, file);

          // Step 0: Merge cloud daily additions into full daily (by filepath, no Date needed)
          await this.mergeDailyFile(fullPath, cleanPath);

          // Re-read full content (now includes merged cloud additions)
          const fullContent = fs.existsSync(fullPath)
            ? await fs.promises.readFile(fullPath, "utf-8")
            : "";

          if (!fullContent.trim()) {
            continue;
          }

          // Phase 1: strip guard content
          const guardStripped = this.filterGuardContent(fullContent);

          // Phase 2: PII redaction
          const cleanContent = await this.redactContent(guardStripped, privacyConfig);

          await fs.promises.writeFile(cleanPath, cleanContent, "utf-8");
          synced++;
        } catch (fileErr) {
          console.error(`[ClawXrouter] Failed to sync daily file ${file}:`, fileErr);
        }
      }

      if (synced > 0) {
        console.log(
          `[ClawXrouter] Synced ${synced} daily memory file(s) from memory-full/ → memory/`,
        );
      }
    } catch (err) {
      console.error("[ClawXrouter] Failed to sync daily memory:", err);
    }
    return synced;
  }

  /**
   * Sync everything: long-term memory + all daily files
   */
  async syncAllMemoryToClean(privacyConfig?: PrivacyConfig): Promise<void> {
    await this.syncMemoryToClean(privacyConfig);
    await this.syncDailyMemoryToClean(privacyConfig);
  }

  /**
   * PII redaction: prefer local model, fall back to regex.
   * Public alias for use by hooks that need redaction outside the sync flow.
   */
  async redactContentPublic(text: string, privacyConfig?: PrivacyConfig): Promise<string> {
    return this.redactContent(text, privacyConfig);
  }

  /**
   * Shared PII redaction: prefer local model, fall back to regex.
   */
  private async redactContent(text: string, privacyConfig?: PrivacyConfig): Promise<string> {
    const redactionOpts = privacyConfig?.redaction;
    if (privacyConfig) {
      const { desensitized, wasModelUsed } = await desensitizeWithLocalModel(text, privacyConfig);

      if (wasModelUsed && desensitized !== text) {
        console.log("[ClawXrouter] PII redacted via local model");
        return desensitized;
      }

      // Model unavailable or returned unchanged — fall back to regex
      console.log(
        `[ClawXrouter] PII redacted via rules (model ${wasModelUsed ? "returned unchanged" : "unavailable"})`,
      );
      return redactSensitiveInfo(text, redactionOpts);
    }

    console.log("[ClawXrouter] PII redacted via rules (no config)");
    return redactSensitiveInfo(text, redactionOpts);
  }

  /**
   * Merge a single daily clean file's unique lines into the corresponding full file.
   * Operates directly on file paths — no Date conversion needed, avoids timezone issues.
   */
  private async mergeDailyFile(fullPath: string, cleanPath: string): Promise<void> {
    try {
      if (!fs.existsSync(cleanPath)) {
        return;
      }

      const cleanContent = await fs.promises.readFile(cleanPath, "utf-8");
      if (!cleanContent.trim()) {
        return;
      }

      const fullContent = fs.existsSync(fullPath)
        ? await fs.promises.readFile(fullPath, "utf-8")
        : "";

      const fullLines = new Set(
        fullContent
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      );

      const newLines: string[] = [];
      for (const line of cleanContent.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !fullLines.has(trimmed) && !trimmed.includes("[REDACTED:")) {
          newLines.push(line);
        }
      }

      if (newLines.length === 0) {
        return;
      }

      // Ensure parent dir exists (in case full file doesn't exist yet)
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });

      const appendBlock = `\n\n## Cloud Session Additions\n${newLines.join("\n")}\n`;
      await fs.promises.writeFile(fullPath, fullContent + appendBlock, "utf-8");
      console.log(
        `[ClawXrouter] Merged ${newLines.length} daily line(s) from clean → full (${path.basename(fullPath)})`,
      );
    } catch (err) {
      console.error(`[ClawXrouter] Failed to merge daily file:`, err);
    }
  }

  /**
   * Filter guard agent content from memory text.
   * Uses explicit `GUARD_SECTION_BEGIN` / `GUARD_SECTION_END` HTML comment
   * markers to delimit guard-originated sections.  Falls back to the legacy
   * heuristic for content written before markers were introduced.
   */
  private filterGuardContent(content: string): string {
    const lines = content.split("\n");
    const filtered: string[] = [];
    let inGuardSection = false;

    for (const line of lines) {
      if (line.trim() === GUARD_SECTION_BEGIN) {
        inGuardSection = true;
        continue;
      }
      if (line.trim() === GUARD_SECTION_END) {
        inGuardSection = false;
        continue;
      }
      if (!inGuardSection) {
        filtered.push(line);
      }
    }

    return filtered.join("\n");
  }

  /**
   * Ensure both memory directories exist
   */
  async initializeDirectories(): Promise<void> {
    try {
      const fullDir = this.getMemoryDir(false);
      const cleanDir = this.getMemoryDir(true);

      await fs.promises.mkdir(fullDir, { recursive: true });
      await fs.promises.mkdir(cleanDir, { recursive: true });

      console.log("[ClawXrouter] Memory directories initialized");
    } catch (err) {
      console.error("[ClawXrouter] Failed to initialize memory directories:", err);
    }
  }
}

// Export a singleton instance
let defaultMemoryManager: MemoryIsolationManager | null = null;

export function getDefaultMemoryManager(workspaceDir?: string): MemoryIsolationManager {
  if (!defaultMemoryManager || workspaceDir) {
    defaultMemoryManager = new MemoryIsolationManager(workspaceDir);
  }
  return defaultMemoryManager;
}
