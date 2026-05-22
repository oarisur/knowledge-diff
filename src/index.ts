import * as core from "@actions/core";
import * as github from "@actions/github";
import type { GitHub } from "@actions/github/lib/utils";
import { minimatch } from "minimatch";

import type { ActionInputs, PRContext, LLMProvider } from "./types";
import { parsePRFiles } from "./diff-parser";
import { LLMClient, withRetry } from "./llm-client";
import { DriftDetector } from "./drift-detector";
import { PRCommenter } from "./pr-commenter";
import { DocPatcher } from "./doc-patcher";

// ─── Input Parsing ────────────────────────────────────────────────────────────

function parseInputs(): ActionInputs {
  const llmProvider = core.getInput("llm-provider") as LLMProvider;
  if (!["openai", "anthropic", "gemini"].includes(llmProvider)) {
    throw new Error(`Invalid llm-provider: "${llmProvider}". Must be "openai", "anthropic", or "gemini".`);
  }

  const apiKey =
    llmProvider === "openai"
      ? core.getInput("openai-api-key")
      : llmProvider === "anthropic"
      ? core.getInput("anthropic-api-key")
      : core.getInput("gemini-api-key");

  if (!apiKey) {
    throw new Error(
      `API key for "${llmProvider}" is required. Set the "${
        llmProvider === "openai"
          ? "openai-api-key"
          : llmProvider === "anthropic"
          ? "anthropic-api-key"
          : "gemini-api-key"
      }" input.`
    );
  }

  // Mask the key so it's redacted if it ever appears in logs
  core.setSecret(apiKey);

  const sensitivity = core.getInput("sensitivity") as ActionInputs["sensitivity"];
  if (!["low", "medium", "high"].includes(sensitivity)) {
    throw new Error(`Invalid sensitivity: "${sensitivity}". Must be "low", "medium", or "high".`);
  }

  const commentMode = core.getInput("comment-mode") as ActionInputs["commentMode"];
  if (!["update", "new"].includes(commentMode)) {
    throw new Error(`Invalid comment-mode: "${commentMode}". Must be "update" or "new".`);
  }

  const MAX_FILES_ABSOLUTE_LIMIT = 100;
  const maxFilesRaw = parseInt(core.getInput("max-files-per-run") || "20", 10);
  if (isNaN(maxFilesRaw) || maxFilesRaw < 1) {
    throw new Error(
      `Invalid max-files-per-run: "${core.getInput("max-files-per-run")}". Must be a positive integer.`
    );
  }
  const maxFilesPerRun = Math.min(maxFilesRaw, MAX_FILES_ABSOLUTE_LIMIT);

  return {
    githubToken: core.getInput("github-token", { required: true }),
    llmProvider,
    llmApiKey: apiKey,
    llmModel: core.getInput("llm-model") || "",
    docGlobs: core
      .getInput("doc-files")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    codeExtensions: core
      .getInput("code-extensions")
      .split(",")
      .map((s) => s.trim().replace(/^\./, ""))
      .filter(Boolean),
    sensitivity,
    autoPatch: core.getBooleanInput("auto-patch"),
    commentMode,
    maxFilesPerRun,
  };
}

// ─── PR Context Extraction ────────────────────────────────────────────────────

function getPRContext(): PRContext {
  const { context } = github;

  if (context.eventName !== "pull_request") {
    throw new Error(
      `knowledge-diff must be triggered by a pull_request event. Got: ${context.eventName}`
    );
  }

  const pr = context.payload.pull_request!;
  return {
    owner: context.repo.owner,
    repo: context.repo.repo,
    prNumber: pr.number,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    headOwner: pr.head.repo?.owner?.login ?? context.repo.owner,
  };
}

// ─── Fetch Doc Files via GitHub API ──────────────────────────────────────────

