# 🧠 Knowledge Diff

> **Stop your docs from lying.** A GitHub Action that detects when code changes contradict your documentation — and offers to fix them automatically.

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Knowledge%20Diff-blue?logo=github)](https://github.com/marketplace/actions/knowledge-diff)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## The Problem

Every engineering team has stale docs.

A developer refactors state management from Redux to Zustand. The code ships. The `ARCHITECTURE.md` still says *"We use Redux Toolkit for all global state."* Nobody notices — until a new hire wastes two days debugging the wrong mental model.

**Knowledge Diff sits in your CI and plays the role of a vigilant tech writer** — one that actually reads the diff.

---

## What It Does

On every pull request, Knowledge Diff:

1. **Reads the code diff** — what functions, string literals, and lines were added/removed
2. **Finds relevant doc sections** — matches changed files/symbols against project docs and AI-agent instructions such as `AGENTS.md`, `CLAUDE.md`, and Copilot instructions
3. **Asks an LLM once per changed file** — batches the relevant sections into one structured drift check
4. **Comments on the PR** — with specific, quote-level detail about what drifted
5. **Opens a patch PR** *(optional)* — with suggested doc updates ready for your review

### Example Comment

> ## 🧠 Knowledge Diff — Rationale Drift Detected
>
> ### 🔴 `src/store/cart.ts` → `ARCHITECTURE.md` — *State Management*
>
> **Definite contradiction:** The code replaced Redux `createSlice` with Zustand `create()`, but the doc still describes Redux as the state management solution.
>
> **Doc still says:**
> *"We use Redux Toolkit with createSlice for all global state."*
>
> **Suggested update:**
> ```diff
> - We use Redux Toolkit with createSlice for all global state.
> + We use Zustand for client-side global state management.
> ```

---

## Quickstart

Add this to `.github/workflows/knowledge-diff.yml`:

```yaml
name: Knowledge Diff

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read        # read the PR and documentation
  pull-requests: write  # required to post comments

jobs:
  check-rationale-drift:
    # Repository secrets are not available to pull requests from forks.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: oarisur/knowledge-diff@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

**That's it.** Every PR now gets a documentation health check.

---

## Configuration

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | ✅ | — | GitHub token for posting comments. Use `secrets.GITHUB_TOKEN`. |
| `openai-api-key` | ✅* | — | OpenAI API key. Required when `llm-provider` is `openai`. |
| `anthropic-api-key` | ✅* | — | Anthropic API key. Required when `llm-provider` is `anthropic`. |
| `gemini-api-key` | ✅* | — | Google Gemini API key. Required when `llm-provider` is `gemini`. |
| `llm-provider` | ❌ | `openai` | LLM backend: `openai`, `anthropic`, or `gemini`. |
| `llm-model` | ❌ | `gpt-4o-mini` / `claude-haiku-4-5-20251001` / `gemini-2.5-flash` | Override the model. |
| `doc-files` | ❌ | Common project docs and agent instructions | Comma-separated globs of docs to check. See [default document patterns](#default-document-patterns). |
| `code-extensions` | ❌ | `ts,tsx,js,jsx,py,go,rs,java,cpp,c,rb,php,swift,kt` | File extensions treated as code. |
| `sensitivity` | ❌ | `medium` | Drift threshold: `low` (definite only) / `medium` / `high` (includes ambiguities). |
| `auto-patch` | ❌ | `false` | Open a follow-up PR with suggested doc fixes when drift is detected. |
| `comment-mode` | ❌ | `update` | `update` = edit existing comment on re-push. `new` = always post fresh. |
| `max-files-per-run` | ❌ | `20` | Max code files to analyse per run (controls LLM cost). |

### Outputs

| Output | Description |
|---|---|
| `drift-detected` | `"true"` if any drift was found above the sensitivity threshold. |
| `drift-count` | Number of drift issues found. |
| `patch-pr-url` | URL of the auto-generated doc patch PR (empty if none created). |
| `analysis-complete` | `"true"` only when every selected candidate was analysed successfully. |
| `analysis-error-count` | Number of failures that made the analysis incomplete. |

### Default document patterns

Knowledge Diff checks normal Markdown documentation plus common instruction formats used by coding agents:

```text
README.md,ARCHITECTURE.md,docs/**/*.md,
**/AGENTS.md,**/AGENTS.override.md,**/CLAUDE.md,**/GEMINI.md,
.github/copilot-instructions.md,.github/instructions/**/*.instructions.md,
.cursor/rules/**/*.mdc,.windsurfrules,.clinerules,.clinerules/**/*.md,
.roo/rules/**/*.md
```

Set `doc-files` explicitly to replace this list.

---

## Advanced Examples

### Fail the check on definite drift

```yaml
- uses: oarisur/knowledge-diff@v1
  id: drift
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    sensitivity: low  # only definite contradictions

- name: Fail on drift
  if: steps.drift.outputs.drift-detected == 'true'
  run: |
    echo "Definite documentation drift detected. Please update your docs."
    exit 1
```

### Use Anthropic Claude instead of OpenAI

```yaml
- uses: oarisur/knowledge-diff@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    llm-provider: anthropic
```

### Use Google Gemini

```yaml
- uses: oarisur/knowledge-diff@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
    llm-provider: gemini
```

### Enable auto-patch (opens a doc-fix PR automatically)

```yaml
- uses: oarisur/knowledge-diff@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    auto-patch: "true"
```

Auto-patching also requires `contents: write`. Some organizations separately disable pull-request creation by GitHub Actions; enable that repository or organization setting before using this option.

When drift is detected, a second PR like `docs/knowledge-diff-42-a1b2c3d` is opened targeting the same base branch — with the suggested text replacement applied. You review and merge (or discard) at your discretion.

### Check only specific docs

```yaml
- uses: oarisur/knowledge-diff@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    doc-files: "docs/architecture/*.md,CLAUDE.md"
    sensitivity: high
```

---

## How It Works

```
PR opened / push to PR
        │
        ▼
 [Fetch PR diff]  ──►  changed code files only (by extension)
        │
        ▼
 [Fetch PR-head docs] ─►  project docs + AI-agent instruction files
        │
        ▼
 [Keyword index]  ──►  map: symbol/path → doc sections that mention it
        │
        ▼
 [LLM comparison]  ──►  one batched request per changed code file
        │                 evaluates up to 6 relevant doc sections
        ▼
 [Drift found?]
   ├── YES ──► Post PR comment with quote-level explanation
   │           └── auto-patch: true → open a doc-fix PR
   └── NO  ──► Post "✅ all clear" comment (updates existing one)
```

### Sensitivity Levels

| Level | What gets flagged |
|---|---|
| `low` | Only **definite** contradictions — the doc says X, the code now does Y. |
| `medium` *(default)* | Definite contradictions + **likely** outdated statements. |
| `high` | All of the above + **possible** ambiguities. Err on the side of caution. |

### Context Window Strategy

Rather than sending entire files to the LLM (expensive, slow), Knowledge Diff:
1. Splits each doc into sections by heading
2. Builds a keyword index over all sections
3. For each changed code file, looks up the **top 6 most relevant sections** by keyword overlap with the changed file path and symbol names
4. Sends the code patch and those sections in **one batched request per changed file**

This keeps costs low and avoids irrelevant context diluting the analysis.

---

## Required Permissions

For comment-only mode, add:

```yaml
permissions:
  contents: read
  pull-requests: write
```

For `auto-patch: "true"`, change `contents` to `write`. GitHub Actions must also be allowed to create pull requests in the repository or organization settings.

### Pull requests from forks

GitHub does not pass repository secrets (including LLM API keys) to normal `pull_request` workflows from forks, and the fork's `GITHUB_TOKEN` is normally read-only. Skip the job for fork PRs:

```yaml
if: github.event.pull_request.head.repo.full_name == github.repository
```

Do not switch to `pull_request_target` while checking out or executing untrusted pull-request code; that can expose secrets to malicious changes. A hosted GitHub App is the safer way to support untrusted fork PRs.

---

## Cost Estimate

Each PR run makes at most **N LLM calls**, where N is the number of changed code files (up to `max-files-per-run`). Up to six relevant documentation sections are batched into each call.

For a typical PR changing 5 files:
- Up to 5 model requests instead of 30 individual candidate requests
- Approximately 30,000 input tokens plus 6,000 output tokens in a section-heavy run
- Roughly **$0.01 at current `gpt-4o-mini` pricing**; actual usage depends on patch and section sizes

See [official OpenAI model pricing](https://developers.openai.com/api/docs/models/gpt-4o-mini). Set `max-files-per-run: 10` to cap cost on large PRs.

---

## Local Development

```bash
git clone https://github.com/oarisur/knowledge-diff
cd knowledge-diff
npm install
npm run build       # bundles to dist/index.js via ncc
npm test            # run unit tests
npm run typecheck   # verify TypeScript
npm run lint        # ESLint checks
```

---

## License

MIT — see [LICENSE](LICENSE).

---

## Contributing

PRs welcome. The action dogfoods itself — any change to `src/` that contradicts this `README.md` will be caught by its own CI. 🧠
