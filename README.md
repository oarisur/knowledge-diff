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

1. **Reads the code diff** — what functions changed, what lines were added/removed
2. **Finds relevant doc sections** — matches changed files/symbols against your README, ARCHITECTURE.md, CLAUDE.md, and any other docs you configure
3. **Asks an LLM** — *"Does the code change contradict what the doc says?"*
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
  contents: write       # required for auto-patch
  pull-requests: write  # required to post comments

jobs:
  check-rationale-drift:
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
| `llm-model` | ❌ | `gpt-4o` / `claude-3-5-sonnet-20241022` / `gemini-2.5-flash` | Override the model. |
| `doc-files` | ❌ | `README.md,ARCHITECTURE.md,CLAUDE.md,docs/**/*.md` | Comma-separated globs of docs to check. |
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
 [Fetch doc files]  ──►  README.md, ARCHITECTURE.md, docs/**/*.md
        │
        ▼
 [Keyword index]  ──►  map: symbol/path → doc sections that mention it
        │
        ▼
 [LLM comparison]  ──►  for each (code hunk, candidate doc section):
        │                 "Does this code change contradict the doc?"
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
4. Sends only those sections to the LLM

This keeps costs low and avoids irrelevant context diluting the analysis.

---

## Required Permissions

Add these to your workflow job:

```yaml
permissions:
  contents: write       # create branches for auto-patch
  pull-requests: write  # post comments, open patch PRs
```

If `auto-patch` is `false`, you only need `pull-requests: write`.

---

## Cost Estimate

Each PR run makes approximately **N × 6** LLM calls, where N is the number of changed code files (up to `max-files-per-run`). Each call is a short prompt (~1,500 tokens) + a short completion (~500 tokens).

For a typical PR changing 5 files:
- ~30 calls × ~2,000 tokens ≈ ~60,000 tokens
- **Cost at gpt-4o pricing: ~$0.20 per PR run**

Set `max-files-per-run: 10` and `sensitivity: low` to minimise cost on large PRs.

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
