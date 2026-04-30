import type {
  Checkpoint,
  DetectionContext,
  ClawXrouterRouter,
  PipelineConfig,
  RouterDecision,
  RouterRegistration,
} from "./types.js";
import { maxLevel } from "./types.js";

export class RouterPipeline {
  private routers = new Map<string, ClawXrouterRouter>();
  private pipelineConfig: PipelineConfig = {};
  private routerConfigs = new Map<string, RouterRegistration>();
  private logger: {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };

  constructor(logger?: {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  }) {
    this.logger = logger ?? {
      info: (m: string) => console.log(m),
      warn: (m: string) => console.warn(m),
      error: (m: string) => console.error(m),
    };
  }

  /**
   * Register a router instance. Overwrites if same id exists.
   */
  register(router: ClawXrouterRouter, registration?: RouterRegistration): void {
    this.routers.set(router.id, router);
    if (registration) {
      this.routerConfigs.set(router.id, registration);
    }
    this.logger.info(`[RouterPipeline] Registered router: ${router.id}`);
  }

  /**
   * Load a custom router from a module path.
   */
  async loadCustomRouter(
    id: string,
    modulePath: string,
    registration?: RouterRegistration,
  ): Promise<void> {
    try {
      const mod = await import(modulePath);
      const router: ClawXrouterRouter = mod.default ?? mod;
      if (!router.detect || typeof router.detect !== "function") {
        this.logger.error(
          `[RouterPipeline] Custom router "${id}" from ${modulePath} does not export a valid detect() function`,
        );
        return;
      }
      router.id = id;
      this.register(router, registration);
    } catch (err) {
      this.logger.error(
        `[RouterPipeline] Failed to load custom router "${id}" from ${modulePath}: ${String(err)}`,
      );
    }
  }

  /**
   * Configure the pipeline from the plugin config.
   */
  configure(config: {
    routers?: Record<string, RouterRegistration | undefined>;
    pipeline?: PipelineConfig;
  }): void {
    if (config.routers) {
      for (const [id, reg] of Object.entries(config.routers)) {
        if (reg) this.routerConfigs.set(id, reg);
      }
    }
    if (config.pipeline) {
      this.pipelineConfig = config.pipeline;
    }
  }

  /**
   * Load all custom routers declared in config.
   */
  async loadCustomRouters(): Promise<void> {
    for (const [id, reg] of this.routerConfigs) {
      if (reg.type === "custom" && reg.module && !this.routers.has(id)) {
        await this.loadCustomRouter(id, reg.module, reg);
      }
    }
  }

  /**
   * Get the ordered list of router IDs for a checkpoint.
   * Falls back to running all enabled routers if pipeline config is not set.
   */
  getRoutersForCheckpoint(checkpoint: Checkpoint): string[] {
    const configured = this.pipelineConfig[checkpoint];
    if (configured && configured.length > 0) {
      return configured;
    }
    // Fallback: all registered routers in registration order
    return [...this.routers.keys()];
  }

  /**
   * Check if a router is enabled via config.
   */
  private isRouterEnabled(id: string): boolean {
    const reg = this.routerConfigs.get(id);
    return reg?.enabled !== false;
  }

  /**
   * Get the configured weight for a router (default 50).
   */
  getRouterWeight(id: string): number {
    return this.routerConfigs.get(id)?.weight ?? 50;
  }

