# Hosted GitHub App

Knowledge Diff can run as a server-side GitHub App. This avoids repository LLM secrets, works safely with public fork pull requests, and attributes checks and comments to the App installation.

The service never checks out or executes pull-request code. It reads patches and documentation through GitHub's API, validates every webhook signature before parsing the event, and obtains short-lived installation tokens for the repository that delivered the event.

## GitHub App registration

Create a GitHub App owned by the account or organization that will host the service. Configure:

- **Webhook URL:** `https://YOUR_HOST/api/github/webhooks`
- **Webhook secret:** a high-entropy secret of at least 16 characters
- **Repository permissions:**
  - Checks: **Read and write**
  - Contents: **Read-only**
  - Pull requests: **Read and write**
  - Metadata: **Read-only**
- **Subscribe to events:** Pull request

The service processes `opened`, `reopened`, `synchronize`, and `ready_for_review`. Other pull-request actions are acknowledged and ignored.

[`deploy/github-app-manifest.json`](../deploy/github-app-manifest.json) is a public-App registration template suitable for installations outside the owner's account. Replace every `YOUR_HOSTNAME` value before using it; set `public` to `false` only for owner-account staging. After registration, generate a private key and record the numeric App ID. No user OAuth authorization is required for the hosted analyzer.

GitHub documents the permission model in [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), installation authentication in [Authenticating as a GitHub App installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation), and webhook signing in [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

## Environment

Copy `.env.hosted.example` to `.env` for local Docker use. Required variables:

| Variable | Purpose |
|---|---|
| `GITHUB_APP_ID` | Numeric GitHub App ID, not the OAuth client ID. |
| `GITHUB_PRIVATE_KEY` or `GITHUB_PRIVATE_KEY_BASE64` | GitHub App PEM private key. Base64 is recommended for hosting dashboards. |
| `GITHUB_WEBHOOK_SECRET` | Secret configured on the GitHub App webhook. |
| `HOSTED_LLM_PROVIDER` | Default provider: `openai`, `anthropic`, or `gemini`. |
| Provider API key | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`. |

Repositories may select another provider only when its API key is also configured on the server. API keys are never accepted from repository configuration.

Optional operational variables:

| Variable | Default | Description |
|---|---:|---|
| `PORT` | `3000` | HTTP port. |
| `MAX_CONCURRENCY` | `2` | Simultaneous pull-request analyses. |
| `MAX_QUEUE_SIZE` | `100` | Pending PR jobs before webhook requests receive HTTP 503. |
| `MAX_WEBHOOK_BODY_BYTES` | `1048576` | Maximum signed webhook body size. |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | Graceful shutdown deadline. |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub Enterprise Server API root. |
| `GITHUB_API_VERSION` | `2026-03-10` | REST API version header. |

## Run locally

```bash
npm ci
npm run hosted:build
npm run hosted:start
```

Or run the hardened container:

```bash
docker compose up --build
```

Endpoints:

- `POST /api/github/webhooks` — signed GitHub App webhook receiver
- `GET /healthz` — liveness and queue status
- `GET /readyz` — readiness; returns 503 during shutdown

Use a webhook tunnel only for development. Production must use HTTPS at the public load balancer or platform edge, preserve the raw request body, and avoid logging request headers or secrets.

## Repository configuration

Configuration is optional. Put [`examples/knowledge-diff.yml`](../examples/knowledge-diff.yml) at `.github/knowledge-diff.yml` on the repository's default/base branch.

The hosted service deliberately reads configuration from the pull request's **base commit**, so an untrusted pull request cannot change providers, expand cost limits, or disable its own analysis. Documentation is read from the PR head commit. If documentation in a public fork is inaccessible to the installation token, the service falls back to base documentation and marks the analysis incomplete.

`fail-on-drift: true` makes the GitHub check fail when actionable drift is found. With the default `false`, drift produces a neutral check and a detailed PR comment. Provider errors, missing candidate responses, inaccessible documentation, truncated repository trees, and configured limits that omit code or docs always produce an incomplete/failing check.

The hosted MVP intentionally requests read-only Contents permission and does not create auto-patch branches. Continue using the GitHub Action with `contents: write` when automatic documentation patch PRs are required.

## Deployment and scaling

The included container runs as a non-root user with a read-only filesystem. The server acknowledges valid webhook requests quickly and processes analysis in a bounded background queue. New synchronize events replace older pending events for the same pull request, and delivery IDs are deduplicated for 24 hours.

This version is designed for a **single service instance**. Queue and delivery state are intentionally in memory. Before horizontal scaling, move the queue and delivery-idempotency records to a shared durable backend such as Redis or a managed job queue. GitHub comments remain idempotent because hosted comments have their own marker and are updated rather than duplicated.

For production operations, also configure:

- HTTPS and secret management supplied by the hosting platform;
- CPU/memory limits and autoscaling alarms based on queue depth;
- centralized JSON logs with retention and secret redaction;
- uptime monitoring for `/healthz` and `/readyz`;
- provider budgets and rate-limit alerts;
- a privacy disclosure explaining that selected code patches and documentation are sent to the configured model provider.
