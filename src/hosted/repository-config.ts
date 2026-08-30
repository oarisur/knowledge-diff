import { minimatch } from "minimatch";
import { parse } from "yaml";
import type { OctokitClient } from "./github-auth";
import type { LLMProvider, Sensitivity } from "../types";
import type { RepositoryConfig } from "./types";

export const REPOSITORY_CONFIG_PATH = ".github/knowledge-diff.yml";

export const DEFAULT_DOC_GLOBS = [
  "README.md",
  "ARCHITECTURE.md",
  "docs/**/*.md",
  "**/AGENTS.md",
  "**/AGENTS.override.md",
  "**/CLAUDE.md",
  "**/GEMINI.md",
  ".github/copilot-instructions.md",
  ".github/instructions/**/*.instructions.md",
  ".cursor/rules/**/*.mdc",
  ".windsurfrules",
  ".clinerules",
  ".clinerules/**/*.md",
  ".roo/rules/**/*.md",
];

export const DEFAULT_CODE_EXTENSIONS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "go",
  "rs",
  "java",
  "cpp",
  "c",
  "rb",
  "php",
  "swift",
  "kt",
];

const CONFIG_KEYS = new Set([
  "enabled",
  "provider",
  "model",
  "sensitivity",
  "doc-files",
  "code-extensions",
  "max-files-per-run",
  "max-doc-files",
  "comment-mode",
  "fail-on-drift",
  "skip-drafts",
  "ignore-authors",
  "ignore-branches",
]);

function defaultConfig(defaultProvider: LLMProvider): RepositoryConfig {
  return {
    enabled: true,
    provider: defaultProvider,
    model: "",
    sensitivity: "medium",
    docGlobs: [...DEFAULT_DOC_GLOBS],
    codeExtensions: [...DEFAULT_CODE_EXTENSIONS],
    maxFilesPerRun: 20,
    maxDocFiles: 100,
    commentMode: "update",
    failOnDrift: false,
    skipDrafts: true,
    ignoredAuthors: ["dependabot[bot]"],
    ignoredBranches: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function booleanValue(
  object: Record<string, unknown>,
  key: string,
  fallback: boolean
): boolean {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${key} must be true or false.`);
  return value;
}

function stringValue(
  object: Record<string, unknown>,
  key: string,
  fallback: string
): string {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  return value.trim();
}

function stringArray(
  object: Record<string, unknown>,
  key: string,
  fallback: string[],
  allowEmpty = false
): string[] {
  const value = object[key];
  if (value === undefined) return [...fallback];
  const entries =
    typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : null;
  if (!entries || entries.some((entry) => typeof entry !== "string")) {
    throw new Error(`${key} must be a string or an array of strings.`);
  }
  const normalized = entries.map((entry) => entry.trim()).filter(Boolean);
  if (normalized.length === 0 && !allowEmpty) throw new Error(`${key} must not be empty.`);
  return normalized;
}

function integerValue(
  object: Record<string, unknown>,
  key: string,
  fallback: number,
  maximum: number
): number {
  const value = object[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${key} must be an integer between 1 and ${maximum}.`);
  }
  return value as number;
}

export function parseRepositoryConfig(
  yaml: string,
  defaultProvider: LLMProvider
): { config: RepositoryConfig; warnings: string[] } {
  const defaults = defaultConfig(defaultProvider);
  const parsed: unknown = parse(yaml);
  if (parsed === null || parsed === undefined) return { config: defaults, warnings: [] };
  if (!isRecord(parsed)) throw new Error("Repository configuration must be a YAML object.");

  const warnings = Object.keys(parsed)
    .filter((key) => !CONFIG_KEYS.has(key))
    .map((key) => `Unknown repository configuration key: ${key}`);
  const provider = stringValue(parsed, "provider", defaults.provider) as LLMProvider;
  if (!["openai", "anthropic", "gemini"].includes(provider)) {
    throw new Error("provider must be openai, anthropic, or gemini.");
  }
  const sensitivity = stringValue(
    parsed,
    "sensitivity",
    defaults.sensitivity
  ) as Sensitivity;
  if (!["low", "medium", "high"].includes(sensitivity)) {
    throw new Error("sensitivity must be low, medium, or high.");
  }
  const commentMode = stringValue(parsed, "comment-mode", defaults.commentMode);
  if (!["update", "new"].includes(commentMode)) {
    throw new Error("comment-mode must be update or new.");
  }

  return {
    config: {
      enabled: booleanValue(parsed, "enabled", defaults.enabled),
      provider,
      model: stringValue(parsed, "model", defaults.model),
      sensitivity,
      docGlobs: stringArray(parsed, "doc-files", defaults.docGlobs),
      codeExtensions: stringArray(
        parsed,
        "code-extensions",
        defaults.codeExtensions
      ).map((extension) => extension.replace(/^\./, "").toLowerCase()),
      maxFilesPerRun: integerValue(
        parsed,
        "max-files-per-run",
        defaults.maxFilesPerRun,
        100
      ),
      maxDocFiles: integerValue(
        parsed,
        "max-doc-files",
        defaults.maxDocFiles,
        500
      ),
      commentMode: commentMode as "update" | "new",
      failOnDrift: booleanValue(parsed, "fail-on-drift", defaults.failOnDrift),
      skipDrafts: booleanValue(parsed, "skip-drafts", defaults.skipDrafts),
      ignoredAuthors: stringArray(
        parsed,
        "ignore-authors",
        defaults.ignoredAuthors,
        true
      ).map((author) => author.toLowerCase()),
      ignoredBranches: stringArray(
        parsed,
        "ignore-branches",
        defaults.ignoredBranches,
        true
      ),
    },
    warnings,
  };
}

export async function loadRepositoryConfig(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  trustedRef: string,
  defaultProvider: LLMProvider
): Promise<{ config: RepositoryConfig; warnings: string[]; found: boolean }> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: REPOSITORY_CONFIG_PATH,
      ref: trustedRef,
    });
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
      throw new Error(`${REPOSITORY_CONFIG_PATH} is not a regular file.`);
    }
    const yaml = Buffer.from(data.content, "base64").toString("utf8");
    return { ...parseRepositoryConfig(yaml, defaultProvider), found: true };
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? (error as { status?: unknown }).status
        : undefined;
    if (status === 404) {
      return { config: defaultConfig(defaultProvider), warnings: [], found: false };
    }
    throw error;
  }
}

export function shouldSkipPullRequest(
  config: RepositoryConfig,
  draft: boolean,
  author: string,
  branch: string
): string | null {
  if (!config.enabled) return "repository configuration disabled analysis";
  if (config.skipDrafts && draft) return "draft pull request";
  if (config.ignoredAuthors.includes(author.toLowerCase())) return `ignored author ${author}`;
  if (config.ignoredBranches.some((pattern) => minimatch(branch, pattern))) {
    return `ignored branch ${branch}`;
  }
  return null;
}