  /**
   * Run the pipeline for a given checkpoint.
   *
   * Two-phase execution with short-circuit:
   *   Phase 1 — run all "fast" routers (weight >= 50) in parallel.
   *             If any returns S3 (or S2-local) with a non-passthrough action,
   *             skip slow routers.
   *   Phase 2 — run remaining "slow" routers (weight < 50) when Phase 1 was
   *             all S1, or when S2-proxy is the highest level (so token-saver
   *             can still select the best model for the proxied request).
   *
   * This avoids expensive LLM judge calls (token-saver) when rule-based
   * detection already determined the message must stay local (S3 / S2-local),
   * while still allowing cost optimization for S2-proxy requests.
   */
  async run(
    checkpoint: Checkpoint,
    context: DetectionContext,
    pluginConfig: Record<string, unknown>,
  ): Promise<RouterDecision> {
    const routerIds = this.getRoutersForCheckpoint(checkpoint);

    if (routerIds.length === 0) {
      return { level: "S1", action: "passthrough", reason: "No routers configured" };
    }

    type Entry = { id: string; weight: number; router: ClawXrouterRouter };
    const fast: Entry[] = [];
    const slow: Entry[] = [];

    for (const id of routerIds) {
      if (!this.isRouterEnabled(id)) continue;
      const router = this.routers.get(id);
      if (!router) {
        this.logger.warn(
          `[RouterPipeline] Router "${id}" referenced in pipeline but not registered`,
        );
        continue;
      }
      const weight = this.getRouterWeight(id);
      (weight >= 50 ? fast : slow).push({ id, weight, router });
    }

    if (fast.length === 0 && slow.length === 0) {
      return { level: "S1", action: "passthrough", reason: "No enabled routers" };
    }

    // Phase 1: fast (high-weight) routers in parallel
    const fastResults = await this.runGroup(fast, context, pluginConfig);

    for (const r of fastResults) {
      this.logger.info(
        `[RouterPipeline] ${r.decision.routerId}: level=${r.decision.level} action=${r.decision.action ?? "passthrough"} ${r.decision.reason ? `reason="${r.decision.reason}"` : ""} ${r.decision.target ? `target=${r.decision.target.provider}/${r.decision.target.model}` : ""}`.trim(),
      );
    }

    const mustShortCircuit = fastResults.some((r) => {
      if (r.decision.level === "S1" || r.decision.action === "passthrough") return false;
      // S2 via privacy proxy can benefit from Phase 2 (e.g. TokenSaver model selection)
      if (r.decision.level === "S2" && r.decision.target?.provider === "clawxrouter-privacy")
        return false;
      return true;
    });

    if (mustShortCircuit || slow.length === 0) {
      if (mustShortCircuit && slow.length > 0) {
        this.logger.info(
          `[ClawXrouter] [${checkpoint}] Short-circuit: skipping ${slow.map((s) => s.id).join(",")}`,
        );
      }
      const merged = mergeDecisionsWeighted(fastResults);
      this.logFinalDecision(checkpoint, merged);
      return merged;
    }

    // Phase 2: slow (low-weight) routers — runs when Phase 1 is all-S1 or S2-proxy
    const slowResults = await this.runGroup(slow, context, pluginConfig);
    for (const r of slowResults) {
      this.logger.info(
        `[RouterPipeline] ${r.decision.routerId}: level=${r.decision.level} action=${r.decision.action ?? "passthrough"} ${r.decision.reason ? `reason="${r.decision.reason}"` : ""} ${r.decision.target ? `target=${r.decision.target.provider}/${r.decision.target.model}` : ""}`.trim(),
      );
    }
    const merged = mergeDecisionsWeighted([...fastResults, ...slowResults]);
    this.logFinalDecision(checkpoint, merged);
    return merged;
  }

  private async runGroup(
    group: Array<{ id: string; weight: number; router: ClawXrouterRouter }>,
    context: DetectionContext,
    pluginConfig: Record<string, unknown>,
  ): Promise<WeightedDecision[]> {
    const tasks = group.map(({ id, weight, router }) => ({
      id,
      weight,
      promise: router.detect(context, pluginConfig).then((d) => {
        d.routerId = id;
        return d;
      }),
    }));

    const settled = await Promise.allSettled(tasks.map((t) => t.promise));
    const results: WeightedDecision[] = [];

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      const { id, weight } = tasks[i];
      if (result.status === "fulfilled") {
        const d = result.value;
        const reasonStr = d.reason ? ` (${d.reason})` : "";
        const targetStr = d.target ? ` → ${d.target.provider}/${d.target.model}` : "";
        this.logger.info(
          `[ClawXrouter] [${context.checkpoint}] ${id}: ${d.level} ${d.action ?? "passthrough"}${targetStr}${reasonStr}`,
        );
        results.push({ decision: d, weight });
      } else {
        this.logger.error(`[RouterPipeline] Router "${id}" failed: ${String(result.reason)}`);
      }
    }

    return results;
  }

  private logFinalDecision(checkpoint: Checkpoint, d: RouterDecision): void {
    const targetStr = d.target ? ` → ${d.target.provider}/${d.target.model}` : "";
    const reasonStr = d.reason ? ` (${d.reason})` : "";
    const log = d.level === "S1" ? this.logger.info : this.logger.warn;
    log.call(
      this.logger,
      `[ClawXrouter] [${checkpoint}] ▶ Final: ${d.level} ${d.action ?? "passthrough"}${targetStr}${reasonStr}`,
    );
  }

  /**
   * Run a single router by ID (for per-router testing).
   */
  async runSingle(
    id: string,
    context: DetectionContext,
    pluginConfig: Record<string, unknown>,
  ): Promise<RouterDecision | null> {
    const router = this.routers.get(id);
    if (!router) return null;
    const decision = await router.detect({ ...context, dryRun: true }, pluginConfig);
    decision.routerId = id;
    return decision;
  }

  /**
   * List all registered router IDs.
   */
  listRouters(): string[] {
    return [...this.routers.keys()];
  }

  /**
   * Check if a router is registered.
   */
  hasRouter(id: string): boolean {
    return this.routers.has(id);
  }
}

