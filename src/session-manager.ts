import * as fs from "node:fs";
import * as path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { isGuardSessionKey } from "./guard-agent.js";

export type SessionMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  sessionKey?: string;
};

/**
 * Dual session manager that maintains separate full and clean histories
 */
export class DualSessionManager {
  private baseDir: string;
  private writeLocks = new Map<string, Promise<void>>();

  /**
   * Serialize writes to the same file to prevent interleaved JSONL lines
   * when multiple fire-and-forget writes race from sync hooks.
   */
  private async withWriteLock(lockKey: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writeLocks.get(lockKey) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.writeLocks.set(lockKey, next);
    await next;
  }

  constructor(baseDir?: string) {
    const resolved = baseDir ?? resolveStateDir(process.env);
    // Expand ~ to home directory for explicitly-passed user paths
    this.baseDir = resolved.startsWith("~")
      ? path.join(process.env.HOME || process.env.USERPROFILE || "~", resolved.slice(2))
      : resolved;
  }

  /**
   * Persist a message to session history
   * - Full history: includes all messages (including guard agent interactions)
   * - Clean history: excludes guard agent interactions (for cloud models)
   */
  async persistMessage(
    sessionKey: string,
    message: SessionMessage,
    agentId: string = "main",
  ): Promise<void> {
    // Always write to full history
    await this.writeToHistory(sessionKey, message, agentId, "full");

    // Write to clean history only if not a guard agent message
    if (!this.isGuardAgentMessage(message)) {
      await this.writeToHistory(sessionKey, message, agentId, "clean");
    }
  }

  /**
   * Seed the full track with existing clean track content (if any) so that
   * the full track is a complete history from the start of the session.
   * No-op if the full track already exists.  Mirrors the memory-isolation
   * pattern of mergeCleanIntoFull.
   */
  private seededSessions = new Set<string>();

  private async ensureFullTrackSeeded(sessionKey: string, agentId: string): Promise<void> {
    const key = `${sessionKey}:${agentId}`;
    if (this.seededSessions.has(key)) return;

    const fullPath = this.getHistoryPath(sessionKey, agentId, "full");
    if (fs.existsSync(fullPath)) {
      this.seededSessions.add(key);
      return;
    }

    const cleanPath = this.getHistoryPath(sessionKey, agentId, "clean");
    if (!fs.existsSync(cleanPath)) {
      this.seededSessions.add(key);
      return;
    }

    try {
      const dir = path.dirname(fullPath);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.copyFile(cleanPath, fullPath);
      console.log(`[ClawXrouter] Seeded full track from clean track for ${sessionKey}`);
    } catch (err) {
      console.error(`[ClawXrouter] Failed to seed full track for ${sessionKey}:`, err);
    }
    this.seededSessions.add(key);
  }

  /**
   * Write a message to the full history only.
   * On first write, seeds the full track with existing clean track content
   * so it contains the complete conversation history.
   */
  async writeToFull(
    sessionKey: string,
    message: SessionMessage,
    agentId: string = "main",
  ): Promise<void> {
    await this.ensureFullTrackSeeded(sessionKey, agentId);
    await this.writeToHistory(sessionKey, message, agentId, "full");
  }

  /**
   * Write a message to the clean history only.
   */
  async writeToClean(
    sessionKey: string,
    message: SessionMessage,
    agentId: string = "main",
  ): Promise<void> {
    await this.writeToHistory(sessionKey, message, agentId, "clean");
  }

  /**
   * Load session history based on model type
   * - Cloud models: get clean history only
   * - Local models: get full history
   */
  async loadHistory(
    sessionKey: string,
    isCloudModel: boolean,
    agentId: string = "main",
    limit?: number,
  ): Promise<SessionMessage[]> {
    const historyType = isCloudModel ? "clean" : "full";
    return await this.readHistory(sessionKey, agentId, historyType, limit);
  }

  /**
   * Check if a message is from guard agent interactions
   */
  private isGuardAgentMessage(message: SessionMessage): boolean {
    if (message.sessionKey && isGuardSessionKey(message.sessionKey)) {
      return true;
    }

    const content = message.content;
    if (content.includes("[clawxrouter:guard]") || content.includes("[guard agent]")) {
      return true;
    }

    return false;
  }

  /**
   * Write message to history file.
   * Uses a per-file write lock to serialize concurrent appends
   * (e.g. from fire-and-forget calls in sync hooks).
   */
  private async writeToHistory(
    sessionKey: string,
    message: SessionMessage,
    agentId: string,
    historyType: "full" | "clean",
  ): Promise<void> {
    const historyPath = this.getHistoryPath(sessionKey, agentId, historyType);

    await this.withWriteLock(historyPath, async () => {
      try {
        const dir = path.dirname(historyPath);
        await fs.promises.mkdir(dir, { recursive: true });

        const line = JSON.stringify({
          ...message,
          timestamp: message.timestamp ?? Date.now(),
        });

        await fs.promises.appendFile(historyPath, line + "\n", "utf-8");
      } catch (err) {
        console.error(
          `[ClawXrouter] Failed to write to ${historyType} history for ${sessionKey}:`,
          err,
        );
      }
    });
  }

