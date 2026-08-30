import { parsePRFiles } from "../diff-parser";
import { DriftDetector } from "../drift-detector";
import { LLMClient, withRetry } from "../llm-client";
import { PRCommenter } from "../pr-commenter";
import type { AnalysisError, AnalysisResult, PRContext } from "../types";
import { fetchDocumentationFiles } from "./github-docs";
import type {
  InstallationClientFactory,
  OctokitClient,
} from "./github-auth";
import {
  loadRepositoryConfig,
  shouldSkipPullRequest,
} from "./repository-config";
import type {
  HostedEnvironment,
  HostedLogger,
  PullRequestJob,
  RepositoryConfig,
} from "./types";

const HOSTED_COMMENT_MARKER = "<!-- knowledge-diff:hosted:v1 -->";
const CHECK_NAME = "Knowledge Diff";

export interface ProcessingOutcome {
  status: "completed" | "skipped";
  driftCount: number;
  analysisErrorCount: number;
  skipReason?: string;
}

export type HostedLLMFactory = (
  provider: RepositoryConfig["provider"],
  apiKey: string,
  model?: string
) => LLMClient;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function repositoryParts(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository full name: ${fullName}`);
  return { owner, repo };
}

function buildPRContext(job: PullRequestJob): PRContext {
  const { payload } = job;
  const base = repositoryParts(payload.repository.full_name);
  const headRepo = payload.pull_request.head.repo;
  return {
    owner: base.owner,
    repo: base.repo,
    prNumber: payload.pull_request.number,
    headSha: payload.pull_request.head.sha,
    baseSha: payload.pull_request.base.sha,
    baseRef: payload.pull_request.base.ref,
    headRef: payload.pull_request.head.ref,
    headOwner: headRepo?.owner.login ?? base.owner,
    isFork: Boolean(headRepo && headRepo.full_name !== payload.repository.full_name),
  };
}

function noCodeResult(skippedFiles: string[]): AnalysisResult {
  return {
    driftResults: [],
    skippedFiles,
    checkedFiles: 0,
    docFilesChecked: [],
    totalCandidates: 0,
    analysisErrors: [],
  };
}

async function createCheck(
  octokit: OctokitClient,
  ctx: PRContext,
  deliveryId: string
): Promise<number> {
  const response = await withRetry(
    () =>
      octokit.rest.checks.create({
        owner: ctx.owner,
        repo: ctx.repo,
        name: CHECK_NAME,
        head_sha: ctx.headSha,
        status: "in_progress",
        external_id: `knowledge-diff:${deliveryId}`,
        output: {
          title: "Documentation analysis is running",
          summary: "Knowledge Diff is comparing this code change with project documentation.",
        },
      }),
    `hosted:createCheck:${ctx.owner}/${ctx.repo}#${ctx.prNumber}`
  );
  return (response as { data: { id: number } }).data.id;
}

async function finishCheck(
  octokit: OctokitClient,
  ctx: PRContext,
  checkRunId: number,
  options: {
    conclusion: "success" | "neutral" | "failure";
    title: string;
    summary: string;
  }
): Promise<void> {
  await withRetry(
    () =>
      octokit.rest.checks.update({
        owner: ctx.owner,
        repo: ctx.repo,
        check_run_id: checkRunId,
        status: "completed",
        conclusion: options.conclusion,
        completed_at: new Date().toISOString(),
        output: { title: options.title, summary: options.summary },
      }),
    `hosted:updateCheck:${ctx.owner}/${ctx.repo}#${ctx.prNumber}`
  );
}

function skippedAnalysisErrors(skippedFiles: string[]): AnalysisError[] {
  return skippedFiles
    .filter(
      (file) =>
        file.includes("no patch data") || file.includes("max-files-per-run limit reached")
    )
    .map((file) => ({
      filePath: file.split(" (")[0],
      message: `Code file was not analysed: ${file}`,
    }));
}

export class HostedAnalysisService {
  private readonly environment: HostedEnvironment;
  private readonly clients: InstallationClientFactory;
  private readonly logger: HostedLogger;
  private readonly llmFactory: HostedLLMFactory;

  constructor(options: {
    environment: HostedEnvironment;
    clients: InstallationClientFactory;
    logger: HostedLogger;
    llmFactory?: HostedLLMFactory;
  }) {
    this.environment = options.environment;
    this.clients = options.clients;
    this.logger = options.logger;
    this.llmFactory =
      options.llmFactory ??
      ((provider, apiKey, model) => new LLMClient(provider, apiKey, model));
  }

