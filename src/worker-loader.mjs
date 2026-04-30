/**
 * Minimal ESM resolve hook that maps .js imports to .ts files
 * when the .js file does not exist on disk.
 *
 * Needed because Node.js v25 strips TS types natively but does NOT
 * rewrite ".js" → ".ts" in import specifiers the way tsx/ts-node do.
 * Worker threads spawned by synckit therefore fail to resolve
 * co-located .ts modules imported via the conventional ".js" extension.
 */
import { register } from "node:module";

const hooks = [
  "export async function resolve(specifier, context, nextResolve) {",
  "  if (specifier.endsWith('.js') && !specifier.startsWith('node:')) {",
  "    try {",
  "      return await nextResolve(specifier.replace(/\\.js$/, '.ts'), context);",
  "    } catch {",
  "      // .ts variant not found — fall through to original specifier",
  "    }",
  "  }",
  "  return nextResolve(specifier, context);",
  "}",
].join("\n");

register("data:text/javascript," + encodeURIComponent(hooks), import.meta.url);
