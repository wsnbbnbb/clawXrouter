export type SensitivityLevel = "S1" | "S2" | "S3";

export type SensitivityLevelNumeric = 1 | 2 | 3;

export type DetectorType = "ruleDetector" | "localModelDetector";

export type Checkpoint = "onUserMessage" | "onToolCallProposed" | "onToolCallExecuted";

/**
 * Edge provider API protocol type.
 *   - "openai-compatible": POST /v1/chat/completions (Ollama, vLLM, LiteLLM, LocalAI, LMStudio, SGLang …)
 *   - "ollama-native":     POST /api/chat (Ollama native API, supports streaming natively)
 *   - "custom":            User-supplied module exporting a callChat function
 */
export type EdgeProviderType = "openai-compatible" | "ollama-native" | "custom";

export type PrivacyConfig = {
  enabled?: boolean;
  /** S2 handling: "proxy" strips PII via local HTTP proxy (default), "local" routes to local model */
  s2Policy?: "proxy" | "local";
  /** Port for the privacy proxy server (default: 8403) */
  proxyPort?: number;
  checkpoints?: {
    onUserMessage?: DetectorType[];
    onToolCallProposed?: DetectorType[];
    onToolCallExecuted?: DetectorType[];
  };
  rules?: {
    keywords?: {
      S2?: string[];
      S3?: string[];
    };
    /** Regex patterns for matching sensitive content (strings are compiled to RegExp) */
    patterns?: {
      S2?: string[];
      S3?: string[];
    };
    tools?: {
      S2?: {
        tools?: string[];
        paths?: string[];
      };
      S3?: {
        tools?: string[];
        paths?: string[];
      };
    };
  };
  localModel?: {
    enabled?: boolean;
    /** API protocol type (default: "openai-compatible") */
    type?: EdgeProviderType;
    /** Provider name for OpenClaw routing (e.g. "ollama", "vllm", "lmstudio") */
    provider?: string;
    model?: string;
    endpoint?: string;
    apiKey?: string;
    /** Path to custom provider module (type="custom" only). Must export callChat(). */
    module?: string;
  };
  guardAgent?: {
    id?: string;
    workspace?: string;
    /** Full model reference in "provider/model" format (e.g. "ollama/llama3.2:3b", "vllm/qwen2.5:7b") */
    model?: string;
  };
  session?: {
    isolateGuardHistory?: boolean;
    /** Base directory for session histories (default: ~/.edgeclaw) */
    baseDir?: string;
    /**
     * Inject full-track conversation history as context when routing to
     * local models (S3 / S2-local). This replaces the sanitized placeholders
     * ("🔒 [Private content]") with actual previous sensitive interactions
     * so the local model has full conversational context.
     * Default: true (when isolateGuardHistory is true)
     */
    injectDualHistory?: boolean;
    /** Max number of messages to inject from dual-track history (default: 20) */
    historyLimit?: number;
  };
  /**
   * Additional provider names to treat as "local" (safe for S3 routing).
   * Built-in local providers: ollama, llama.cpp, localai, llamafile, lmstudio, vllm, mlx, sglang, tgi.
   * Add custom entries here if you run your own inference backend.
   */
  localProviders?: string[];
  /**
   * Tool names exempt from privacy pipeline detection and PII redaction.
   * Default: empty (no tools are exempt). Users can opt-in via config.
   */
  toolAllowlist?: string[];
  /**
   * Per-model pricing for cloud API cost estimation (USD per 1M tokens).
   * Keys are model name strings; lookup tries exact match, then substring match.
   */
  modelPricing?: Record<
    string,
    {
      inputPer1M?: number;
      outputPer1M?: number;
    }
  >;
  /**
   * Toggle high-false-positive redaction rules individually.
   * All default to false (off) to avoid over-redaction.
   */
  redaction?: RedactionOptions;
};

export type RedactionOptions = {
  /** Internal IP addresses (10.x, 172.16-31.x, 192.168.x). Default: false */
  internalIp?: boolean;
  /** Email addresses. Default: false */
  email?: boolean;
  /** .env file content (KEY=VALUE lines). Default: false */
  envVar?: boolean;
  /** Credit card number pattern (13-19 digits). Default: false */
  creditCard?: boolean;
  /** Chinese mobile phone number (1[3-9]x 11 digits). Default: false */
  chinesePhone?: boolean;
  /** Chinese ID card number (18 digits / 17+X). Default: false */
  chineseId?: boolean;
  /** Chinese address patterns (省/市/区/路/号 etc.). Default: false */
  chineseAddress?: boolean;
  /** PIN / pin code contextual rule. Default: false */
  pin?: boolean;
};