  async process(job: PullRequestJob): Promise<ProcessingOutcome> {
    const installationId = job.payload.installation?.id;
    if (!Number.isInteger(installationId)) {
      throw new Error("pull_request webhook is missing installation.id");
    }

    const ctx = buildPRContext(job);
    const octokit = await this.clients.forInstallation(installationId!);
    const checkRunId = await createCheck(octokit, ctx, job.deliveryId);
    this.logger.info("Pull request analysis started", {
      deliveryId: job.deliveryId,
      repository: `${ctx.owner}/${ctx.repo}`,
      pullRequest: ctx.prNumber,
      installationId,
    });

    try {
      const loaded = await loadRepositoryConfig(
        octokit,
        ctx.owner,
        ctx.repo,
        ctx.baseSha,
        this.environment.defaultProvider
      );
      for (const warning of loaded.warnings) {
        this.logger.warning(warning, { repository: `${ctx.owner}/${ctx.repo}` });
      }

      const author = job.payload.sender?.login ?? "unknown";
      const skipReason = shouldSkipPullRequest(
        loaded.config,
        Boolean(job.payload.pull_request.draft),
        author,
        ctx.headRef
      );
      if (skipReason) {
        await finishCheck(octokit, ctx, checkRunId, {
          conclusion: "neutral",
          title: "Analysis skipped",
          summary: `Knowledge Diff skipped this pull request: ${skipReason}.`,
        });
        return {
          status: "skipped",
          driftCount: 0,
          analysisErrorCount: 0,
          skipReason,
        };
      }

      const apiKey = this.environment.llmApiKeys[loaded.config.provider];
      if (!apiKey) {
        throw new Error(
          `Hosted provider ${loaded.config.provider} is not configured on the server.`
        );
      }

      const prFiles = await withRetry<
        Array<{ filename: string; patch?: string; status: string }>
      >(
        () =>
          octokit.paginate(octokit.rest.pulls.listFiles, {
            owner: ctx.owner,
            repo: ctx.repo,
            pull_number: ctx.prNumber,
            per_page: 100,
          }) as Promise<Array<{ filename: string; patch?: string; status: string }>>,
        `hosted:listFiles:${ctx.owner}/${ctx.repo}#${ctx.prNumber}`
      );
      const { changedFiles, skippedFiles } = parsePRFiles(
        prFiles,
        loaded.config.codeExtensions,
        loaded.config.maxFilesPerRun
      );

      let result: AnalysisResult;
      if (changedFiles.length === 0) {
        result = noCodeResult(skippedFiles);
      } else {
        const headRepo = job.payload.pull_request.head.repo;
        const docRepository = headRepo
          ? repositoryParts(headRepo.full_name)
          : { owner: ctx.owner, repo: ctx.repo };
        let docs;
        try {
          docs = await fetchDocumentationFiles(
            octokit,
            docRepository.owner,
            docRepository.repo,
            ctx.headSha,
            loaded.config.docGlobs,
            loaded.config.maxDocFiles
          );
        } catch (error) {
          if (!ctx.isFork) throw error;
          this.logger.warning("Could not read documentation from fork; using base commit", {
            repository: `${ctx.owner}/${ctx.repo}`,
            pullRequest: ctx.prNumber,
            error: errorMessage(error),
          });
          docs = await fetchDocumentationFiles(
            octokit,
            ctx.owner,
            ctx.repo,
            ctx.baseSha,
            loaded.config.docGlobs,
            loaded.config.maxDocFiles
          );
          docs.errors.push({
            filePath: "*",
            message:
              "Documentation from the fork head was inaccessible; base-commit documentation was used instead.",
          });
        }

        const llm = this.llmFactory(
          loaded.config.provider,
          apiKey,
          loaded.config.model || undefined
        );
        const detector = new DriftDetector(llm, loaded.config.sensitivity);
        result = await detector.analyse(changedFiles, docs.files, skippedFiles);
        result.analysisErrors = [
          ...(result.analysisErrors ?? []),
          ...docs.errors,
          ...skippedAnalysisErrors(skippedFiles),
        ];
      }

      const commenter = new PRCommenter(
        octokit,
        ctx,
        loaded.config.commentMode,
        HOSTED_COMMENT_MARKER
      );
      await commenter.postOrUpdate(result, null);

      const driftCount = result.driftResults.filter((item) => item.meetsThreshold).length;
      const analysisErrorCount = result.analysisErrors?.length ?? 0;
      const conclusion =
        analysisErrorCount > 0
          ? "failure"
          : driftCount > 0
            ? loaded.config.failOnDrift
              ? "failure"
              : "neutral"
            : "success";
      const title =
        analysisErrorCount > 0
          ? "Documentation analysis incomplete"
          : driftCount > 0
            ? `${driftCount} documentation drift issue(s) found`
            : "No documentation drift detected";
      await finishCheck(octokit, ctx, checkRunId, {
        conclusion,
        title,
        summary:
          `Checked ${result.checkedFiles} changed code file(s) against ${result.docFilesChecked.length} documentation file(s). ` +
          `Found ${driftCount} actionable drift issue(s) and ${analysisErrorCount} analysis error(s). See the pull-request comment for details.`,
      });

      this.logger.info("Pull request analysis completed", {
        deliveryId: job.deliveryId,
        repository: `${ctx.owner}/${ctx.repo}`,
        pullRequest: ctx.prNumber,
        driftCount,
        analysisErrorCount,
      });
      return { status: "completed", driftCount, analysisErrorCount };
    } catch (error) {
      const message = errorMessage(error);
      try {
        await finishCheck(octokit, ctx, checkRunId, {
          conclusion: "failure",
          title: "Knowledge Diff failed",
          summary: `The hosted analysis could not complete: ${message.slice(0, 1_000)}`,
        });
      } catch (checkError) {
        this.logger.error("Could not mark failed check run", {
          deliveryId: job.deliveryId,
          error: errorMessage(checkError),
        });
      }
      throw error;
    }
  }
}
