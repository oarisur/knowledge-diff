import * as core from "@actions/core";
import { withRetry } from "./llm-client";
import type { GitHub } from "@actions/github/lib/utils";
import type {
  AnalysisResult,
  DriftResult,
  DocPatch,
  PatchPRResult,
  PRContext,
} from "./types";

// ─── Apply Patch to Doc Content ───────────────────────────────────────────────

/**
 * Applies a simple text replacement: replaces `staleText` with `suggestedText`
 * in the original doc content. Returns null if the stale text is not found.
 */
function applyPatch(
  originalContent: string,
  staleText: string,
  suggestedText: string
): string | null {
  if (!originalContent.includes(staleText)) {
    core.debug(`Stale text not found verbatim in doc — skipping patch.`);
    return null;
  }
  // Intentionally replaces only the first occurrence. The LLM's staleText targets
  // a specific passage, so a single surgical replacement is the safest behavior.
  return originalContent.replace(staleText, suggestedText);
}

// ─── Collect Patches ──────────────────────────────────────────────────────────

function collectPatches(
  result: AnalysisResult,
  docContents: Map<string, string>
): DocPatch[] {
  const patches: DocPatch[] = [];
  const seenFiles = new Map<string, string>(); // filePath → current patched content

  const actionable = result.driftResults.filter(
    (r): r is DriftResult & { staleText: string; suggestedText: string } =>
      r.meetsThreshold &&
      r.staleText !== undefined &&
      r.suggestedText !== undefined
  );

  for (const drift of actionable) {
    const filePath = drift.matchedSection.filePath;
    const baseContent =
      seenFiles.get(filePath) ?? docContents.get(filePath) ?? "";

    const patched = applyPatch(
      baseContent,
      drift.staleText,
      drift.suggestedText
    );

    if (!patched) continue;

    seenFiles.set(filePath, patched);

    // Upsert patch entry
    const existing = patches.find((p) => p.filePath === filePath);
    if (existing) {
      existing.patchedContent = patched;
    } else {
      patches.push({
        filePath,
        originalContent: baseContent,
        patchedContent: patched,
      });
    }
  }

  return patches;
}

// ─── GitHub API: Create Patch PR ─────────────────────────────────────────────

type OctokitClient = InstanceType<typeof GitHub>;

export class DocPatcher {
  private octokit: OctokitClient;
  private ctx: PRContext;

  constructor(octokit: OctokitClient, ctx: PRContext) {
    this.octokit = octokit;
    this.ctx = ctx;
  }

  async createPatchPR(
    result: AnalysisResult,
    docContents: Map<string, string>
  ): Promise<PatchPRResult | null> {
    const patches = collectPatches(result, docContents);

    if (patches.length === 0) {
      core.info("Auto-patch: no patchable drift found (no verbatim stale text).");
      return null;
    }

    core.info(
      `Auto-patch: creating patch for ${patches.length} doc file(s).`
    );

    const shortSha = this.ctx.headSha.slice(0, 7);
    const patchBranch = `docs/knowledge-diff-${this.ctx.prNumber}-${shortSha}`;

    try {
      // 1. Get base branch SHA
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: refData } = await withRetry<any>(
        () => this.octokit.rest.git.getRef({
          owner: this.ctx.owner,
          repo: this.ctx.repo,
          ref: `heads/${this.ctx.baseRef}`,
        }),
        'getRef'
      );
      const baseSha = refData.object.sha;

      // 2. Get current tree
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: commitData } = await withRetry<any>(
        () => this.octokit.rest.git.getCommit({
          owner: this.ctx.owner,
          repo: this.ctx.repo,
          commit_sha: baseSha,
        }),
        'getCommit'
      );
      const baseTreeSha = commitData.tree.sha;

      // 3. Create new blobs for each patched doc
      const treeItems: Array<{
        path: string;
        mode: "100644";
        type: "blob";
        sha: string;
      }> = [];

