import * as core from "@actions/core";
import type { DocFile, DocSection, ChangedFile, DriftCandidate } from "./types";

// ─── Shared Constants ─────────────────────────────────────────────────────────

/** Technology keywords that signal architecture intent. Shared across keyword extraction and candidate matching. */
const TECH_KEYWORD_RE =
  /\b(redux|zustand|mobx|recoil|jotai|react|vue|angular|express|fastapi|django|rails|postgres|mysql|mongodb|graphql|rest|grpc|websocket|kafka|rabbitmq|redis|docker|kubernetes|aws|gcp|azure)\b/gi;

// ─── Markdown Section Splitting ───────────────────────────────────────────────

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/**
 * Split a markdown document into sections by heading.
 * Each section includes its heading and all content up to the next heading of
 * the same or higher level (lower number = higher level).
 */
function splitIntoSections(
  filePath: string,
  content: string
): DocSection[] {
  const lines = content.split("\n");
  const sections: DocSection[] = [];

  // Accumulate current section
  let currentHeading = "(preamble)";
  let currentLevel = 0;
  let currentLines: string[] = [];

  function flushSection() {
    if (currentLines.length === 0 && currentHeading === "(preamble)") return;
    const sectionContent = currentLines.join("\n").trim();
    if (!sectionContent) return;

    sections.push({
      filePath,
      heading: currentHeading,
      content: sectionContent,
      keywords: extractKeywords(currentHeading, sectionContent),
      level: currentLevel,
    });
  }

  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (match) {
      flushSection();
      currentLevel = match[1].length;
      currentHeading = match[2].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  flushSection();
  return sections;
}

// ─── Keyword Extraction ───────────────────────────────────────────────────────

/**
 * Extract meaningful tokens from heading and section content.
 * Tokens come from:
 *  - Heading words (split on non-alpha)
 *  - Inline code spans: `someIdentifier`
 *  - Code block filenames: ```typescript → "typescript"
 *  - Explicit file paths mentioned
 */
/** Common English words that appear in headings/content but carry no architectural signal. */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "have", "been", "some", "them",
  "than", "its", "over", "into", "just", "about", "could", "would", "make",
  "like", "back", "only", "come", "made", "after", "being", "also", "from",
  "using", "used", "with", "this", "that", "will", "each", "which", "their",
  "what", "when", "how", "who", "does", "then", "here", "they", "more",
  "see", "may", "very", "most", "other", "should", "above", "below",
]);

function extractKeywords(heading: string, content: string): string[] {
  const kw = new Set<string>();

  // Words from heading (with stopword filtering)
  for (const word of heading.split(/\W+/)) {
    const lower = word.toLowerCase();
    if (word.length > 2 && !STOPWORDS.has(lower)) kw.add(lower);
  }

  // Inline code spans
  const inlineCode = content.matchAll(/`([^`\n]+)`/g);
  for (const m of inlineCode) {
    // Split on common separators to get individual identifiers
    for (const token of m[1].split(/[\s/.,()[\]{}:;]/)) {
      if (token.length > 2) kw.add(token.toLowerCase());
    }
  }

  // File paths mentioned (e.g., src/store/index.ts)
  const paths = content.matchAll(/\b([\w-]+\/[\w./-]+)\b/g);
  for (const m of paths) {
    kw.add(m[1].toLowerCase());
    // Also add just the filename
    const parts = m[1].split("/");
    const filename = parts[parts.length - 1];
    if (filename) kw.add(filename.toLowerCase());
    // And the directory names
    for (const part of parts.slice(0, -1)) {
      if (part.length > 2) kw.add(part.toLowerCase());
    }
  }

  // Technology keywords — common library/pattern names that signal architecture intent
  for (const m of content.matchAll(TECH_KEYWORD_RE)) {
    kw.add(m[1].toLowerCase());
  }

  return Array.from(kw);
}

// ─── Build Doc Index ──────────────────────────────────────────────────────────

/**
 * Builds an inverted index: keyword → list of sections that mention it.
 * Used for fast candidate lookup.
 */
type DocIndex = Map<string, DocSection[]>;

function buildIndex(docFiles: DocFile[]): DocIndex {
  const index: DocIndex = new Map();

  for (const docFile of docFiles) {
    for (const section of docFile.sections) {
      for (const keyword of section.keywords) {
        if (!index.has(keyword)) index.set(keyword, []);
        index.get(keyword)!.push(section);
      }
    }
  }

  return index;
}

// ─── Candidate Matching ───────────────────────────────────────────────────────

/**
 * Returns the top-N most relevant doc sections for a given changed file.
 * Relevance is measured by keyword overlap between the changed file's
 * path/symbols and the doc section's keywords.
 */
export function findCandidateSections(
  changedFile: ChangedFile,
  index: DocIndex,
  topN = 3
): DriftCandidate[] {
  const scoreMap = new Map<DocSection, number>();

  // Build a set of query terms from the changed file
  const queryTerms = new Set<string>();

  // File path components
  for (const part of changedFile.filePath.split(/[/\\.,]/)) {
    if (part.length > 2) queryTerms.add(part.toLowerCase());
  }

  // Changed symbol names
  for (const sym of changedFile.changedSymbols) {
    queryTerms.add(sym.toLowerCase());
    // Also add camelCase sub-words: "cartReducer" → ["cart", "reducer"]
    for (const word of sym.replace(/([A-Z])/g, " $1").split(" ")) {
      if (word.length > 2) queryTerms.add(word.toLowerCase());
    }
  }

  // Content of added/deleted lines for tech keyword detection
  const changeText = [
    ...changedFile.additions,
    ...changedFile.deletions,
  ].join(" ");

  for (const m of changeText.matchAll(TECH_KEYWORD_RE)) {
    queryTerms.add(m[1].toLowerCase());
  }

  // Score sections by how many query terms they match
  for (const term of queryTerms) {
    const sections = index.get(term) ?? [];
    for (const section of sections) {
      scoreMap.set(section, (scoreMap.get(section) ?? 0) + 1);
    }
  }

  if (scoreMap.size === 0) return [];

  // Sort by score descending, normalise to 0-1
  const maxScore = Math.max(...scoreMap.values());
  const sorted = Array.from(scoreMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);

  return sorted.map(([section, score]) => ({
    changedFile,
    matchedSection: section,
    relevanceScore: score / maxScore,
  }));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function buildDocIndex(docFiles: DocFile[]): DocIndex {
  return buildIndex(docFiles);
}

export type { DocIndex };

/**
 * Parse a raw markdown string into a DocFile with sections and keywords.
 */
export function parseDocFile(filePath: string, rawContent: string): DocFile {
  core.debug(`Parsing doc file: ${filePath}`);
  const sections = splitIntoSections(filePath, rawContent);
  core.debug(`  → ${sections.length} sections`);
  return { filePath, rawContent, sections };
}
