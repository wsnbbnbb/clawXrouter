import type {
  DetectionContext,
  DetectionResult,
  PrivacyConfig,
  SensitivityLevel,
} from "./types.js";
import { levelToNumeric, maxLevel } from "./types.js";
import { extractPathsFromParams, matchesPathPattern } from "./utils.js";

/** Cache compiled regex patterns to avoid re-compilation on every call */
const PATTERN_CACHE_MAX = 500;
const patternCache = new Map<string, RegExp>();

function getOrCompileRegex(pattern: string): RegExp | null {
  const cached = patternCache.get(pattern);
  if (cached) return cached;
  try {
    // Strip Python-style inline flags (?i), (?s), (?m) etc. — JS uses RegExp flags instead
    let flags = "i";
    const cleaned = pattern.replace(/^\(\?([gimsuy]+)\)/, (_m, f: string) => {
      flags = f.includes("i") ? "i" : "";
      if (f.includes("s")) flags += "s";
      if (f.includes("m")) flags += "m";
      return "";
    });
    const compiled = new RegExp(cleaned, flags);
    if (patternCache.size >= PATTERN_CACHE_MAX) {
      const firstKey = patternCache.keys().next().value;
      if (firstKey !== undefined) patternCache.delete(firstKey);
    }
    patternCache.set(pattern, compiled);
    return compiled;
  } catch (err) {
    console.warn(`[ClawXrouter] Invalid regex pattern: ${pattern} — ${(err as Error).message}`);
    return null;
  }
}

/**
 * Detect sensitivity level based on configured rules
 */
export function detectByRules(context: DetectionContext, config: PrivacyConfig): DetectionResult {
  const levels: SensitivityLevel[] = [];
  const reasons: string[] = [];

  // 1. Check keywords in message
  if (context.message) {
    const keywordResult = checkKeywords(context.message, config);
    if (keywordResult.level !== "S1") {
      levels.push(keywordResult.level);
      if (keywordResult.reason) {
        reasons.push(keywordResult.reason);
      }
    }
  }

  // 2. Check regex patterns in message
  if (context.message) {
    const patternResult = checkPatterns(context.message, config);
    if (patternResult.level !== "S1") {
      levels.push(patternResult.level);
      if (patternResult.reason) {
        reasons.push(patternResult.reason);
      }
    }
  }

  // 3. Check tool type and parameters
  if (context.toolName) {
    const toolResult = checkToolType(context.toolName, config);
    if (toolResult.level !== "S1") {
      levels.push(toolResult.level);
      if (toolResult.reason) {
        reasons.push(toolResult.reason);
      }
    }
  }

  // 4. Check tool parameters (paths, etc.)
  if (context.toolParams) {
    const paramResult = checkToolParams(context.toolParams, config);
    if (paramResult.level !== "S1") {
      levels.push(paramResult.level);
      if (paramResult.reason) {
        reasons.push(paramResult.reason);
      }
    }
  }

  // 5. Check tool result content (keywords + patterns)
  if (context.toolResult) {
    const resultText =
      typeof context.toolResult === "string"
        ? context.toolResult
        : JSON.stringify(context.toolResult);
    const resultKeywordLevel = checkKeywords(resultText, config);
    if (resultKeywordLevel.level !== "S1") {
      levels.push(resultKeywordLevel.level);
      if (resultKeywordLevel.reason) {
        reasons.push(`Result: ${resultKeywordLevel.reason}`);
      }
    }
    const resultPatternLevel = checkPatterns(resultText, config);
    if (resultPatternLevel.level !== "S1") {
      levels.push(resultPatternLevel.level);
      if (resultPatternLevel.reason) {
        reasons.push(`Result: ${resultPatternLevel.reason}`);
      }
    }
  }

  // Determine final level (max of all checks)
  const finalLevel = levels.length > 0 ? maxLevel(...levels) : "S1";
  const finalReason = reasons.length > 0 ? reasons.join("; ") : undefined;

  return {
    level: finalLevel,
    levelNumeric: levelToNumeric(finalLevel),
    reason: finalReason,
    detectorType: "ruleDetector",
    confidence: 1.0, // Rules have high confidence
  };
}

/**
 * Build a keyword-aware regex that matches the keyword at word-like boundaries.
 *
 * For keywords starting with "." (file extensions like ".env", ".key"):
 *   The "." itself is a boundary, so only check that the tail is NOT followed
 *   by an alphanumeric char.  "file.env" matches, ".envelope" does not.
 *
 * For plain-word keywords:
 *   Negative lookbehind/lookahead on alphanumeric chars so "token" matches
 *   "auth_token" and "the token" but NOT "tokenize".
 */
const keywordRegexCache = new Map<string, RegExp>();

export function getKeywordRegex(keyword: string): RegExp {
  const cached = keywordRegexCache.get(keyword);
  if (cached) return cached;

  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let pattern: string;
  if (keyword.startsWith(".")) {
    pattern = `${escaped}(?![a-zA-Z0-9])`;
  } else {
    pattern = `(?<![a-zA-Z0-9])${escaped}(?![a-zA-Z0-9])`;
  }
  const re = new RegExp(pattern, "i");
  keywordRegexCache.set(keyword, re);
  return re;
}