  /**
   * Read messages from history file
   */
  private async readHistory(
    sessionKey: string,
    agentId: string,
    historyType: "full" | "clean",
    limit?: number,
  ): Promise<SessionMessage[]> {
    try {
      const historyPath = this.getHistoryPath(sessionKey, agentId, historyType);

      // Check if file exists
      if (!fs.existsSync(historyPath)) {
        return [];
      }

      // Read file and parse JSONL
      const content = await fs.promises.readFile(historyPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      const messages = lines
        .map((line) => {
          try {
            return JSON.parse(line) as SessionMessage;
          } catch {
            return null;
          }
        })
        .filter((msg): msg is SessionMessage => msg !== null);

      // Apply limit if specified
      if (limit && messages.length > limit) {
        return messages.slice(-limit);
      }

      return messages;
    } catch (err) {
      console.error(`[ClawXrouter] Failed to read ${historyType} history for ${sessionKey}:`, err);
      return [];
    }
  }

  /**
   * Get history file path
   */
  private getHistoryPath(
    sessionKey: string,
    agentId: string,
    historyType: "full" | "clean",
  ): string {
    // Sanitize session key for file name
    const safeSessionKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");

    const fileName = `${safeSessionKey}.jsonl`;

    return path.join(this.baseDir, "agents", agentId, "sessions", historyType, fileName);
  }

  /**
   * Clear history for a session
   */
  async clearHistory(
    sessionKey: string,
    agentId: string = "main",
    historyType?: "full" | "clean",
  ): Promise<void> {
    const types: Array<"full" | "clean"> = historyType ? [historyType] : ["full", "clean"];

    for (const type of types) {
      try {
        const historyPath = this.getHistoryPath(sessionKey, agentId, type);

        if (fs.existsSync(historyPath)) {
          await fs.promises.unlink(historyPath);
        }
      } catch (err) {
        console.error(`[ClawXrouter] Failed to clear ${type} history for ${sessionKey}:`, err);
      }
    }
  }

  /**
   * Load messages that exist in the full track but not in the clean track.
   * These are Guard Agent interactions and original S3 content that were
   * stripped from the sanitized transcript — exactly the context a local
   * model needs to reconstruct the full conversation.
   */
  async loadHistoryDelta(
    sessionKey: string,
    agentId: string = "main",
    limit?: number,
  ): Promise<SessionMessage[]> {
    const full = await this.readHistory(sessionKey, agentId, "full");
    const clean = await this.readHistory(sessionKey, agentId, "clean");

    if (full.length === 0) return [];
    if (clean.length === 0) return limit ? full.slice(-limit) : full;

    const cleanSet = new Set(
      clean.map((m) => `${m.role}:${m.timestamp ?? ""}:${m.content.slice(0, 80)}`),
    );

    const delta = full.filter(
      (m) => !cleanSet.has(`${m.role}:${m.timestamp ?? ""}:${m.content.slice(0, 80)}`),
    );

    return limit && delta.length > limit ? delta.slice(-limit) : delta;
  }

  /**
   * Format session messages as a readable conversation context block
   * suitable for injection via prependContext.
   */
  static formatAsContext(messages: SessionMessage[], label?: string): string {
    if (messages.length === 0) return "";

    const header = label ?? "Full conversation history (original, authoritative)";
    const lines = [
      `[${header}]`,
      `[NOTE: The conversation above may contain "🔒 [Private message]" placeholders or redacted text. This is the complete original history — use it as the authoritative source.]`,
    ];

    for (const msg of messages) {
      const roleLabel =
        msg.role === "user"
          ? "User"
          : msg.role === "assistant"
            ? "Assistant"
            : msg.role === "tool"
              ? `Tool${msg.toolName ? `(${msg.toolName})` : ""}`
              : "System";

      const ts = msg.timestamp ? ` [ts=${new Date(msg.timestamp).toISOString()}]` : "";

      const truncated =
        msg.content.length > 2000 ? msg.content.slice(0, 2000) + "…(truncated)" : msg.content;

      lines.push(`${roleLabel}${ts}: ${truncated}`);
    }

    lines.push("[End of private context]");
    return lines.join("\n");
  }

  /**
   * Get history statistics
   */
  async getHistoryStats(
    sessionKey: string,
    agentId: string = "main",
  ): Promise<{
    fullCount: number;
    cleanCount: number;
    difference: number;
  }> {
    const full = await this.readHistory(sessionKey, agentId, "full");
    const clean = await this.readHistory(sessionKey, agentId, "clean");

    return {
      fullCount: full.length,
      cleanCount: clean.length,
      difference: full.length - clean.length,
    };
  }
}

// Export a singleton instance
let defaultManager: DualSessionManager | null = null;

export function getDefaultSessionManager(baseDir?: string): DualSessionManager {
  if (!defaultManager || baseDir) {
    defaultManager = new DualSessionManager(baseDir);
  }
  return defaultManager;
}
