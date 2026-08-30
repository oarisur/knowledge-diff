import { createHmac } from "node:crypto";
import { LatestJobQueue } from "../src/hosted/queue";
import { createHostedServer } from "../src/hosted/server";
import { verifyWebhookSignature } from "../src/hosted/signature";
import type { HostedEnvironment, HostedLogger } from "../src/hosted/types";

const SECRET = "a-secure-webhook-secret";

function environment(overrides: Partial<HostedEnvironment> = {}): HostedEnvironment {
  return {
    host: "127.0.0.1",
    port: 0,
    githubAppId: 1,
    githubPrivateKey: "unused",
    githubWebhookSecret: SECRET,
    githubApiBaseUrl: "https://api.github.com",
    githubApiVersion: "2026-03-10",
    defaultProvider: "openai",
    llmApiKeys: { openai: "key" },
    maxConcurrency: 1,
    maxQueueSize: 10,
    maxWebhookBodyBytes: 1_048_576,
    shutdownTimeoutMs: 1_000,
    ...overrides,
  };
}

function signature(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function pullRequestPayload(action = "opened") {
  return {
    action,
    installation: { id: 12 },
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
    },
  };
}

const logger: HostedLogger = {
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
};

describe("webhook signatures", () => {
  test("accepts the GitHub HMAC-SHA256 signature and rejects malformed values", () => {
    const body = Buffer.from("hello");
    expect(verifyWebhookSignature(body, signature("hello"), SECRET)).toBe(true);
    expect(verifyWebhookSignature(body, [signature("hello")], SECRET)).toBe(true);
    expect(verifyWebhookSignature(body, "sha256=bad", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha1=bad", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
  });
});

describe("latest-job queue", () => {
  test("limits concurrency and replaces stale pending work for the same PR", async () => {
    const queue = new LatestJobQueue(1, 2);
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    expect(
      queue.enqueue("first", async () => {
        events.push("running");
        await gate;
      })
    ).toBe("queued");
    expect(queue.enqueue("same", async () => { events.push("stale"); })).toBe("queued");
    expect(queue.enqueue("same", async () => { events.push("latest"); })).toBe("replaced");
    expect(queue.enqueue("third", async () => { events.push("third"); })).toBe("queued");
    expect(queue.enqueue("full", async () => undefined)).toBe("full");
    expect(queue.stats()).toMatchObject({ active: 1, pending: 2, accepting: true });

    release();
    await queue.onIdle();
    expect(events).toEqual(["running", "latest", "third"]);
    await queue.close();
    expect(queue.enqueue("closed", async () => undefined)).toBe("closed");
  });
});

describe("hosted HTTP server", () => {
  test("handles health routes, signed events, deduplication, and validation", async () => {
    const process = jest.fn(async () => undefined);
    const hosted = createHostedServer({
      environment: environment(),
      processor: { process },
      logger,
    });
    const { port } = await hosted.start();
    const base = `http://127.0.0.1:${port}`;

    await expect(fetch(`${base}/healthz`).then((response) => response.status)).resolves.toBe(200);
    await expect(fetch(`${base}/readyz`).then((response) => response.status)).resolves.toBe(200);
    await expect(fetch(`${base}/`).then((response) => response.json())).resolves.toMatchObject({
      service: "knowledge-diff-hosted",
    });
    await expect(fetch(`${base}/missing`).then((response) => response.status)).resolves.toBe(404);
    await expect(
      fetch(`${base}/api/github/webhooks`).then((response) => response.status)
    ).resolves.toBe(405);

    const payloadBody = JSON.stringify(pullRequestPayload());
    const post = (body: string, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/github/webhooks`, {
        method: "POST",
        headers: {
          "x-hub-signature-256": signature(body),
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-1",
          ...headers,
        },
        body,
      });

    await expect(
      fetch(`${base}/api/github/webhooks`, { method: "POST", body: payloadBody }).then(
        (response) => response.status
      )
    ).resolves.toBe(401);
    await expect(
      post(payloadBody, { "x-github-delivery": "" }).then((response) => response.status)
    ).resolves.toBe(400);
    await expect(post("not-json").then((response) => response.status)).resolves.toBe(400);

    const ping = "{}";
    await expect(
      post(ping, {
        "x-github-event": "ping",
        "x-github-delivery": "ping-1",
      }).then((response) => response.json())
    ).resolves.toEqual({ status: "pong" });
    await expect(
      post("{}", {
        "x-github-event": "installation",
        "x-github-delivery": "install-1",
      }).then((response) => response.status)
    ).resolves.toBe(202);
    await expect(
      post(JSON.stringify(pullRequestPayload("closed")), {
        "x-github-delivery": "closed-1",
      }).then((response) => response.json())
    ).resolves.toMatchObject({ status: "ignored", action: "closed" });
    await expect(
      post(JSON.stringify({ action: "opened" }), {
        "x-github-delivery": "invalid-1",
      }).then((response) => response.status)
    ).resolves.toBe(400);

    await expect(post(payloadBody).then((response) => response.json())).resolves.toMatchObject({
      status: "queued",
      deliveryId: "delivery-1",
    });
    await hosted.queue.onIdle();
    expect(process).toHaveBeenCalledTimes(1);
    await expect(post(payloadBody).then((response) => response.json())).resolves.toMatchObject({
      status: "duplicate",
    });
    await hosted.close();
  });

  test("rejects oversized webhook bodies", async () => {
    const hosted = createHostedServer({
      environment: environment({ maxWebhookBodyBytes: 5 }),
      processor: { process: jest.fn(async () => undefined) },
      logger,
    });
    const { port } = await hosted.start();
    const body = "123456";
    const response = await fetch(`http://127.0.0.1:${port}/api/github/webhooks`, {
      method: "POST",
      headers: { "x-hub-signature-256": signature(body) },
      body,
    });
    expect(response.status).toBe(413);
    await hosted.close();
  });
});