/**
 * Check for sensitive keywords in text
 */
function checkKeywords(
  text: string,
  config: PrivacyConfig,
): { level: SensitivityLevel; reason?: string } {
  // Check S3 keywords first (higher priority)
  const s3Keywords = config.rules?.keywords?.S3 ?? [];
  for (const keyword of s3Keywords) {
    if (getKeywordRegex(keyword).test(text)) {
      return {
        level: "S3",
        reason: `S3 keyword detected: ${keyword}`,
      };
    }
  }

  // Check S2 keywords
  const s2Keywords = config.rules?.keywords?.S2 ?? [];
  for (const keyword of s2Keywords) {
    if (getKeywordRegex(keyword).test(text)) {
      return {
        level: "S2",
        reason: `S2 keyword detected: ${keyword}`,
      };
    }
  }

  return { level: "S1" };
}

/**
 * Check for sensitive content using regex patterns
 */
function checkPatterns(
  text: string,
  config: PrivacyConfig,
): { level: SensitivityLevel; reason?: string } {
  // Check S3 patterns first (higher priority)
  const s3Patterns = config.rules?.patterns?.S3 ?? [];
  for (const pattern of s3Patterns) {
    const regex = getOrCompileRegex(pattern);
    if (regex && regex.test(text)) {
      return {
        level: "S3",
        reason: `S3 pattern matched: ${pattern}`,
      };
    }
  }

  // Check S2 patterns
  const s2Patterns = config.rules?.patterns?.S2 ?? [];
  for (const pattern of s2Patterns) {
    const regex = getOrCompileRegex(pattern);
    if (regex && regex.test(text)) {
      return {
        level: "S2",
        reason: `S2 pattern matched: ${pattern}`,
      };
    }
  }

  return { level: "S1" };
}

/**
 * Check if `name` contains `segment` as a whole word delimited by common
 * tool-name separators (`.`, `_`, `-`) or string boundaries.
 * Prevents "pseudocode_generator" matching "sudo", "powershell" matching "shell", etc.
 */
function toolNameContainsSegment(name: string, segment: string): boolean {
  const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[._\\-])${escaped}(?:$|[._\\-])`, "i");
  return re.test(name);
}

/**
 * Check tool type against configured sensitive tools
 */
function checkToolType(
  toolName: string,
  config: PrivacyConfig,
): { level: SensitivityLevel; reason?: string } {
  const normalizedTool = toolName.toLowerCase();

  // Check S3 tools first (higher priority)
  const s3Tools = config.rules?.tools?.S3?.tools ?? [];
  for (const tool of s3Tools) {
    const pattern = tool.toLowerCase();
    if (normalizedTool === pattern || toolNameContainsSegment(normalizedTool, pattern)) {
      return {
        level: "S3",
        reason: `S3 tool detected: ${toolName}`,
      };
    }
  }

  // Check S2 tools
  const s2Tools = config.rules?.tools?.S2?.tools ?? [];
  for (const tool of s2Tools) {
    const pattern = tool.toLowerCase();
    if (normalizedTool === pattern || toolNameContainsSegment(normalizedTool, pattern)) {
      return {
        level: "S2",
        reason: `S2 tool detected: ${toolName}`,
      };
    }
  }

  return { level: "S1" };
}

/**
 * Check tool parameters for sensitive paths or values
 */
function checkToolParams(
  params: Record<string, unknown>,
  config: PrivacyConfig,
): { level: SensitivityLevel; reason?: string } {
  const paths = extractPathsFromParams(params);

  if (paths.length === 0) {
    return { level: "S1" };
  }

  // Check S3 paths first (higher priority)
  const s3Paths = config.rules?.tools?.S3?.paths ?? [];
  for (const path of paths) {
    if (matchesPathPattern(path, s3Paths)) {
      return {
        level: "S3",
        reason: `S3 path detected: ${path}`,
      };
    }
  }

  // Check S2 paths
  const s2Paths = config.rules?.tools?.S2?.paths ?? [];
  for (const path of paths) {
    if (matchesPathPattern(path, s2Paths)) {
      return {
        level: "S2",
        reason: `S2 path detected: ${path}`,
      };
    }
  }

  // Check for common sensitive file extensions
  for (const path of paths) {
    const lowerPath = path.toLowerCase();
    if (
      lowerPath.endsWith(".pem") ||
      lowerPath.endsWith(".key") ||
      lowerPath.endsWith(".p12") ||
      lowerPath.endsWith(".pfx") ||
      lowerPath.includes("id_rsa") ||
      lowerPath.includes("id_dsa") ||
      lowerPath.includes("id_ecdsa") ||
      lowerPath.includes("id_ed25519")
    ) {
      return {
        level: "S3",
        reason: `Sensitive file extension detected: ${path}`,
      };
    }
  }

  return { level: "S1" };
}