export type DetectionContext = {
  checkpoint: Checkpoint;
  message?: string;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  toolResult?: unknown;
  sessionKey?: string;
  agentId?: string;
  recentContext?: string[];
  /** When true, routers should skip the `enabled` check (dry-run from dashboard). */
  dryRun?: boolean;
};

export type DetectionResult = {
  level: SensitivityLevel;
  levelNumeric: SensitivityLevelNumeric;
  reason?: string;
  detectorType: DetectorType;
  confidence?: number;
};

// ── Router Pipeline Types ───────────────────────────────────────────────

export type RouterAction = "passthrough" | "redirect" | "transform" | "block";

export type RouterDecision = {
  level: SensitivityLevel;
  action?: RouterAction;
  target?: {
    provider: string;
    model: string;
    /** Set by pipeline merge when the winning provider (clawxrouter-privacy) differs
     *  from the router that originally selected the model.
     *  Used by hooks to stash the correct provider endpoint for the proxy. */
    originalProvider?: string;
  };
  /** When action is "transform", the transformed prompt content */
  transformedContent?: string;
  reason?: string;
  confidence?: number;
  routerId?: string;
};

/**
 * Interface for pluggable routers.
 * The built-in "privacy" router wraps the existing detector + desensitization logic.
 * Users can implement custom routers (cost optimization, content filtering, etc.)
 * and register them in the pipeline config.
 */
export interface ClawXrouterRouter {
  id: string;
  detect(context: DetectionContext, config: Record<string, unknown>): Promise<RouterDecision>;
}

export type RouterRegistration = {
  enabled?: boolean;
  /** "builtin" for privacy/rules, "custom" for user modules, "configurable" for dashboard-created */
  type?: "builtin" | "custom" | "configurable";
  /** Path to custom router module (type="custom" only) */
  module?: string;
  /** Arbitrary config passed to the router's detect() */
  options?: Record<string, unknown>;
  /**
   * Merge weight (0–100, default 50). Higher weight wins when multiple routers
   * produce non-passthrough decisions at the same sensitivity level.
   * Safety routers (privacy) should use high weights; optimization routers
   * (token-saver) should use lower weights so they only take effect when
   * safety routers pass through.
   */
  weight?: number;
};

export type PipelineConfig = {
  onUserMessage?: string[];
  onToolCallProposed?: string[];
  onToolCallExecuted?: string[];
};

// ── Session / History Types ─────────────────────────────────────────────

export type SessionPrivacyState = {
  sessionKey: string;
  /** @deprecated Replaced by per-turn currentTurnLevel. Kept for backward compat. */
  isPrivate: boolean;
  highestLevel: SensitivityLevel;
  /** Highest sensitivity level detected in the CURRENT turn (reset each turn). */
  currentTurnLevel: SensitivityLevel;
  detectionHistory: Array<{
    timestamp: number;
    level: SensitivityLevel;
    checkpoint: Checkpoint;
    reason?: string;
    routerId?: string;
    action?: string;
    target?: string;
    loopId?: string;
  }>;
};

export type LoopMeta = {
  loopId: string;
  sessionKey: string;
  userMessagePreview: string;
  startedAt: number;
  highestLevel: SensitivityLevel;
  routingTier?: string;
  routedModel?: string;
  routerAction?: string;
};

export function levelToNumeric(level: SensitivityLevel): SensitivityLevelNumeric {
  switch (level) {
    case "S1":
      return 1;
    case "S2":
      return 2;
    case "S3":
      return 3;
  }
}

export function numericToLevel(numeric: SensitivityLevelNumeric): SensitivityLevel {
  switch (numeric) {
    case 1:
      return "S1";
    case 2:
      return "S2";
    case 3:
      return "S3";
    default:
      return "S1";
  }
}

export function maxLevel(...levels: SensitivityLevel[]): SensitivityLevel {
  if (levels.length === 0) return "S1";
  const numeric = levels.map(levelToNumeric);
  const max = Math.max(...numeric) as SensitivityLevelNumeric;
  return numericToLevel(max);
}
