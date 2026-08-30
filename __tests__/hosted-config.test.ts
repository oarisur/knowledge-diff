import { loadHostedEnvironment } from "../src/hosted/config";
import {
  parseRepositoryConfig,
  shouldSkipPullRequest,
  loadRepositoryConfig,
} from "../src/hosted/repository-config";

const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";

function validEnvironment(): Record<string, string> {
  return {
    GITHUB_APP_ID: "123",
    GITHUB_PRIVATE_KEY: PRIVATE_KEY.replace(/\n/g, "\\n"),
    GITHUB_WEBHOOK_SECRET: "a-secure-webhook-secret",
    OPENAI_API_KEY: "openai-key",
  };
}

describe("hosted environment", () => {
  test("loads secure defaults and configured limits", () => {
    const environment = loadHostedEnvironment({
      ...validEnvironment(),
      HOST: "127.0.0.1",
      PORT: "8080",
      MAX_CONCURRENCY: "4",
      MAX_QUEUE_SIZE: "50",
      MAX_WEBHOOK_BODY_BYTES: "2048",
      SHUTDOWN_TIMEOUT_MS: "5000",
      GITHUB_API_URL: "https://github.example/api/v3/",
    });

    expect(environment).toMatchObject({
      host: "127.0.0.1",
      port: 8080,
      githubAppId: 123,
      githubPrivateKey: PRIVATE_KEY,
      githubApiBaseUrl: "https://github.example/api/v3",
      githubApiVersion: "2026-03-10",
      defaultProvider: "openai",
      maxConcurrency: 4,
      maxQueueSize: 50,
      maxWebhookBodyBytes: 2048,
      shutdownTimeoutMs: 5000,
    });
  });

  test("accepts a base64 private key and alternate default provider", () => {
    const input = validEnvironment();
    delete input.GITHUB_PRIVATE_KEY;
    input.GITHUB_PRIVATE_KEY_BASE64 = Buffer.from(PRIVATE_KEY).toString("base64");
    input.HOSTED_LLM_PROVIDER = "gemini";
    input.GEMINI_API_KEY = "gemini-key";

    expect(loadHostedEnvironment(input)).toMatchObject({
      githubPrivateKey: PRIVATE_KEY,
      defaultProvider: "gemini",
    });
  });

  test.each([
    [{ ...validEnvironment(), GITHUB_WEBHOOK_SECRET: "short" }, "at least 16"],
    [{ ...validEnvironment(), HOSTED_LLM_PROVIDER: "unknown" }, "must be openai"],
    [{ ...validEnvironment(), PORT: "0" }, "PORT must be between"],
    [{ ...validEnvironment(), MAX_CONCURRENCY: "abc" }, "positive integer"],
    [{ ...validEnvironment(), GITHUB_PRIVATE_KEY: "not-a-key" }, "not a PEM"],
    [{ ...validEnvironment(), OPENAI_API_KEY: "" }, "OPENAI_API_KEY is required"],
  ])("rejects invalid environment configuration", (environment, message) => {
    expect(() => loadHostedEnvironment(environment)).toThrow(message);
  });
});

describe("repository configuration", () => {
  test("parses all supported settings and reports unknown keys", () => {
    const { config, warnings } = parseRepositoryConfig(
      `enabled: true
provider: anthropic
model: claude-custom
sensitivity: high
doc-files: [README.md, docs/**/*.md]
code-extensions: .ts,.py
max-files-per-run: 12
max-doc-files: 40
comment-mode: new
fail-on-drift: true
skip-drafts: false
ignore-authors: []
ignore-branches: [release/**]
future-setting: true`,
      "openai"
    );

    expect(config).toEqual({
      enabled: true,
      provider: "anthropic",
      model: "claude-custom",
      sensitivity: "high",
      docGlobs: ["README.md", "docs/**/*.md"],
      codeExtensions: ["ts", "py"],
      maxFilesPerRun: 12,
      maxDocFiles: 40,
      commentMode: "new",
      failOnDrift: true,
      skipDrafts: false,
      ignoredAuthors: [],
      ignoredBranches: ["release/**"],
    });
    expect(warnings).toEqual(["Unknown repository configuration key: future-setting"]);
  });

  test("uses defaults for an empty configuration", () => {
    const { config } = parseRepositoryConfig("", "gemini");
    expect(config.provider).toBe("gemini");
    expect(config.docGlobs).toContain("**/AGENTS.md");
    expect(config.codeExtensions).toContain("ts");
    expect(config.ignoredBranches).toEqual([]);
  });

  test.each([
    ["provider: invalid", "provider must"],
    ["sensitivity: extreme", "sensitivity must"],
    ["comment-mode: overwrite", "comment-mode must"],
    ["max-files-per-run: 0", "between 1 and 100"],
    ["doc-files: []", "must not be empty"],
    ["enabled: yes", "enabled must be true or false"],
    ["- not-an-object", "YAML object"],
  ])("rejects unsafe repository configuration", (yaml, expected) => {
    expect(() => parseRepositoryConfig(yaml, "openai")).toThrow(expected);
  });

  test("evaluates draft, author, branch, and disabled skip rules", () => {
    const { config } = parseRepositoryConfig(
      "ignore-authors: ['renovate[bot]']\nignore-branches: [release/**]",
      "openai"
    );
    expect(shouldSkipPullRequest(config, true, "alice", "feature/test")).toContain("draft");
    expect(shouldSkipPullRequest(config, false, "Renovate[bot]", "feature/test")).toContain(
      "ignored author"
    );
    expect(shouldSkipPullRequest(config, false, "alice", "release/1.0")).toContain(
      "ignored branch"
    );
    expect(shouldSkipPullRequest(config, false, "alice", "feature/test")).toBeNull();
    expect(
      shouldSkipPullRequest({ ...config, enabled: false }, false, "alice", "feature/test")
    ).toContain("disabled");
  });

  test("loads config content and falls back only on 404", async () => {
    const getContent = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          type: "file",
          content: Buffer.from("sensitivity: low").toString("base64"),
        },
      })
      .mockRejectedValueOnce({ status: 404 })
      .mockRejectedValueOnce({ status: 500 });
    const octokit = { rest: { repos: { getContent } } } as any;

    await expect(
      loadRepositoryConfig(octokit, "owner", "repo", "sha", "openai")
    ).resolves.toMatchObject({ found: true, config: { sensitivity: "low" } });
    await expect(
      loadRepositoryConfig(octokit, "owner", "repo", "sha", "openai")
    ).resolves.toMatchObject({ found: false, config: { sensitivity: "medium" } });
    await expect(
      loadRepositoryConfig(octokit, "owner", "repo", "sha", "openai")
    ).rejects.toMatchObject({ status: 500 });
  });
});
