// ─── Action Configuration ────────────────────────────────────────────────────

export type LLMProvider = "openai" | "anthropic" | "gemini";
export type Sensitivity = "low" | "medium" | "high";
export type CommentMode = "update" | "new";

export interface ActionInputs {
  githubToken: string;
  llmProvider: LLMProvider;
  llmApiKey: string;
  llmModel: string;
  docGlobs: string[];
  codeExtensions: string[];
  sensitivity: Sensitivity;
  autoPatch: boolean;
  commentMode: CommentMode;
  maxFilesPerRun: number;
}

// ─── Pull Request Context ─────────────────────────────────────────────────────

export interface PRContext {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  headRef: string;
  headOwner: string; // may differ from owner on forks
}

// ─── Diff Parsing ─────────────────────────────────────────────────────────────

export interface ChangedFile {
  /** Relative path from repo root */
  filePath: string;
  /** Raw unified-diff patch for this file */
  patch: string;
  /** Lines that were removed */
  deletions: string[];
  /** Lines that were added */
  additions: string[];
  /** Detected function/class/symbol names that appear in the changed lines */
  changedSymbols: string[];
  /** String literal values found in the changed lines (e.g., model names, URLs, config values) */
  changedLiterals: string[];
  /** Total tokens estimate (chars / 4) */
  tokenEstimate: number;
}

// ─── Documentation ───────────────────────────────────────────────────────────

export interface DocSection {
  /** Path of the doc file, relative to repo root */
  filePath: string;
  /** Heading text (e.g. "## State Management") */
  heading: string;
  /** Full markdown content of this section */
  content: string;
  /** Keywords extracted from heading + code spans */
  keywords: string[];
  /** Heading level (1-6) */
  level: number;
}

export interface DocFile {
  filePath: string;
  rawContent: string;
  sections: DocSection[];
}

// ─── Drift Detection ──────────────────────────────────────────────────────────

export interface DriftCandidate {
  changedFile: ChangedFile;
  matchedSection: DocSection;
  /** Relevance score 0-1 based on keyword overlap */
  relevanceScore: number;
}

export interface DriftResult {
  changedFile: ChangedFile;
  matchedSection: DocSection;
  /** Whether the LLM determined drift exists */
  isDrift: boolean;
  /**
   * Confidence level:
   * - 'definite' → clear contradiction
   * - 'likely'   → probably outdated
   * - 'possible' → ambiguous, might be fine
   */
  confidence: "definite" | "likely" | "possible";
  /** Human-readable explanation of what is contradicted */
  explanation: string;
  /** The exact doc text that is now incorrect */
  staleText?: string;
  /** Suggested replacement for the stale text */
  suggestedText?: string;
  /** Whether this result should be shown given the current sensitivity */
  meetsThreshold: boolean;
}

export interface AnalysisResult {
  driftResults: DriftResult[];
  skippedFiles: string[];
  checkedFiles: number;
  docFilesChecked: string[];
  totalCandidates: number;
}

// ─── Doc Patching ────────────────────────────────────────────────────────────

export interface DocPatch {
  filePath: string;
  originalContent: string;
  patchedContent: string;
}

export interface PatchPRResult {
  patchBranch: string;
  patchPRNumber: number;
  patchPRUrl: string;
}

// ─── LLM ─────────────────────────────────────────────────────────────────────

export interface LLMDriftResponse {
  isDrift: boolean;
  confidence: "definite" | "likely" | "possible";
  explanation: string;
  staleText?: string;
  suggestedText?: string;
}
