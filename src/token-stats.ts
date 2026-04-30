import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getLiveConfig } from "./live-config.js";
import { getSessionHighestLevel, getSessionRouteLevel, getLoopMeta } from "./session-state.js";

// ── Types ──

export type RouteCategory = "cloud" | "local" | "proxy";

/** Distinguishes router overhead (detection/classification) from actual task execution. */
export type TokenSource = "router" | "task";

export type TokenBucket = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  requestCount: number;
  estimatedCost: number;
};

export type SourceBuckets = Record<TokenSource, TokenBucket>;

export type HourlyBucket = {
  hour: string;
  cloud: TokenBucket;
  local: TokenBucket;
  proxy: TokenBucket;
  bySource: SourceBuckets;
};

export type SessionTokenStats = {
  sessionKey: string;
  highestLevel: "S1" | "S2" | "S3";
  cloud: TokenBucket;
  local: TokenBucket;
  proxy: TokenBucket;
  bySource: SourceBuckets;
  firstSeenAt: number;
  lastActiveAt: number;
  loopId?: string;
  userMessagePreview?: string;
};

export type TokenStatsData = {
  lifetime: Record<RouteCategory, TokenBucket>;
  bySource: SourceBuckets;
  hourly: HourlyBucket[];
  sessions: Record<string, SessionTokenStats>;
  startedAt: number;
  lastUpdatedAt: number;
};

export type UsageEvent = {
  sessionKey: string;
  provider: string;
  model: string;
  /** "router" for pipeline overhead (judge, detection, PII extraction), "task" for actual request. */
  source?: TokenSource;
  loopId?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

// ── Token update listeners (used by SSE in the dashboard) ──

export type TokenUpdateEvent = {
  sessionKey: string;
  loopId?: string;
  stats: SessionTokenStats;
};
type TokenUpdateListener = (event: TokenUpdateEvent) => void;
const tokenUpdateListeners = new Set<TokenUpdateListener>();

export function onTokenUpdate(fn: TokenUpdateListener): () => void {
  tokenUpdateListeners.add(fn);
  return () => {
    tokenUpdateListeners.delete(fn);
  };
}

// ── Helpers ──

const MAX_HOURLY_BUCKETS = 72;
const MAX_SESSIONS = 200;

function emptyBucket(): TokenBucket {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    requestCount: 0,
    estimatedCost: 0,
  };
}

function emptySourceBuckets(): SourceBuckets {
  return { router: emptyBucket(), task: emptyBucket() };
}

function currentHourKey(): string {
  return new Date().toISOString().slice(0, 13);
}

function emptyStats(): TokenStatsData {
  return {
    lifetime: { cloud: emptyBucket(), local: emptyBucket(), proxy: emptyBucket() },
    bySource: emptySourceBuckets(),
    hourly: [],
    sessions: {},
    startedAt: Date.now(),
    lastUpdatedAt: Date.now(),
  };
}

function addToBucket(bucket: TokenBucket, usage: UsageEvent["usage"], cost = 0): void {
  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;
  const cacheRead = usage?.cacheRead ?? 0;
  bucket.inputTokens += input;
  bucket.outputTokens += output;
  bucket.cacheReadTokens += cacheRead;
  bucket.totalTokens += usage?.total ?? input + output;
  bucket.requestCount += 1;
  bucket.estimatedCost += cost;
}

/** Look up pricing for a model: exact match, then substring match, then default. */
export function lookupPricing(model: string): { inputPer1M: number; outputPer1M: number } {
  const pricing = getLiveConfig().modelPricing;
  if (!pricing) return { inputPer1M: 3, outputPer1M: 15 };

  if (pricing[model]) {
    return {
      inputPer1M: pricing[model].inputPer1M ?? 3,
      outputPer1M: pricing[model].outputPer1M ?? 15,
    };
  }

  const lowerModel = model.toLowerCase();
  for (const [key, val] of Object.entries(pricing)) {
    if (lowerModel.includes(key.toLowerCase())) {
      return { inputPer1M: val.inputPer1M ?? 3, outputPer1M: val.outputPer1M ?? 15 };
    }
  }

  return { inputPer1M: 3, outputPer1M: 15 };
}

function calculateCost(model: string, usage: UsageEvent["usage"]): number {
  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;
  const p = lookupPricing(model);
  return (input * p.inputPer1M + output * p.outputPer1M) / 1_000_000;
}

/**
 * Classify a usage event for cost/bucket assignment.
 * Uses `routeLevel` (set at before_model_resolve time) so that
 * post-routing S3 escalations (e.g. from tool_result_persist) don't
 * retroactively zero-out cost for cloud calls already made under S1.
 */
function classifyEvent(event: UsageEvent): RouteCategory {
  if (event.source === "router") return "local";
  if (event.provider === "edge" || event.provider === "local") return "local";
  const level = getSessionRouteLevel(event.sessionKey);
  if (level === "S3") return "local";
  if (level === "S2" && getLiveConfig().s2Policy !== "local") return "proxy";
  return "cloud";
}

// ── Collector ──

