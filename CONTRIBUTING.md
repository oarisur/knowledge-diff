# Contributing to Knowledge Diff

Thanks for considering a contribution! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/oarisur/knowledge-diff
cd knowledge-diff
npm install
```

## Workflow

1. **Create a branch** from `main` for your change.
2. **Make your changes** in `src/`.
3. **Run checks** before committing:

```bash
npm run typecheck   # TypeScript strict checks
npm run lint        # ESLint
npm test            # Jest unit tests
npm run evaluate:gate # deterministic candidate-retrieval quality gate
npm run build       # Bundle to dist/ via ncc
npm run hosted:build # Bundle the hosted GitHub App server
```

4. **Commit `dist/`** — GitHub Actions require the bundled output to be checked in.
5. **Open a PR** — the CI will run type-checking, tests, and the action itself against its own README (dogfooding).

## Code Style

- TypeScript with strict mode enabled.
- Prefer explicit types over `any`.
- Use `@actions/core` for logging (`core.info`, `core.debug`, `core.warning`).
- Keep modules focused: parser, extractor, detector, commenter, patcher.

## Tests

- All tests live in `__tests__/` and use Jest with `ts-jest`.
- Test fixtures go in `__tests__/fixtures/`.
- Mock `@actions/core` in every test file to suppress CI logging.
- Aim for high coverage on pure-logic modules; mock external APIs (LLM, GitHub).
- Add anonymized false positives and false negatives to `evaluation/benchmark.v1.json` so they remain fixed regressions.

## Reporting Issues

Please include:
- The workflow YAML you're using
- The PR that triggered the issue (if public)
- The full action log output

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
