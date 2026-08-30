import { createSign } from "node:crypto";
import * as github from "@actions/github";
import type { GitHub } from "@actions/github/lib/utils";

export type OctokitClient = InstanceType<typeof GitHub>;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

interface InstallationTokenResponse {
  token?: unknown;
  expires_at?: unknown;
}

export interface InstallationClientFactory {
  forInstallation(installationId: number): Promise<OctokitClient>;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Create the short-lived RS256 JWT used to request installation tokens. */
export function createGitHubAppJwt(
  appId: number,
  privateKey: string,
  nowMs = Date.now()
): string {
  const nowSeconds = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iat: nowSeconds - 30,
      exp: nowSeconds + 9 * 60,
      iss: String(appId),
    })
  );
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${base64Url(signer.sign(privateKey))}`;
}

export class GitHubAppInstallationClients implements InstallationClientFactory {
  private readonly appId: number;
  private readonly privateKey: string;
  private readonly apiBaseUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tokens = new Map<number, CachedToken>();
  private readonly pending = new Map<number, Promise<string>>();

  constructor(options: {
    appId: number;
    privateKey: string;
    apiBaseUrl: string;
    apiVersion: string;
    fetchImpl?: typeof fetch;
  }) {
    this.appId = options.appId;
    this.privateKey = options.privateKey;
    this.apiBaseUrl = options.apiBaseUrl;
    this.apiVersion = options.apiVersion;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async forInstallation(installationId: number): Promise<OctokitClient> {
    const token = await this.getToken(installationId);
    return github.getOctokit(token, { baseUrl: this.apiBaseUrl });
  }

  private async getToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAtMs - 60_000 > Date.now()) return cached.token;

    const inFlight = this.pending.get(installationId);
    if (inFlight) return inFlight;

    const request = this.requestToken(installationId).finally(() => {
      this.pending.delete(installationId);
    });
    this.pending.set(installationId, request);
    return request;
  }

  private async requestToken(installationId: number): Promise<string> {
    const jwt = createGitHubAppJwt(this.appId, this.privateKey);
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
          "User-Agent": "knowledge-diff-hosted",
          "X-GitHub-Api-Version": this.apiVersion,
        },
        body: JSON.stringify({
          permissions: {
            checks: "write",
            contents: "read",
            pull_requests: "write",
          },
        }),
        signal: AbortSignal.timeout(30_000),
      }
    );

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(
        `GitHub installation-token request failed (${response.status}): ${raw.slice(0, 300)}`
      );
    }

    let parsed: InstallationTokenResponse;
    try {
      parsed = JSON.parse(raw) as InstallationTokenResponse;
    } catch {
      throw new Error("GitHub installation-token response was not valid JSON.");
    }
    if (typeof parsed.token !== "string" || typeof parsed.expires_at !== "string") {
      throw new Error("GitHub installation-token response was missing token fields.");
    }

    const expiresAtMs = Date.parse(parsed.expires_at);
    if (Number.isNaN(expiresAtMs)) {
      throw new Error("GitHub installation-token response had an invalid expiry.");
    }

    this.tokens.set(installationId, { token: parsed.token, expiresAtMs });
    return parsed.token;
  }
}
