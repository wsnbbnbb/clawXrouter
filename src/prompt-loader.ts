import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the prompts/ directory.
 * Works whether running from source (src/) or compiled output (dist/src/).
 */
function resolvePromptsDir(): string {
  const candidates = [
    resolve(__dirname, "../prompts"), // from src/  → prompts/
    resolve(__dirname, "../../prompts"), // from dist/src/ → prompts/
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0]; // fallback, will trigger per-file fallback
}

const PROMPTS_DIR = resolvePromptsDir();

/** Cache loaded prompts in memory — invalidated on dashboard save */
const cache = new Map<string, string>();

/**
 * Load a prompt template from `prompts/{name}.md`.
 * Returns the file content if found, otherwise returns the fallback string.
 *
 * Results are cached — the file is read only once per process lifetime.
 */
export function loadPrompt(name: string, fallback: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const filePath = resolve(PROMPTS_DIR, `${name}.md`);
  let content: string;

  try {
    if (existsSync(filePath)) {
      content = readFileSync(filePath, "utf-8").trim();
      console.log(`[ClawXrouter] Loaded custom prompt: prompts/${name}.md`);
    } else {
      content = fallback;
    }
  } catch {
    console.warn(`[ClawXrouter] Failed to read prompts/${name}.md, using default`);
    content = fallback;
  }

  cache.set(name, content);
  return content;
}

/**
 * Load a prompt and replace `{{PLACEHOLDER}}` tokens with provided values.
 */
export function loadPromptWithVars(
  name: string,
  fallback: string,
  vars: Record<string, string>,
): string {
  let prompt = loadPrompt(name, fallback);
  for (const [key, value] of Object.entries(vars)) {
    prompt = prompt.replaceAll(`{{${key}}}`, value);
  }
  return prompt;
}

/** Invalidate a cached prompt so the next loadPrompt() re-reads from disk. */
export function invalidatePrompt(name: string): void {
  cache.delete(name);
}

/**
 * Write a prompt to `prompts/{name}.md` and invalidate its cache.
 * Creates the prompts directory if it doesn't exist.
 */
export function writePrompt(name: string, content: string): void {
  mkdirSync(PROMPTS_DIR, { recursive: true });
  const filePath = resolve(PROMPTS_DIR, `${name}.md`);
  writeFileSync(filePath, content, "utf-8");
  invalidatePrompt(name);
}

/**
 * Read a prompt file directly from disk (bypasses cache).
 * Returns null if the file doesn't exist.
 */
export function readPromptFromDisk(name: string): string | null {
  const filePath = resolve(PROMPTS_DIR, `${name}.md`);
  try {
    if (existsSync(filePath)) {
      return readFileSync(filePath, "utf-8").trim();
    }
  } catch {
    /* file unreadable */
  }
  return null;
}
