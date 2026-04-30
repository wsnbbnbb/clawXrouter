import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

/**
 * Normalize path for comparison (expand ~, resolve relative paths)
 */
export function normalizePath(path: string): string {
  if (path.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "~";
    return path.replace("~", home);
  }
  return path;
}

/**
 * Check if a path matches any of the patterns
 */
export function matchesPathPattern(path: string, patterns: string[]): boolean {
  const normalizedPath = normalizePath(path);

  for (const pattern of patterns) {
    const normalizedPattern = normalizePath(pattern);

    // Exact match
    if (normalizedPath === normalizedPattern) {
      return true;
    }

    // Prefix match (directory)
    if (
      normalizedPath.startsWith(normalizedPattern + "/") ||
      normalizedPath.startsWith(normalizedPattern + "\\")
    ) {
      return true;
    }

    // Suffix match (file extension)
    if (pattern.startsWith("*") && normalizedPath.endsWith(pattern.slice(1))) {
      return true;
    }
  }

  return false;
}

/**
 * Extract paths from tool parameters
 */
export function extractPathsFromParams(params: Record<string, unknown>): string[] {
  const paths: string[] = [];

  // Common path parameter names
  const pathKeys = ["path", "file", "filepath", "filename", "dir", "directory", "target", "source"];

  for (const key of pathKeys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      paths.push(value.trim());
    }
  }

  // Extract filesystem paths embedded in command strings
  const commandKeys = ["command", "cmd", "script"];
  for (const key of commandKeys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      paths.push(...extractPathsFromCommand(value));
    }
  }

  // Also check nested objects
  for (const value of Object.values(params)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      paths.push(...extractPathsFromParams(value as Record<string, unknown>));
    }
  }

  return paths;
}

/**
 * Extract filesystem paths from a shell command string.
 * Matches absolute paths (/...) and home-relative paths (~/).
 */
function extractPathsFromCommand(command: string): string[] {
  const pathRegex = /(?:\/[\w.\-]+(?:\/[\w.\-]*)*|~\/[\w.\-]+(?:\/[\w.\-]*)*)/g;
  const matches = command.match(pathRegex);
  return matches ?? [];
}

/**
 * Sanitize sensitive information from text (comprehensive rule-based redaction).
 * Used for S2 desensitization: redact known patterns then forward to cloud.
 *
 * Two-phase approach:
 *   Phase 1 – Pattern-based: well-known formats (SSH keys, API keys, IPs, etc.)
 *   Phase 2 – Context-based: keyword + connecting words + value
 *             e.g. "password is in abc123" → "[REDACTED:PASSWORD]"
 *
 * Some rules are opt-in via `RedactionOptions` to avoid false positives.
 */
