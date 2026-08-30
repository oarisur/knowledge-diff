import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { LLMClient, DEFAULT_MODELS } from "./llm-client";
import {
  DEFAULT_QUALITY_THRESHOLDS,
  evaluateQualityGate,
  renderEvaluationReport,
  runEvaluation,
  type EvaluationDataset,
  type PricingSnapshot,
  type QualityThresholds,
} from "./evaluation";
import type { LLMProvider, Sensitivity } from "./types";

interface CliOptions {
  datasetPath: string;
  provider?: LLMProvider;
  model?: string;
  sensitivity: Sensitivity;
  outputPath?: string;
  tag?: string;
  maxCases?: number;
  gate: boolean;
  thresholds: QualityThresholds;
  inputPrice?: number;
  outputPrice?: number;
}

const PRICING: Record<LLMProvider, PricingSnapshot> = {
  openai: {
    inputPerMillionUsd: 0.15,
    outputPerMillionUsd: 0.6,
    asOf: "2026-08-30",
    source: "https://developers.openai.com/api/docs/models/gpt-4o-mini",
  },
  anthropic: {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 5,
    asOf: "2026-08-30",
    source: "https://www.anthropic.com/claude/haiku",
  },
  gemini: {
    inputPerMillionUsd: 0.3,
    outputPerMillionUsd: 2.5,
    asOf: "2026-08-30",
    source: "https://ai.google.dev/gemini-api/docs/pricing",
  },
};

const API_KEY_ENV: Record<LLMProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const HELP = `Knowledge Diff evaluation

Usage:
  npm run evaluate -- [options]

Without --provider, runs the deterministic candidate-retrieval benchmark.
With --provider, runs the full live classification benchmark.

Options:
  --provider <openai|anthropic|gemini>  Run live classification
  --model <id>                         Override the provider's default model
  --dataset <path>                     Dataset JSON (default: evaluation/benchmark.v1.json)
  --sensitivity <low|medium|high>       Drift threshold (default: medium)
  --tag <tag>                           Run only cases with this tag
  --max-cases <n>                       Limit the selected cases
  --output <path>                       Write the complete JSON report
  --gate                                Exit non-zero when quality thresholds fail
  --min-retrieval-recall <0..1>         Default: 0.95
  --min-precision <0..1>                Default: 0.85
  --min-recall <0..1>                   Default: 0.80
  --min-target-recall <0..1>            Default: 0.80
  --max-failure-rate <0..1>             Default: 0.05
  --input-price <usd-per-million>        Override estimated input-token price
  --output-price <usd-per-million>       Override estimated output-token price
  --help                                 Show this help

Live API keys are read from OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY.
`;

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function parseUnitInterval(value: string, option: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${option} must be a number between 0 and 1.`);
  }
  return number;
}

function parseNonNegative(value: string, option: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${option} must be a non-negative number.`);
  }
  return number;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    datasetPath: "evaluation/benchmark.v1.json",
    sensitivity: "medium",
    gate: false,
    thresholds: { ...DEFAULT_QUALITY_THRESHOLDS },
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg === "--gate") {
      options.gate = true;
    } else if (arg === "--provider") {
      const value = requireValue(args, index, arg);
      if (!["openai", "anthropic", "gemini"].includes(value)) {
        throw new Error(`Unknown provider: ${value}`);
      }
      options.provider = value as LLMProvider;
      index++;
    } else if (arg === "--model") {
      options.model = requireValue(args, index, arg);
      index++;
    } else if (arg === "--dataset") {
      options.datasetPath = requireValue(args, index, arg);
      index++;
    } else if (arg === "--sensitivity") {
      const value = requireValue(args, index, arg);
      if (!["low", "medium", "high"].includes(value)) {
        throw new Error(`Unknown sensitivity: ${value}`);
      }
      options.sensitivity = value as Sensitivity;
      index++;
    } else if (arg === "--tag") {
      options.tag = requireValue(args, index, arg);
      index++;
    } else if (arg === "--max-cases") {
      const value = Number(requireValue(args, index, arg));
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--max-cases must be a positive integer.");
      }
      options.maxCases = value;
      index++;
    } else if (arg === "--output") {
      options.outputPath = requireValue(args, index, arg);
      index++;
    } else if (arg === "--min-retrieval-recall") {
      options.thresholds.minRetrievalRecallAt6 = parseUnitInterval(
        requireValue(args, index, arg),
        arg
      );
      index++;
    } else if (arg === "--min-precision") {
      options.thresholds.minPrecision = parseUnitInterval(
        requireValue(args, index, arg),
        arg
      );
      index++;
    } else if (arg === "--min-recall") {
      options.thresholds.minRecall = parseUnitInterval(
        requireValue(args, index, arg),
        arg
      );
      index++;
    } else if (arg === "--min-target-recall") {
      options.thresholds.minPositiveTargetRecall = parseUnitInterval(
        requireValue(args, index, arg),
        arg
      );
      index++;
    } else if (arg === "--max-failure-rate") {
      options.thresholds.maxFailureRate = parseUnitInterval(
        requireValue(args, index, arg),
        arg
      );
      index++;
    } else if (arg === "--input-price") {
      options.inputPrice = parseNonNegative(requireValue(args, index, arg), arg);
      index++;
    } else if (arg === "--output-price") {
      options.outputPrice = parseNonNegative(requireValue(args, index, arg), arg);
      index++;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if ((options.inputPrice === undefined) !== (options.outputPrice === undefined)) {
    throw new Error("--input-price and --output-price must be provided together.");
  }
  return options;
}

function filterDataset(dataset: EvaluationDataset, options: CliOptions): EvaluationDataset {
  let cases = dataset.cases;
  if (options.tag) cases = cases.filter((item) => item.tags.includes(options.tag!));
  if (options.maxCases) cases = cases.slice(0, options.maxCases);
  if (cases.length === 0) throw new Error("No evaluation cases matched the filters.");

  return { ...dataset, cases };
}

function resolvePricing(options: CliOptions): PricingSnapshot | undefined {
  if (!options.provider) return undefined;
  if (options.inputPrice !== undefined && options.outputPrice !== undefined) {
    return {
      inputPerMillionUsd: options.inputPrice,
      outputPerMillionUsd: options.outputPrice,
      asOf: new Date().toISOString().slice(0, 10),
      source: "CLI override",
    };
  }

  const defaultModel = DEFAULT_MODELS[options.provider];
  if (options.model && options.model !== defaultModel) return undefined;
  return PRICING[options.provider];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const datasetPath = resolve(options.datasetPath);
  const dataset = filterDataset(
    JSON.parse(await readFile(datasetPath, "utf8")) as EvaluationDataset,
    options
  );

  let classifier: LLMClient | undefined;
  let model: string | undefined;
  if (options.provider) {
    const envName = API_KEY_ENV[options.provider];
    const apiKey = process.env[envName];
    if (!apiKey) throw new Error(`${envName} is required for live evaluation.`);
    model = options.model ?? DEFAULT_MODELS[options.provider];
    classifier = new LLMClient(options.provider, apiKey, options.model);
  }

  const report = await runEvaluation(dataset, {
    sensitivity: options.sensitivity,
    classifier,
    provider: options.provider,
    model,
    pricing: resolvePricing(options),
  });
  const gate = options.gate ? evaluateQualityGate(report, options.thresholds) : undefined;
  process.stdout.write(`${renderEvaluationReport(report, gate)}\n`);

  if (options.outputPath) {
    const outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify({ report, gate }, null, 2)}\n`, "utf8");
    process.stdout.write(`Report written to ${outputPath}\n`);
  }

  if (gate && !gate.passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`Evaluation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
