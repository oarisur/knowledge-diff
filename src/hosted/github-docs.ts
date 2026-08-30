import { minimatch } from "minimatch";
import { withRetry } from "../llm-client";
import type { AnalysisError } from "../types";
import type { OctokitClient } from "./github-auth";

export interface DocumentationFetchResult {
  files: Array<{ filePath: string; content: string }>;
  errors: AnalysisError[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapWithConcurrency<T>(
  values: string[],
  concurrency: number,
  operation: (value: string) => Promise<T>
): Promise<T[]> {
  const results: T[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await operation(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  );
  return results;
}

export async function fetchDocumentationFiles(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  ref: string,
  globs: string[],
  maxDocFiles: number
): Promise<DocumentationFetchResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: treeData } = await withRetry<any>(
    () =>
      octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: ref,
        recursive: "1",
      }),
    `hosted:getTree:${owner}/${repo}`
  );

  const errors: AnalysisError[] = [];
  if (treeData.truncated) {
    errors.push({
      filePath: "*",
      message: "GitHub returned a truncated repository tree; configured docs may be missing.",
    });
  }

  const matchedPaths = treeData.tree
    .filter(
      (item: { type?: string; path?: string }) =>
        item.type === "blob" &&
        Boolean(item.path) &&
        globs.some((glob) => minimatch(item.path!, glob, { matchBase: true, dot: true }))
    )
    .map((item: { path: string }) => item.path)
    .sort();

  if (matchedPaths.length > maxDocFiles) {
    errors.push({
      filePath: "*",
      message: `${matchedPaths.length} documentation files matched, exceeding max-doc-files ${maxDocFiles}; only the first ${maxDocFiles} were loaded.`,
    });
  }

  const selectedPaths = matchedPaths.slice(0, maxDocFiles);
  const fetched = await mapWithConcurrency(selectedPaths, 5, async (filePath) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await withRetry<any>(
        () => octokit.rest.repos.getContent({ owner, repo, path: filePath, ref }),
        `hosted:getContent:${owner}/${repo}/${filePath}`
      );
      if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
        throw new Error("GitHub did not return inline file content.");
      }
      const content = Buffer.from(data.content, "base64").toString("utf8");
      if (Buffer.byteLength(content, "utf8") > 1_048_576) {
        throw new Error("Documentation file exceeds the 1 MiB hosted limit.");
      }
      return { filePath, content, error: null };
    } catch (error) {
      return {
        filePath,
        content: null,
        error: `Could not fetch documentation file: ${message(error)}`,
      };
    }
  });

  const files: DocumentationFetchResult["files"] = [];
  for (const item of fetched) {
    if (item.content !== null) files.push({ filePath: item.filePath, content: item.content });
    else if (item.error) errors.push({ filePath: item.filePath, message: item.error });
  }
  return { files, errors };
}
