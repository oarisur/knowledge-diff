import type { LLMProvider } from "../types";
import type { HostedEnvironment } from "./types";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}.`);
  }
  return parsed;
}

function normalizePrivateKey(env: NodeJS.ProcessEnv): string {
  const base64 = env.GITHUB_PRIVATE_KEY_BASE64?.trim();
  const raw = base64
    ? Buffer.from(base64, "base64").toString("utf8")
    : required(env, "GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n");

  if (!raw.includes("BEGIN") || !raw.includes("PRIVATE KEY")) {
    throw new Error(
      "GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_BASE64 is not a PEM private key."
    );
  }
  return raw;
}

function parseProvider(value: string | undefined): LLMProvider {
  const provider = value?.trim() || "openai";
  if (!["openai", "anthropic", "gemini"].includes(provider)) {
    throw new Error("HOSTED_LLM_PROVIDER must be openai, anthropic, or gemini.");
  }
  return provider as LLMProvider;
}

export function loadHostedEnvironment(
  env: NodeJS.ProcessEnv = process.env
): HostedEnvironment {
  const defaultProvider = parseProvider(env.HOSTED_LLM_PROVIDER);
  const llmApiKeys: HostedEnvironment["llmApiKeys"] = {
    openai: env.OPENAI_API_KEY?.trim() || undefined,
    anthropic: env.ANTHROPIC_API_KEY?.trim() || undefined,
    gemini: env.GEMINI_API_KEY?.trim() || undefined,
  };

  if (!llmApiKeys[defaultProvider]) {
    const variable =
      defaultProvider === "openai"
        ? "OPENAI_API_KEY"
        : defaultProvider === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : "GEMINI_API_KEY";
    throw new Error(`${variable} is required for the default hosted provider.`);
  }

  const webhookSecret = required(env, "GITHUB_WEBHOOK_SECRET");
  if (webhookSecret.length < 16) {
    throw new Error("GITHUB_WEBHOOK_SECRET must be at least 16 characters.");
  }

  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port: positiveInteger(env.PORT, 3000, "PORT", 65_535),
    githubAppId: positiveInteger(required(env, "GITHUB_APP_ID"), 0, "GITHUB_APP_ID"),
    githubPrivateKey: normalizePrivateKey(env),
    githubWebhookSecret: webhookSecret,
    githubApiBaseUrl: (env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(
      /\/$/,
      ""
    ),
    githubApiVersion: env.GITHUB_API_VERSION?.trim() || "2026-03-10",
    defaultProvider,
    llmApiKeys,
    maxConcurrency: positiveInteger(env.MAX_CONCURRENCY, 2, "MAX_CONCURRENCY", 20),
    maxQueueSize: positiveInteger(env.MAX_QUEUE_SIZE, 100, "MAX_QUEUE_SIZE", 10_000),
    maxWebhookBodyBytes: positiveInteger(
      env.MAX_WEBHOOK_BODY_BYTES,
      1_048_576,
      "MAX_WEBHOOK_BODY_BYTES",
      10_485_760
    ),
    shutdownTimeoutMs: positiveInteger(
      env.SHUTDOWN_TIMEOUT_MS,
      30_000,
      "SHUTDOWN_TIMEOUT_MS",
      300_000
    ),
  };
}
