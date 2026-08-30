jest.mock("@actions/core", () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
}));
jest.mock("@actions/github", () => ({
  getOctokit: jest.fn(() => ({ authenticated: true })),
}));

import { generateKeyPairSync, verify } from "node:crypto";
import {
  createGitHubAppJwt,
  GitHubAppInstallationClients,
} from "../src/hosted/github-auth";
import { fetchDocumentationFiles } from "../src/hosted/github-docs";
import { createJsonLogger } from "../src/hosted/logger";

describe("GitHub App authentication", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  test("creates a signed, short-lived GitHub App JWT", () => {
    const now = Date.UTC(2026, 7, 30, 12, 0, 0);
    const jwt = createGitHubAppJwt(123, privatePem, now);
    const [header, payload, signature] = jwt.split(".");
    const decode = (value: string) =>
      JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(payload)).toEqual({
      iat: Math.floor(now / 1000) - 30,
      exp: Math.floor(now / 1000) + 540,
      iss: "123",
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url")
      )
    ).toBe(true);
  });

  test("requests and caches installation tokens", async () => {
    const fetchImpl = jest.fn(async () =>
      new Response(
        JSON.stringify({
          token: "installation-token",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
        { status: 201 }
      )
    );
    const clients = new GitHubAppInstallationClients({
      appId: 123,
      privateKey: privatePem,
      apiBaseUrl: "https://api.github.test",
      apiVersion: "2026-03-10",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [first, second] = await Promise.all([
      clients.forInstallation(99),
      clients.forInstallation(99),
    ]);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calls = fetchImpl.mock.calls as unknown as Array<[string, { body?: string }]>;
    expect(calls[0][0]).toContain("/app/installations/99/access_tokens");
    expect(calls[0][1]?.body).toContain('"contents":"read"');

    await clients.forInstallation(99);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([
    [new Response("denied", { status: 403 }), "failed (403)"],
    [new Response("not-json", { status: 201 }), "not valid JSON"],
    [new Response(JSON.stringify({ token: "missing-expiry" }), { status: 201 }), "missing token"],
    [new Response(JSON.stringify({ token: "x", expires_at: "bad" }), { status: 201 }), "invalid expiry"],
  ])("rejects invalid installation-token responses", async (response, expected) => {
    const clients = new GitHubAppInstallationClients({
      appId: 123,
      privateKey: privatePem,
      apiBaseUrl: "https://api.github.test",
      apiVersion: "2026-03-10",
      fetchImpl: jest.fn(async () => response) as unknown as typeof fetch,
    });
    await expect(clients.forInstallation(1)).rejects.toThrow(expected);
  });
});

describe("hosted documentation fetcher", () => {
  test("matches globs, applies limits, and reports partial failures", async () => {
    const getTree = jest.fn(async () => ({
      data: {
        truncated: true,
        tree: [
          { type: "blob", path: "docs/b.md" },
          { type: "blob", path: "README.md" },
          { type: "blob", path: "docs/a.md" },
          { type: "tree", path: "docs" },
          { type: "blob", path: "src/index.ts" },
        ],
      },
    }));
    const getContent = jest.fn(async ({ path }: { path: string }) => {
      if (path === "README.md") throw new Error("unavailable");
      return {
        data: { type: "file", content: Buffer.from(`# ${path}`).toString("base64") },
      };
    });
    const octokit = { rest: { git: { getTree }, repos: { getContent } } } as any;

    const result = await fetchDocumentationFiles(
      octokit,
      "owner",
      "repo",
      "sha",
      ["README.md", "docs/**/*.md"],
      2
    );

    expect(result.files).toEqual([{ filePath: "docs/a.md", content: "# docs/a.md" }]);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("truncated") }),
        expect.objectContaining({ message: expect.stringContaining("exceeding max-doc-files") }),
        expect.objectContaining({ filePath: "README.md" }),
      ])
    );
  });

  test("rejects oversized or non-inline content and propagates tree failures", async () => {
    const getContent = jest
      .fn()
      .mockResolvedValueOnce({ data: { type: "symlink" } })
      .mockResolvedValueOnce({
        data: {
          type: "file",
          content: Buffer.alloc(1_048_577, "x").toString("base64"),
        },
      });
    const octokit = {
      rest: {
        git: {
          getTree: jest.fn(async () => ({
            data: {
              truncated: false,
              tree: [
                { type: "blob", path: "docs/a.md" },
                { type: "blob", path: "docs/b.md" },
              ],
            },
          })),
        },
        repos: { getContent },
      },
    } as any;
    const result = await fetchDocumentationFiles(
      octokit,
      "owner",
      "repo",
      "sha",
      ["docs/**/*.md"],
      10
    );
    expect(result.files).toEqual([]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[1].message).toContain("1 MiB");

    octokit.rest.git.getTree.mockRejectedValueOnce(new Error("tree failed"));
    await expect(
      fetchDocumentationFiles(octokit, "owner", "repo", "sha", ["**/*.md"], 10)
    ).rejects.toThrow("tree failed");
  });
});

describe("JSON logger", () => {
  test("writes structured log records", () => {
    const stdout = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createJsonLogger();
    logger.info("started", { port: 3000 });
    logger.warning("slow");
    logger.error("failed", { code: "E_TEST" });

    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"message":"started"'));
    expect(stderr).toHaveBeenCalledTimes(2);
    stdout.mockRestore();
    stderr.mockRestore();
  });
});
