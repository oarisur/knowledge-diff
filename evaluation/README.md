# Knowledge Diff Quality Evaluation

This directory contains the versioned, human-reviewed benchmark used to measure detection quality.

## What is measured

The evaluator treats quality as two separate stages:

1. **Candidate retrieval** checks whether the documented section relevant to a code change appears in the engine's top six candidates. This stage is deterministic, requires no API key, and runs in CI.
2. **LLM classification** sends exactly those candidates through the production prompt and provider client. It measures candidate-level precision, recall, F1, false-positive rate, correct-target recall, provider failures, latency, estimated tokens, and estimated cost.

Keeping the stages separate makes failures actionable: a retrieval miss requires indexing work, while a correctly retrieved but misclassified case requires prompt or model work.

## Commands

```bash
# Deterministic CI gate
npm run evaluate:gate

# Full live benchmark; set the provider API-key environment variable first
npm run evaluate -- --provider openai --gate --output evaluation/results/openai.json
```

Supported providers and environment variables:

| Provider | Environment variable | Default model |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | `gpt-4o-mini` |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-haiku-4-5-20251001` |
| Gemini | `GEMINI_API_KEY` | `gemini-2.5-flash` |

Useful options:

```text
--tag security
--max-cases 5
--sensitivity low|medium|high
--model <provider-model-id>
--min-precision 0.90
--min-recall 0.85
--min-target-recall 0.85
--max-failure-rate 0.02
--input-price <USD per million tokens>
--output-price <USD per million tokens>
```

Run `npm run evaluate -- --help` for the complete option list.

## Metric definitions

- **Retrieval recall@6:** fraction of cases whose labeled relevant document appears in the top six candidates.
- **Mean reciprocal rank:** rewards placing the relevant document nearer the top of the candidate list.
- **Candidate precision:** correct drift findings divided by all drift findings. This is the primary false-alarm measure.
- **Candidate recall:** correctly detected labeled contradictions divided by all labeled contradictions, including retrieval misses.
- **Correct positive target recall:** positive cases where the model flags the specifically labeled document, preventing an unrelated false alarm from being counted as a successful detection.
- **Failure rate:** cases affected by provider errors or omitted candidate responses.
- **Estimated cost:** approximate character-based token counts multiplied by a dated pricing snapshot. Provider invoices remain authoritative.

## Adding cases

Add cases to `benchmark.v1.json`. Every case needs:

- a stable, unique id;
- a realistic unified code patch;
- one or more documentation files;
- the relevant document path;
- a human-reviewed drift/no-drift label;
- tags for focused model comparisons.

Keep the benchmark balanced. Favor difficult negative examples—additive changes, harmless refactors, configurable values, and non-exhaustive documentation—because false positives are the fastest way to lose reviewer trust.

When a real pull request exposes a false positive or false negative:

1. anonymize proprietary names and values;
2. reduce it to the smallest patch and documentation section that reproduces the behavior;
3. add it without changing the expected label to accommodate a model;
4. run the retrieval gate and at least one live provider evaluation;
5. save the JSON report as a release or CI artifact for comparison.

## Current benchmark scope

Version 1.0.0 contains 30 cases, evenly split between drift and no drift. It covers architecture migrations, API versions, databases, authentication, deployment, security algorithms, feature defaults, harmless refactors, additive functionality, dependency maintenance, and configuration changes.

This starter dataset demonstrates repeatability and guards regressions. Commercial quality claims should additionally use anonymized cases collected from beta repositories that were not used to tune the prompt.
