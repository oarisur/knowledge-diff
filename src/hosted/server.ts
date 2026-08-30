import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LatestJobQueue } from "./queue";
import { verifyWebhookSignature } from "./signature";
import type {
  HostedEnvironment,
  HostedLogger,
  PullRequestJob,
  PullRequestWebhookPayload,
} from "./types";

const SUPPORTED_PULL_REQUEST_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
]);

interface AnalysisProcessor {
  process(job: PullRequestJob): Promise<unknown>;
}

class BodyTooLargeError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validPullRequestPayload(value: unknown): value is PullRequestWebhookPayload {
  if (!isRecord(value) || typeof value.action !== "string") return false;
  if (!isRecord(value.repository) || typeof value.repository.full_name !== "string") {
    return false;
  }
  if (!isRecord(value.pull_request) || typeof value.pull_request.number !== "number") {
    return false;
  }
  const pullRequest = value.pull_request;
  if (!isRecord(pullRequest.head) || !isRecord(pullRequest.base)) return false;
  return (
    typeof pullRequest.head.sha === "string" &&
    typeof pullRequest.head.ref === "string" &&
    typeof pullRequest.base.sha === "string" &&
    typeof pullRequest.base.ref === "string"
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(encoded),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(encoded);
}

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maximumBytes) throw new BodyTooLargeError("Webhook body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export interface HostedServer {
  server: Server;
  queue: LatestJobQueue;
  start(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export function createHostedServer(options: {
  environment: HostedEnvironment;
  processor: AnalysisProcessor;
  logger: HostedLogger;
}): HostedServer {
  const { environment, processor, logger } = options;
  const queue = new LatestJobQueue(
    environment.maxConcurrency,
    environment.maxQueueSize
  );
  const deliveries = new Map<string, number>();

  function seenDelivery(deliveryId: string): boolean {
    const now = Date.now();
    for (const [id, expiresAt] of deliveries) {
      if (expiresAt <= now) deliveries.delete(id);
    }
    if (deliveries.has(deliveryId)) return true;
    deliveries.set(deliveryId, now + 24 * 60 * 60 * 1000);
    return false;
  }

  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;

    if (request.method === "GET" && path === "/healthz") {
      sendJson(response, 200, { status: "ok", queue: queue.stats() });
      return;
    }
    if (request.method === "GET" && path === "/readyz") {
      const stats = queue.stats();
      sendJson(response, stats.accepting ? 200 : 503, {
        status: stats.accepting ? "ready" : "shutting_down",
        queue: stats,
      });
      return;
    }
    if (request.method === "GET" && path === "/") {
      sendJson(response, 200, {
        service: "knowledge-diff-hosted",
        webhookPath: "/api/github/webhooks",
      });
      return;
    }
    if (path !== "/api/github/webhooks") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }

    try {
      const body = await readBody(request, environment.maxWebhookBodyBytes);
      if (
        !verifyWebhookSignature(
          body,
          request.headers["x-hub-signature-256"],
          environment.githubWebhookSecret
        )
      ) {
        sendJson(response, 401, { error: "invalid_signature" });
        return;
      }

      const event = headerValue(request.headers["x-github-event"]);
      const deliveryId = headerValue(request.headers["x-github-delivery"]);
      if (!event || !deliveryId) {
        sendJson(response, 400, { error: "missing_github_headers" });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        sendJson(response, 400, { error: "invalid_json" });
        return;
      }

      if (event === "ping") {
        sendJson(response, 200, { status: "pong" });
        return;
      }
      if (event !== "pull_request") {
        sendJson(response, 202, { status: "ignored", event });
        return;
      }
      if (!validPullRequestPayload(payload)) {
        sendJson(response, 400, { error: "invalid_pull_request_payload" });
        return;
      }
      if (!SUPPORTED_PULL_REQUEST_ACTIONS.has(payload.action)) {
        sendJson(response, 202, { status: "ignored", action: payload.action });
        return;
      }
      if (seenDelivery(deliveryId)) {
        sendJson(response, 202, { status: "duplicate", deliveryId });
        return;
      }

      const key = `${payload.repository.full_name}#${payload.pull_request.number}`;
      const admission = queue.enqueue(key, async () => {
        try {
          await processor.process({ deliveryId, payload });
        } catch (error) {
          logger.error("Queued pull request analysis failed", {
            deliveryId,
            repository: payload.repository.full_name,
            pullRequest: payload.pull_request.number,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      if (admission === "full" || admission === "closed") {
        deliveries.delete(deliveryId);
        sendJson(response, 503, { error: "queue_unavailable", status: admission });
        return;
      }
      sendJson(response, 202, { status: admission, deliveryId });
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendJson(response, 413, { error: "payload_too_large" });
      } else {
        logger.error("Webhook request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        sendJson(response, 500, { error: "internal_error" });
      }
    }
  });

  return {
    server,
    queue,
    start: () =>
      new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(environment.port, environment.host, () => {
          server.off("error", onError);
          const address = server.address();
          const port = typeof address === "object" && address ? address.port : environment.port;
          resolve({ host: environment.host, port });
        });
      }),
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await queue.close();
    },
  };
}