async function fetchDocFiles(
  octokit: InstanceType<typeof GitHub>,
  owner: string,
  repo: string,
  ref: string,
  globs: string[]
): Promise<Array<{ filePath: string; content: string }>> {
  // First, get the full file tree at the base ref
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: treeData } = await withRetry<any>(
    () =>
      octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: ref,
        recursive: "1",
      }),
    `getTree:${owner}/${repo}`
  );

  const docFiles: Array<{ filePath: string; content: string }> = [];

  for (const item of treeData.tree) {
    if (item.type !== "blob" || !item.path) continue;

    // Check if this file matches any of the configured globs
    const matchesGlob = globs.some((glob) =>
      minimatch(item.path!, glob, { matchBase: true, dot: true })
    );

    if (!matchesGlob) continue;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: fileData } = await withRetry<any>(
        () =>
          octokit.rest.repos.getContent({
            owner,
            repo,
            path: item.path!,
            ref,
          }),
        `getContent:${item.path}`
      );

      if (
        !Array.isArray(fileData) &&
        fileData.type === "file" &&
        "content" in fileData
      ) {
        const content = Buffer.from(fileData.content, "base64").toString("utf-8");
        docFiles.push({ filePath: item.path, content });
        core.debug(`Loaded doc file: ${item.path} (${content.length} chars)`);
      }
    } catch (err) {
      core.warning(`Could not fetch doc file ${item.path}: ${err}`);
    }
  }

  core.info(`Loaded ${docFiles.length} documentation file(s).`);
  return docFiles;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  try {
    // 1. Parse inputs
    const inputs = parseInputs();
    core.info(
      `knowledge-diff starting (provider: ${inputs.llmProvider}, sensitivity: ${inputs.sensitivity}, auto-patch: ${inputs.autoPatch})`
    );

    // 2. Initialise clients
    const octokit = github.getOctokit(inputs.githubToken);
    const ctx = getPRContext();
    core.info(
      `PR #${ctx.prNumber} in ${ctx.owner}/${ctx.repo} (${ctx.headRef} → ${ctx.baseRef})`
    );

    // 3. Fetch PR diff
    core.info("Fetching PR file list…");
    const prFiles = await octokit.paginate(
      octokit.rest.pulls.listFiles,
      {
        owner: ctx.owner,
        repo: ctx.repo,
        pull_number: ctx.prNumber,
        per_page: 100,
      }
    );

    // 4. Parse diff into ChangedFile objects
    const { changedFiles, skippedFiles } = parsePRFiles(
      prFiles,
      inputs.codeExtensions,
      inputs.maxFilesPerRun
    );

    if (changedFiles.length === 0) {
      core.info("No code files changed in this PR — nothing to analyse.");
      return;
    }

    // 5. Fetch documentation files at the base ref
    core.info("Fetching documentation files…");
    const docRawFiles = await fetchDocFiles(
      octokit,
      ctx.owner,
      ctx.repo,
      ctx.baseSha,
      inputs.docGlobs
    );

    if (docRawFiles.length === 0) {
      core.warning(
        "No documentation files matched the configured globs. Check the doc-files input."
      );
    }

    // 6. Run drift detection
    const llm = new LLMClient(
      inputs.llmProvider,
      inputs.llmApiKey,
      inputs.llmModel || undefined
    );
    const detector = new DriftDetector(llm, inputs.sensitivity);
    const result = await detector.analyse(changedFiles, docRawFiles, skippedFiles);

    // 7. Auto-patch (if enabled and drift found)
    let patchPR = null;
    const hasPatchableDrift = result.driftResults.some(
      (r) => r.meetsThreshold && r.staleText && r.suggestedText
    );

    if (inputs.autoPatch && hasPatchableDrift) {
      core.info("Auto-patch enabled — creating doc patch PR…");
      const docContentMap = new Map(
        docRawFiles.map((f) => [f.filePath, f.content])
      );
      const patcher = new DocPatcher(octokit, ctx);
      patchPR = await patcher.createPatchPR(result, docContentMap);
    }

    // 8. Post/update PR comment
    const commenter = new PRCommenter(octokit, ctx, inputs.commentMode);
    await commenter.postOrUpdate(result, patchPR);

    // 9. Set action outputs
    const driftCount = result.driftResults.filter((r) => r.meetsThreshold).length;
    core.setOutput("drift-detected", driftCount > 0 ? "true" : "false");
    core.setOutput("drift-count", String(driftCount));
    core.setOutput(
      "patch-pr-url",
      patchPR?.patchPRUrl ?? ""
    );

    core.info(`Done. ${driftCount} drift issue(s) flagged.`);
  } catch (err) {
    if (err instanceof Error) {
      core.setFailed(err.message);
    } else {
      core.setFailed(String(err));
    }
  }
}

run();