export function redactSensitiveInfo(
  text: string,
  opts?: import("./types.js").RedactionOptions,
): string {
  let redacted = text;

  // ── Phase 1: Pattern-based redaction (always on — low false-positive) ─────

  // Redact SSH private key blocks
  redacted = redacted.replace(
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    "[REDACTED:PRIVATE_KEY]",
  );

  // Redact API keys (sk-xxx, key-xxx patterns)
  redacted = redacted.replace(/\b(?:sk|key|token)-[A-Za-z0-9]{16,}\b/g, "[REDACTED:KEY]");

  // Redact AWS Access Key IDs
  redacted = redacted.replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED:AWS_KEY]");

  // Redact database connection strings
  redacted = redacted.replace(
    /(?:mysql|postgres|postgresql|mongodb|redis|amqp):\/\/[^\s"']+/gi,
    "[REDACTED:DB_CONNECTION]",
  );

  // ── Phase 1a: Opt-in pattern rules (off by default to avoid false positives) ──

  if (opts?.internalIp) {
    redacted = redacted.replace(
      /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g,
      "[REDACTED:INTERNAL_IP]",
    );
  }

  if (opts?.email) {
    redacted = redacted.replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      "[REDACTED:EMAIL]",
    );
  }

  if (opts?.envVar) {
    redacted = redacted.replace(
      /^(?:export\s+)?[A-Z_]{2,}=(?:["'])?[^\s"']+(?:["'])?$/gm,
      "[REDACTED:ENV_VAR]",
    );
  }

  if (opts?.creditCard) {
    redacted = redacted.replace(
      /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{1,7}\b/g,
      "[REDACTED:CARD_NUMBER]",
    );
  }

  // ── Phase 1b: Chinese PII pattern-based redaction (opt-in) ─────────────────

  if (opts?.chinesePhone) {
    redacted = redacted.replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[REDACTED:PHONE]");
  }

  if (opts?.chineseId) {
    redacted = redacted.replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, "[REDACTED:ID]");
  }

  // Chinese delivery tracking numbers (keyword-gated, low false-positive — always on)
  redacted = redacted.replace(
    /(?:快递单号|运单号|取件码)[：:\s]*[A-Za-z0-9]{6,20}/g,
    "[REDACTED:DELIVERY]",
  );

  // Door access codes following keywords (keyword-gated, low false-positive — always on)
  redacted = redacted.replace(
    /(?:门禁码|门禁密码|门锁密码|开门密码)[：:\s]*[A-Za-z0-9#*]{3,12}/g,
    "[REDACTED:ACCESS_CODE]",
  );

  if (opts?.chineseAddress) {
    redacted = redacted.replace(
      /[\u4e00-\u9fa5]{2,}(?:省|市|区|县|镇|路|街|巷|弄|号|栋|幢|室|楼|单元|门牌)\d*[\u4e00-\u9fa5\d]*/g,
      "[REDACTED:ADDRESS]",
    );
  }

  // ── Phase 2: Context-based redaction ──────────────────────────────────────
  // Match: <keyword> <connecting words> <actual value>
  // This catches patterns like "password is abc123", "credit card number is in 12896489bf"
  //
  // Two CONNECT modes:
  //   STRICT — requires a verb (is/are/was) or delimiter (=/:) before the value.
  //            Used for broad keywords like "credit card" to avoid false positives.
  //   LOOSE  — also accepts a plain space between keyword and value.
  //            Used for credential keywords like "password" where the next word is very
  //            likely the value.

  const STRICT_CONNECT = "(?:\\s+(?:is|are|was|were)(?:\\s+(?:in|at|on|of|for))*|\\s*[=:])\\s*";
  const LOOSE_CONNECT =
    "(?:\\s+(?:is|are|was|were)(?:\\s+(?:in|at|on|of|for))*\\s*|\\s*[=:]\\s*|\\s+)";

  const contextualRules: Array<{ pattern: RegExp; label: string }> = [
    {
      pattern: new RegExp(
        `(?:password|passwd|pwd|passcode)${LOOSE_CONNECT}["']?([^\\s"']{2,})["']?`,
        "gi",
      ),
      label: "PASSWORD",
    },
    {
      pattern: new RegExp(
        `(?:credit\\s*card|card\\s*(?:number|no\\.?))${STRICT_CONNECT}["']?([^\\s"']{2,})["']?`,
        "gi",
      ),
      label: "CARD",
    },
    {
      pattern: new RegExp(
        `(?:api[_\\s]?key|access[_\\s]?key|SECRET_KEY|API_KEY)${LOOSE_CONNECT}["']?([^\\s"']{2,})["']?`,
        "gi",
      ),
      label: "API_KEY",
    },
    {
      pattern: new RegExp(`(?:secret)${STRICT_CONNECT}["']?([^\\s"']{2,})["']?`, "gi"),
      label: "SECRET",
    },
    {
      pattern: new RegExp(
        `(?:(?:auth[_\\s]?)?token|bearer)${LOOSE_CONNECT}["']?([^\\s"']{2,})["']?`,
        "gi",
      ),
      label: "TOKEN",
    },
    {
      pattern: new RegExp(`(?:credential|cred)s?${LOOSE_CONNECT}["']?([^\\s"']{2,})["']?`, "gi"),
      label: "CREDENTIAL",
    },
    {
      pattern: new RegExp(
        `(?:ssn|social\\s*security(?:\\s*(?:number|no\\.?))?)${STRICT_CONNECT}["']?([^\\s"']{2,})["']?`,
        "gi",
      ),
      label: "SSN",
    },
  ];

  if (opts?.pin) {
    contextualRules.push({
      pattern: new RegExp(
        `(?:pin(?:\\s*(?:code|number))?)${STRICT_CONNECT}["']?([^\\s"']{2,})["']?`,
        "gi",
      ),
      label: "PIN",
    });
  }

  for (const rule of contextualRules) {
    redacted = redacted.replace(rule.pattern, `[REDACTED:${rule.label}]`);
  }

  return redacted;
}

/**
 * Check if a path refers to protected memory/history directories that cloud models should not access.
 */
export function isProtectedMemoryPath(
  filePath: string,
  baseDir: string = resolveStateDir(process.env),
): boolean {
  const normalizedFile = normalizePath(filePath);
  const normalizedBase = normalizePath(baseDir);
  const escapedBase = normalizedBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Patterns that cloud models must NOT read
  const protectedPaths = [
    `${escapedBase}/agents/[^/]+/sessions/full`,
    `${escapedBase}/[^/]+/MEMORY-FULL\\.md`,
    `${escapedBase}/[^/]+/memory-full`,
  ];

  for (const regexStr of protectedPaths) {
    const regex = new RegExp(`^${regexStr}`);
    if (regex.test(normalizedFile)) {
      return true;
    }
  }

  // Also check for direct "full" history paths
  if (
    normalizedFile.includes("/sessions/full/") ||
    normalizedFile.includes("/memory-full/") ||
    normalizedFile.endsWith("/MEMORY-FULL.md")
  ) {
    return true;
  }

  return false;
}

/**
 * Resolve the default base URL for a provider based on its name and API type.
 */
export function resolveDefaultBaseUrl(provider: string, api?: string): string {
  const p = provider.toLowerCase();
  const a = (api ?? "").toLowerCase();
  if (
    p === "google" ||
    p.includes("gemini") ||
    p.includes("vertex") ||
    a.includes("google") ||
    a.includes("gemini")
  ) {
    return "https://generativelanguage.googleapis.com/v1beta";
  }
  if (p === "anthropic" || a === "anthropic-messages") {
    return "https://api.anthropic.com";
  }
  return "https://api.openai.com/v1";
}