export class TokenStatsCollector {
  private data: TokenStatsData;
  private filePath: string;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = emptyStats();
  }

  /** Load persisted stats from disk. Merges with empty defaults for missing fields. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<TokenStatsData>;
      const rawSessions =
        parsed.sessions && typeof parsed.sessions === "object"
          ? (parsed.sessions as Record<string, SessionTokenStats>)
          : {};
      const parsedBySource = parsed.bySource as Partial<SourceBuckets> | undefined;
      this.data = {
        lifetime: {
          cloud: { ...emptyBucket(), ...parsed.lifetime?.cloud },
          local: { ...emptyBucket(), ...parsed.lifetime?.local },
          proxy: { ...emptyBucket(), ...parsed.lifetime?.proxy },
        },
        bySource: {
          router: { ...emptyBucket(), ...parsedBySource?.router },
          task: { ...emptyBucket(), ...parsedBySource?.task },
        },
        hourly: Array.isArray(parsed.hourly) ? parsed.hourly : [],
        sessions: rawSessions,
        startedAt: parsed.startedAt ?? Date.now(),
        lastUpdatedAt: parsed.lastUpdatedAt ?? Date.now(),
      };
    } catch {
      this.data = emptyStats();
    }
  }

  /** Start periodic flush (every 5 minutes). */
  startAutoFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      if (this.dirty) this.flush().catch(() => {});
    }, 300_000);
    if (this.flushTimer && typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
      (this.flushTimer as NodeJS.Timeout).unref();
    }
  }

  /** Stop periodic flush. */
  stopAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Record a usage event from llm_output hook or router overhead. */
  record(event: UsageEvent): void {
    const category = classifyEvent(event);
    const source: TokenSource = event.source ?? "task";
    const now = Date.now();

    const cost = category !== "local" ? calculateCost(event.model, event.usage) : 0;

    addToBucket(this.data.lifetime[category], event.usage, cost);
    addToBucket(this.data.bySource[source], event.usage, cost);

    const hourKey = currentHourKey();
    let hourly = this.data.hourly.find((h) => h.hour === hourKey);
    if (!hourly) {
      hourly = {
        hour: hourKey,
        cloud: emptyBucket(),
        local: emptyBucket(),
        proxy: emptyBucket(),
        bySource: emptySourceBuckets(),
      };
      this.data.hourly.push(hourly);
      if (this.data.hourly.length > MAX_HOURLY_BUCKETS) {
        this.data.hourly = this.data.hourly.slice(-MAX_HOURLY_BUCKETS);
      }
    }
    if (!hourly.bySource) hourly.bySource = emptySourceBuckets();
    addToBucket(hourly[category], event.usage, cost);
    addToBucket(hourly.bySource[source], event.usage, cost);

    // Per-loop tracking (keyed by sessionKey:loopId)
    const sk = event.sessionKey;
    const lid = event.loopId;
    if (sk && lid) {
      const compoundKey = `${sk}::${lid}`;
      let sess = this.data.sessions[compoundKey];
      if (!sess) {
        const meta = getLoopMeta(lid);
        sess = {
          sessionKey: sk,
          highestLevel: getSessionHighestLevel(sk),
          cloud: emptyBucket(),
          local: emptyBucket(),
          proxy: emptyBucket(),
          bySource: emptySourceBuckets(),
          firstSeenAt: now,
          lastActiveAt: now,
          loopId: lid,
          userMessagePreview: meta?.userMessagePreview ?? "",
        };
        this.data.sessions[compoundKey] = sess;
      }
      if (!sess.bySource) sess.bySource = emptySourceBuckets();
      const loopMeta = getLoopMeta(lid);
      sess.highestLevel = loopMeta?.highestLevel ?? getSessionHighestLevel(sk);
      sess.lastActiveAt = now;
      addToBucket(sess[category], event.usage, cost);
      addToBucket(sess.bySource[source], event.usage, cost);
      this.evictOldSessions();

      for (const fn of tokenUpdateListeners) {
        try {
          fn({ sessionKey: sk, loopId: lid, stats: sess });
        } catch {
          /* ignore */
        }
      }
    }

    this.data.lastUpdatedAt = now;
    this.dirty = true;
  }

  private evictOldSessions(): void {
    const keys = Object.keys(this.data.sessions);
    if (keys.length <= MAX_SESSIONS) return;
    const sorted = keys.sort(
      (a, b) => this.data.sessions[a].lastActiveAt - this.data.sessions[b].lastActiveAt,
    );
    const toRemove = sorted.slice(0, keys.length - MAX_SESSIONS);
    for (const k of toRemove) delete this.data.sessions[k];
  }

  /** Get snapshot of current stats. */
  getStats(): TokenStatsData {
    return this.data;
  }

  /** Get summary for API response. */
  getSummary(): {
    lifetime: TokenStatsData["lifetime"];
    bySource: SourceBuckets;
    lastUpdatedAt: number;
    startedAt: number;
  } {
    return {
      lifetime: this.data.lifetime,
      bySource: this.data.bySource,
      lastUpdatedAt: this.data.lastUpdatedAt,
      startedAt: this.data.startedAt,
    };
  }

  /** Get hourly data for API response. */
  getHourly(): HourlyBucket[] {
    return this.data.hourly;
  }

  /** Get per-session stats sorted by lastActiveAt descending. */
  getSessionStats(): SessionTokenStats[] {
    return Object.values(this.data.sessions).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /** Reset all stats to empty and flush to disk. */
  async reset(): Promise<void> {
    this.data = emptyStats();
    this.dirty = true;
    await this.flush();
  }

  /** Flush to disk. */
  async flush(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
      this.dirty = false;
    } catch {
      // Non-critical — stats will be retried on next flush
    }
  }
}

// ── Singleton ──

let globalCollector: TokenStatsCollector | null = null;

export function setGlobalCollector(collector: TokenStatsCollector): void {
  globalCollector = collector;
}

export function getGlobalCollector(): TokenStatsCollector | null {
  return globalCollector;
}
