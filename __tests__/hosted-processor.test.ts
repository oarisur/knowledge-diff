jest.mock("@actions/core", () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
}));

import { HostedAnalysisService } from "../src/hosted/processor";
import type { HostedEnvironment, HostedLogger, PullRequestJob } from "../src/hosted/types";

function environment(): HostedEnvironment {
  return {
    host: "127.0.0.1",
    port: 3000,
    githubAppId: 1,
    githubPrivateKey: "unused",
    githubWebhookSecret: "a-secure-webhook-secret",
    githubApiBaseUrl: "https://api.github.com",
    githubApiVersion: "2026-03-10",
    defaultProvider: "openai",
    llmApiKeys: { openai: "model-key" },
    maxConcurrency: 1,
    maxQueueSize: 10,
    maxWebhookBodyBytes: 1000,
    shutdownTimeoutMs: 1000,
  };
}

function job(overrides: Partial<PullRequestJob["payload"]["pull_request"]> = {}): PullRequestJob {
  return {
    deliveryId: "delivery-1",
    payload: {
      action: "opened",
      installation: { id: 42 },
      sender: { login: "alice" },
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      },
      pull_request: {
        number: 7,
        draft: false,
        head: {
          sha: "head-sha",
          ref: "feature",
          repo: { name: "repo", full_name: "owner/repo", owner: { login: "owner" } },
        },
        base: {
          sha: "base-sha",
          ref: "main",
          repo: { name: "repo", full_name: "owner/repo", owner: { login: "owner" } },
        },
        ...overrides,
      },
    },
  };
}

const logger: HostedLogger = {
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
};

function createOctokit(options: {
  files?: Array<{ filename: string; patch?: string; status: string }>;
  config?: string | null;
  comments?: Array<{ id: number; body: string }>;
} = {}) {
  const pullsListFiles = jest.fn();
  const listComments = jest.fn();
  const files = options.files ?? [
    {
      filename: "src/store/cart.ts",
      status: "modified",
      patch:
        "@@ -1,1 +1,1 @@\n-import { createSlice } from 'redux';\n+import { create } from 'zustand';",
    },
  ];
  const getContent = jest.fn(async ({ path }: { path: string }) => {
    if (path === ".github/knowledge-diff.yml") {
      if (options.config === null || options.config === undefined) throw { status: 404 };
      return {
        data: { type: "file", content: Buffer.from(options.config).toString("base64") },
      };
    }
    return {
      data: {
        type: "file",
        content: Buffer.from(
          "# Architecture\n\n## State\n`src/store/cart.ts` uses Redux and `createSlice` for all cart state."
        ).toString("base64"),
      },
    };
  });
  const octokit = {
    paginate: jest.fn(async (endpoint: unknown) =>
      endpoint === pullsListFiles ? files : options.comments ?? []
    ),
    rest: {
      checks: {
        create: jest.fn(async () => ({ data: { id: 900 } })),
        update: jest.fn(async () => ({ data: {} })),
      },
      pulls: { listFiles: pullsListFiles },
      git: {
        getTree: jest.fn(async () => ({
          data: {
            truncated: false,
            tree: [{ type: "blob", path: "README.md" }],
          },
        })),
      },
      repos: { getContent },
      issues: {
        listComments,
        createComment: jest.fn(async () => ({ data: {} })),
        updateComment: jest.fn(async () => ({ data: {} })),
      },
    },
  };
  return octokit;
}

describe("hosted pull request processor", () => {
  test("authenticates, analyses, comments, and completes a check run", async () => {
    const octokit = createOctokit();
    const detectDriftBatch = jest.fn(async (_file, _patch, candidates) =>
      candidates.map((_candidate: unknown, candidateIndex: number) => ({
        candidateIndex,
        isDrift: true,
        confidence: "definite" as const,
        explanation: "Redux documentation contradicts the Zustand change.",
        staleText: "uses Redux",
        suggestedText: "uses Zustand",
      }))
    );
    const service = new HostedAnalysisService({
      environment: environment(),
      clients: { forInstallation: jest.fn(async () => octokit as any) },
      logger,
      llmFactory: jest.fn(() => ({ detectDriftBatch }) as any),
    });

    await expect(service.process(job())).resolves.toEqual({
      status: "completed",
      driftCount: 1,
      analysisErrorCount: 0,
    });
    expect(detectDriftBatch).toHaveBeenCalledTimes(1);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("knowledge-diff:hosted:v1") })
    );
    expect(octokit.rest.checks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ conclusion: "neutral", status: "completed" })
    );
  });

  test("can make drift blocking through trusted base configuration", async () => {
    const octokit = createOctokit({ config: "fail-on-drift: true" });
    const service = new HostedAnalysisService({
      environment: environment(),
      clients: { forInstallation: jest.fn(async () => octokit as any) },
      logger,
      llmFactory: jest.fn(
        () =>
          ({
            detectDriftBatch: async () => [
              {
                candidateIndex: 0,
                isDrift: true,
                confidence: "definite",
                explanation: "drift",
              },
            ],
          }) as any
      ),
    });
    await service.process(job());
    expect(octokit.rest.checks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ conclusion: "failure" })
    );
  });

  test("skips drafts before fetching diffs or calling a model", async () => {
    const octokit = createOctokit();
    const llmFactory = jest.fn();
    const service = new HostedAnalysisService({
      environment: environment(),
      clients: { forInstallation: jest.fn(async () => octokit as any) },
      logger,
      llmFactory,
    });
    await expect(service.process(job({ draft: true }))).resolves.toMatchObject({
      status: "skipped",
      skipReason: "draft pull request",
    });
    expect(llmFactory).not.toHaveBeenCalled();
    expect(octokit.paginate).not.toHaveBeenCalled();
  });

  test("updates stale hosted comments when no code files remain", async () => {
    const octokit = createOctokit({
      files: [{ filename: "README.md", patch: "+docs", status: "modified" }],
      comments: [{ id: 33, body: "<!-- knowledge-diff:hosted:v1 --> old" }],
    });
    const service = new HostedAnalysisService({
      environment: environment(),
      clients: { forInstallation: jest.fn(async () => octokit as any) },
      logger,
    });
    await expect(service.process(job())).resolves.toMatchObject({ driftCount: 0 });
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 33, body: expect.stringContaining("all clear") })
    );
  });

  test("marks provider configuration failures on the check run", async () => {
    const octokit = createOctokit();
    const noKeys = { ...environment(), llmApiKeys: {} };
    const service = new HostedAnalysisService({
      environment: noKeys,
      clients: { forInstallation: jest.fn(async () => octokit as any) },
      logger,
    });
    await expect(service.process(job())).rejects.toThrow("not configured");
    expect(octokit.rest.checks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ conclusion: "failure" })
    );
  });

  test("rejects webhook jobs without an installation id", async () => {
    const invalid = job();
    delete invalid.payload.installation;
    const service = new HostedAnalysisService({
      environment: environment(),
      clients: { forInstallation: jest.fn() },
      logger,
    });
    await expect(service.process(invalid)).rejects.toThrow("installation.id");
  });
});
