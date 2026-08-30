import type { LLMProvider, Sensitivity } from "../types";

export interface HostedLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warning(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface HostedEnvironment {
  host: string;
  port: number;
  githubAppId: number;
  githubPrivateKey: string;
  githubWebhookSecret: string;
  githubApiBaseUrl: string;
  githubApiVersion: string;
  defaultProvider: LLMProvider;
  llmApiKeys: Partial<Record<LLMProvider, string>>;
  maxConcurrency: number;
  maxQueueSize: number;
  maxWebhookBodyBytes: number;
  shutdownTimeoutMs: number;
}

export interface RepositoryConfig {
  enabled: boolean;
  provider: LLMProvider;
  model: string;
  sensitivity: Sensitivity;
  docGlobs: string[];
  codeExtensions: string[];
  maxFilesPerRun: number;
  maxDocFiles: number;
  commentMode: "update" | "new";
  failOnDrift: boolean;
  skipDrafts: boolean;
  ignoredAuthors: string[];
  ignoredBranches: string[];
}

export interface PullRequestWebhookPayload {
  action: string;
  installation?: { id: number };
  sender?: { login?: string };
  repository: {
    name: string;
    full_name: string;
    owner: { login: string };
  };
  pull_request: {
    number: number;
    draft?: boolean;
    head: {
      sha: string;
      ref: string;
      repo: null | {
        name: string;
        full_name: string;
        owner: { login: string };
      };
    };
    base: {
      sha: string;
      ref: string;
      repo: {
        name: string;
        full_name: string;
        owner: { login: string };
      };
    };
  };
}

export interface PullRequestJob {
  deliveryId: string;
  payload: PullRequestWebhookPayload;
}
