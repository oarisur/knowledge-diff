import * as core from "@actions/core";
import { withRetry } from "./llm-client";
import type { GitHub } from "@actions/github/lib/utils";
import type { AnalysisResult, DriftResult, PRContext, PatchPRResult } from "./types";

// ─── Comment Marker ───────────────────────────────────────────────────────────

const COMMENT_MARKER =
  "<!-- knowledge-diff:v1 -->";

const MAX_COMMENT_LENGTH = 65_000; // GitHub max is 65,536; leave margin

// ─── Confidence Badge ─────────────────────────────────────────────────────────

const CONFIDENCE_EMOJI: Record<string, string> = {
  definite: "🔴",
  likely: "🟡",
  possible: "🔵",
};

const CONFIDENCE_LABEL: Record<string, string> = {
  definite: "Definite contradiction",
  likely: "Likely outdated",
  possible: "Possibly ambiguous",
};

// ─── Comment Body Builder ─────────────────────────────────────────────────────

function buildCommentBody(
  result: AnalysisResult,
  patchPR: PatchPRResult | null,
  repoUrl: string
): string {
  const actionable = result.driftResults.filter((r) => r.meetsThreshold);

  if (actionable.length === 0) {
    return `${COMMENT_MARKER}
## ✅ Knowledge Diff — No Rationale Drift Detected

Checked **${result.checkedFiles}** changed file(s) against **${result.docFilesChecked.length}** documentation file(s) — all clear.

${result.skippedFiles.length > 0 ? `<details><summary>${result.skippedFiles.length} file(s) skipped</summary>\n\n${result.skippedFiles.map((f) => `- \`${f}\``).join("\n")}\n\n</details>` : ""}

<sub>🧠 [knowledge-diff](${repoUrl}) • analysed ${result.totalCandidates} candidate pair(s)</sub>`;
  }

  // Group by changed file
  const byFile = new Map<string, DriftResult[]>();
  for (const dr of actionable) {
    const key = dr.changedFile.filePath;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(dr);
  }

  let body = `${COMMENT_MARKER}
## 🧠 Knowledge Diff — Rationale Drift Detected

I found **${actionable.length}** documentation drift issue(s) in this PR. The code changed, but the docs didn't keep up.

---
`;

  for (const [filePath, drifts] of byFile) {
    for (const drift of drifts) {
      const badge = CONFIDENCE_EMOJI[drift.confidence] ?? "⚪";
      const label = CONFIDENCE_LABEL[drift.confidence] ?? drift.confidence;

      body += `
### ${badge} \`${filePath}\` → \`${drift.matchedSection.filePath}\` — *${drift.matchedSection.heading}*

**${label}:** ${drift.explanation}
`;

      if (drift.staleText) {
        body += `
> **Doc still says:**
> *"${drift.staleText}"*
`;
      }

      if (drift.suggestedText) {
        body += `
**Suggested update:**
\`\`\`diff
- ${drift.staleText ?? "…"}
+ ${drift.suggestedText}
\`\`\`
`;
      }

      body += "\n---\n";
    }
  }

  const cleanCount =
    result.checkedFiles - new Set(actionable.map((r) => r.changedFile.filePath)).size;

  if (cleanCount > 0) {
    body += `\n*No drift detected in ${cleanCount} other changed file(s).*\n`;
  }

  if (patchPR) {
    body += `
> **📝 Auto-patch available:** I've opened [PR #${patchPR.patchPRNumber}](${patchPR.patchPRUrl}) with suggested doc updates — review and merge when ready.
`;
  }

  body += `\n<sub>🧠 [knowledge-diff](${repoUrl}) • ${result.totalCandidates} candidate pair(s) checked</sub>`;

  if (body.length > MAX_COMMENT_LENGTH) {
    const truncationNotice = `\n\n---\n\n> ⚠️ **Comment truncated** — ${actionable.length} drift issue(s) found but the full report exceeded GitHub's comment size limit. Review the action logs for complete details.\n\n${COMMENT_MARKER.replace('v1', 'truncated')}`;
    body = body.slice(0, MAX_COMMENT_LENGTH - truncationNotice.length) + truncationNotice;
  }

  return body;
}

// ─── PR Commenter ─────────────────────────────────────────────────────────────

type OctokitClient = InstanceType<typeof GitHub>;

export class PRCommenter {
  private octokit: OctokitClient;
  private ctx: PRContext;
  private commentMode: "update" | "new";

  constructor(octokit: OctokitClient, ctx: PRContext, commentMode: "update" | "new") {
    this.octokit = octokit;
    this.ctx = ctx;
    this.commentMode = commentMode;
  }

  async postOrUpdate(
    result: AnalysisResult,
    patchPR: PatchPRResult | null
  ): Promise<void> {
    const repoUrl = `https://github.com/${this.ctx.owner}/${this.ctx.repo}`;
    const body = buildCommentBody(result, patchPR, repoUrl);

    if (this.commentMode === "update") {
      const existingId = await this.findExistingComment();
      if (existingId) {
        core.info(`Updating existing comment #${existingId}`);
        await withRetry(() => this.octokit.rest.issues.updateComment({
          owner: this.ctx.owner,
          repo: this.ctx.repo,
          comment_id: existingId,
          body,
        }), 'updateComment');
        return;
      }
    }

    core.info("Posting new PR comment.");
    await withRetry(() => this.octokit.rest.issues.createComment({
      owner: this.ctx.owner,
      repo: this.ctx.repo,
      issue_number: this.ctx.prNumber,
      body,
    }), 'createComment');
  }

  private async findExistingComment(): Promise<number | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const comments = await withRetry<any[]>(
      () => this.octokit.paginate(
        this.octokit.rest.issues.listComments,
        {
          owner: this.ctx.owner,
          repo: this.ctx.repo,
          issue_number: this.ctx.prNumber,
          per_page: 100,
        }
      ),
      'listComments'
    );

    for (const comment of comments) {
      if (comment.body?.includes(COMMENT_MARKER)) {
        return comment.id;
      }
    }

    return null;
  }
}