      for (const patch of patches) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: blob } = await withRetry<any>(
          () => this.octokit.rest.git.createBlob({
            owner: this.ctx.owner,
            repo: this.ctx.repo,
            content: Buffer.from(patch.patchedContent, "utf-8").toString("base64"),
            encoding: "base64",
          }),
          'createBlob'
        );
        treeItems.push({
          path: patch.filePath,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        });
      }

      // 4. Create new tree
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: newTree } = await withRetry<any>(
        () => this.octokit.rest.git.createTree({
          owner: this.ctx.owner,
          repo: this.ctx.repo,
          base_tree: baseTreeSha,
          tree: treeItems,
        }),
        'createTree'
      );

      // 5. Create commit
      const patchedFiles = patches.map((p) => `- ${p.filePath}`).join("\n");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: newCommit } = await withRetry<any>(
        () => this.octokit.rest.git.createCommit({
          owner: this.ctx.owner,
          repo: this.ctx.repo,
          message: `docs: apply knowledge-diff patches for PR #${this.ctx.prNumber}\n\nUpdated files:\n${patchedFiles}\n\nAuto-generated by knowledge-diff.`,
          tree: newTree.sha,
          parents: [baseSha],
        }),
        'createCommit'
      );

      // 6. Create (or update) branch
      try {
        await withRetry(
          () => this.octokit.rest.git.createRef({
            owner: this.ctx.owner,
            repo: this.ctx.repo,
            ref: `refs/heads/${patchBranch}`,
            sha: newCommit.sha,
          }),
          'createRef'
        );
      } catch (refErr) {
        // 422 = branch already exists from a previous run — update it
        const status = refErr && typeof refErr === "object" && "status" in refErr
          ? (refErr as { status: number }).status
          : 0;
        if (status === 422) {
          core.info(`Patch branch '${patchBranch}' already exists — updating.`);
          await withRetry(
            () => this.octokit.rest.git.updateRef({
              owner: this.ctx.owner,
              repo: this.ctx.repo,
              ref: `heads/${patchBranch}`,
              sha: newCommit.sha,
              force: true,
            }),
            'updateRef'
          );
        } else {
          throw refErr; // Re-throw unexpected errors (permissions, network, etc.)
        }
      }

      // 7. Open PR (or reuse existing one from a previous run)
      const filesList = patches.map((p) => `- \`${p.filePath}\``).join("\n");

      // Check if a patch PR from this branch is already open to avoid duplicates
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: existingPRs } = await withRetry<any>(
        () => this.octokit.rest.pulls.list({
          owner: this.ctx.owner,
          repo: this.ctx.repo,
          head: `${this.ctx.owner}:${patchBranch}`,
          state: "open",
        }),
        'listPulls'
      );

      if (existingPRs.length > 0) {
        const existing = existingPRs[0];
        core.info(`Patch PR already exists: ${existing.html_url} — branch updated.`);
        return {
          patchBranch,
          patchPRNumber: existing.number,
          patchPRUrl: existing.html_url,
        };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: pr } = await withRetry<any>(
        () => this.octokit.rest.pulls.create({
          owner: this.ctx.owner,
          repo: this.ctx.repo,
          title: `docs: fix rationale drift from PR #${this.ctx.prNumber}`,
          head: patchBranch,
          base: this.ctx.baseRef,
          body: `## 📝 Documentation Patch

This PR was auto-generated by [knowledge-diff](https://github.com/marketplace/actions/knowledge-diff) to fix rationale drift detected in #${this.ctx.prNumber}.

### Files updated
${filesList}

### What changed
See the diff for exact text replacements. Please review before merging — AI-generated patches should always be human-approved.

> *Closes the documentation drift flagged in #${this.ctx.prNumber}*`,
        }),
        'createPull'
      );

      core.info(`Patch PR created: ${pr.html_url}`);

      return {
        patchBranch,
        patchPRNumber: pr.number,
        patchPRUrl: pr.html_url,
      };
    } catch (err) {
      core.error(`Failed to create patch PR: ${err}`);
      return null;
    }
  }
}

