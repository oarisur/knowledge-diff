import * as core from "@actions/core";
import type { ChangedFile } from "./types";

// ─── Symbol Detection Patterns ────────────────────────────────────────────────

// Matches function/class/method declarations across common languages
const SYMBOL_PATTERNS: RegExp[] = [
  // TypeScript / JavaScript
  /(?:function|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
  // Arrow functions assigned to a const: `const myFn = (...) =>`
  /([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(/g,
  // Python
  /(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  // Go
  /func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)/g,
  // Rust
  /(?:fn|struct|impl|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  // Java / Kotlin
  /(?:class|interface|fun|void|public|private|protected)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[({]/g,
];

// ─── Parse Unified Diff Lines ─────────────────────────────────────────────────

function parsePatchLines(patch: string): {
  additions: string[];
  deletions: string[];
} {
  const additions: string[] = [];
  const deletions: string[] = [];

  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions.push(line.slice(1));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions.push(line.slice(1));
    }
  }

  return { additions, deletions };
}

// ─── Symbol Extraction ────────────────────────────────────────────────────────

function extractSymbols(lines: string[]): string[] {
  const symbols = new Set<string>();
  const text = lines.join("\n");

  for (const pattern of SYMBOL_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1];
      // Filter out noise: short names, JS keywords, etc.
      if (name && name.length > 2 && !JS_KEYWORDS.has(name)) {
        symbols.add(name);
      }
    }
  }

  return Array.from(symbols);
}

// Common keywords to exclude from symbol detection
const JS_KEYWORDS = new Set([
  "if", "for", "let", "var", "new", "try", "get", "set", "use",
  "from", "import", "export", "return", "const", "class", "async",
  "await", "true", "false", "null", "undefined", "this", "super",
]);

// ─── String Literal Extraction ────────────────────────────────────────────────

/**
 * Captures quoted string values from changed lines.
 * Matches strings like "gpt-4o-mini", 'openai', "/api/v2/users", etc.
 * Minimum length 3, must start with alphanumeric to filter punctuation-only values.
 */
const STRING_LITERAL_RE = /["']([a-zA-Z0-9/][a-zA-Z0-9_./@:-]{2,})["']/g;

/** Common non-architectural strings to ignore during literal extraction. */
const LITERAL_STOPWORDS = new Set([
  "use strict", "utf-8", "utf8", "ascii", "base64", "hex",
  "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS",
  "get", "post", "put", "delete", "patch", "head", "options",
  "text/plain", "text/html", "application/json",
  "Content-Type", "content-type", "Authorization", "authorization",
  "string", "number", "boolean", "object", "function",
  "node_modules", "package.json", "tsconfig.json",
  "click", "submit", "change", "input", "keydown", "keyup",
  "div", "span", "button", "form", "table",
]);

/**
 * Extract meaningful string literal values from changed lines.
 * These capture configuration values, model names, URLs, library names, etc.
 */
export function extractStringLiterals(lines: string[]): string[] {
  const literals = new Set<string>();
  const text = lines.join("\n");

  STRING_LITERAL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STRING_LITERAL_RE.exec(text)) !== null) {
    const value = match[1];
    if (!LITERAL_STOPWORDS.has(value)) {
      literals.add(value);
    }
  }

  return Array.from(literals);
}

// ─── File Extension Check ─────────────────────────────────────────────────────

export function isCodeFile(
  filePath: string,
  allowedExtensions: string[]
): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return allowedExtensions.includes(ext);
}

// ─── Token Estimate ───────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Main Parser ──────────────────────────────────────────────────────────────

/**
 * Converts raw GitHub PR file list into structured ChangedFile objects.
 * The `files` parameter should come from `octokit.pulls.listFiles()`.
 */
export function parsePRFiles(
  files: Array<{ filename: string; patch?: string; status: string }>,
  allowedExtensions: string[],
  maxFiles: number
): { changedFiles: ChangedFile[]; skippedFiles: string[] } {
  const changedFiles: ChangedFile[] = [];
  const skippedFiles: string[] = [];

  let processed = 0;

  for (const file of files) {
    // Skip deletions — no point checking docs for removed code
    if (file.status === "removed") {
      skippedFiles.push(`${file.filename} (deleted)`);
      continue;
    }

    if (!isCodeFile(file.filename, allowedExtensions)) {
      continue; // silently skip non-code files (doc files themselves, images, etc.)
    }

    if (!file.patch) {
      core.debug(`No patch data for ${file.filename}, skipping.`);
      skippedFiles.push(`${file.filename} (no patch data)`);
      continue;
    }

    if (processed >= maxFiles) {
      skippedFiles.push(`${file.filename} (max-files-per-run limit reached)`);
      continue;
    }

    const { additions, deletions } = parsePatchLines(file.patch);

    // Only extract symbols from *changed* lines (not context lines)
    const changedLines = [...additions, ...deletions];
    const changedSymbols = extractSymbols(changedLines);
    const changedLiterals = extractStringLiterals(changedLines);

    changedFiles.push({
      filePath: file.filename,
      patch: file.patch,
      additions,
      deletions,
      changedSymbols,
      changedLiterals,
      tokenEstimate: estimateTokens(file.patch),
    });

    processed++;
  }

  core.info(
    `Diff parser: ${changedFiles.length} code files to analyse, ${skippedFiles.length} skipped.`
  );

  return { changedFiles, skippedFiles };
}