type WeightedDecision = { decision: RouterDecision; weight: number };

const ACTION_PRIORITY: Record<string, number> = {
  block: 4,
  redirect: 3,
  transform: 2,
  passthrough: 1,
};

/**
 * Merge router decisions using weighted scoring.
 *
 * Strategy:
 *   1. Safety-first: highest sensitivity level always wins (S3 > S2 > S1).
 *   2. Among decisions at the same level, weight breaks ties — the router
 *      with the higher weight determines the action/target.
 *   3. If weights are equal, action severity breaks the tie
 *      (block > redirect > transform > passthrough).
 *   4. Final confidence is a weighted average.
 */
function mergeDecisionsWeighted(items: WeightedDecision[]): RouterDecision {
  if (items.length === 0) {
    return { level: "S1", action: "passthrough", reason: "No decisions" };
  }

  if (items.length === 1) {
    return items[0].decision;
  }

  const levels = items.map((i) => i.decision.level);
  const winningLevel = maxLevel(...levels);

  const atWinningLevel = items.filter((i) => i.decision.level === winningLevel);

  atWinningLevel.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return (
      (ACTION_PRIORITY[b.decision.action ?? "passthrough"] ?? 0) -
      (ACTION_PRIORITY[a.decision.action ?? "passthrough"] ?? 0)
    );
  });

  let winner = atWinningLevel[0].decision;

  // When the winning level is S1 and the highest-weight router says "passthrough"
  // (i.e., it has no concern), but another router wants to "redirect" (e.g.,
  // token-saver wants a specific model), honor the redirect — passthrough at S1
  // means "no opinion", not "I insist on default".
  if (winningLevel === "S1" && (winner.action ?? "passthrough") === "passthrough") {
    const redirectCandidate = atWinningLevel.find(
      (i) => (i.decision.action ?? "passthrough") === "redirect" && i.decision.target,
    );
    if (redirectCandidate) {
      winner = redirectCandidate.decision;
    }
  }

  // S2-proxy + token-saver: keep the proxy path but adopt the model selected
  // by a lower-level router (e.g. token-saver's tier-based model).
  // The proxy strips PII before forwarding, so model selection still matters.
  if (
    winningLevel === "S2" &&
    winner.target?.provider === "clawxrouter-privacy" &&
    !winner.target.model
  ) {
    const modelHint = items.find(
      (i) =>
        i.decision.level === "S1" &&
        (i.decision.action ?? "passthrough") === "redirect" &&
        i.decision.target?.model,
    );
    if (modelHint) {
      const hintTarget = modelHint.decision.target!;
      winner = {
        ...winner,
        target: {
          ...winner.target,
          model: hintTarget.model,
          originalProvider:
            hintTarget.provider !== "clawxrouter-privacy" ? hintTarget.provider : undefined,
        },
        reason: [winner.reason, modelHint.decision.reason].filter(Boolean).join("; "),
      };
    }
  }

  const allReasons = items
    .filter((i) => i.decision.level !== "S1" && i.decision.reason)
    .map((i) => `[${i.decision.routerId ?? "?"}:w${i.weight}] ${i.decision.reason}`);

  const totalWeight = items.reduce((s, i) => s + i.weight, 0);
  const weightedConfidence =
    totalWeight > 0
      ? items.reduce((s, i) => s + (i.decision.confidence ?? 0.5) * i.weight, 0) / totalWeight
      : 0.5;

  return {
    level: winningLevel,
    action: winner.action ?? "passthrough",
    target: winner.target,
    transformedContent: winner.transformedContent,
    reason: allReasons.length > 0 ? allReasons.join("; ") : winner.reason,
    confidence: weightedConfidence,
    routerId: winner.routerId,
  };
}

/** Singleton pipeline instance (set during plugin init) */
let globalPipeline: RouterPipeline | null = null;

export function setGlobalPipeline(pipeline: RouterPipeline): void {
  globalPipeline = pipeline;
}

export function getGlobalPipeline(): RouterPipeline | null {
  return globalPipeline;
}
