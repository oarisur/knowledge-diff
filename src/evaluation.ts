import { buildDriftBatchPrompt } from "./llm-client";
import { buildDocIndex, findCandidateSections, parseDocFile } from "./doc-extractor";
import { parsePRFiles } from "./diff-parser";
import type {
  DriftCandidate,
  LLMBatchDriftResult,
  LLMDocCandidate,
  LLMProvider,
  Sensitivity,
} from "./types";

export interface EvaluationDoc {
  filePath: string;
  content: string;
}

export interface EvaluationCase {
  id: string;
  description: string;
  tags: string[];
  codeFilePath: string;
  patch: string;
  docs: EvaluationDoc[];
  expected: {
    isDrift: boolean;
    /** The relevant documentation file, whether or not it contains drift. */
    docFilePath: string;
    /** Optional heading to disambiguate multiple sections in one document. */
    heading?: string;
  };
}

export interface EvaluationDataset {
  name: string;
  version: string;
  description: string;
  sharedDocs?: EvaluationDoc[];
  cases: EvaluationCase[];
}

export interface EvaluationClassifier {
  detectDriftBatch(
    codeFilePath: string,
    patch: string,
    candidates: LLMDocCandidate[],
    sensitivity: Sensitivity
  ): Promise<LLMBatchDriftResult[]>;
}

export interface PricingSnapshot {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  asOf: string;
  source: string;
}

export interface ConfusionMatrix {
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
}

export interface ClassificationMetrics extends ConfusionMatrix {
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  falsePositiveRate: number;
}

export interface EvaluationCaseResult {
  id: string;
  expectedDrift: boolean;
  predictedDrift?: boolean;
  targetDriftPredicted?: boolean;
  expectedDocFilePath: string;
  expectedDocRank: number | null;
  retrievedDocFiles: string[];
  candidateCount: number;
  latencyMs?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  missingResponseCount?: number;
  error?: string;
}

export interface EvaluationReport {
  schemaVersion: 1;
  generatedAt: string;
  mode: "retrieval" | "live";
  dataset: {
    name: string;
    version: string;
    description: string;
    totalCases: number;
    positiveCases: number;
    negativeCases: number;
  };
  provider?: LLMProvider;
  model?: string;
  sensitivity: Sensitivity;
  pricing?: PricingSnapshot;
  metrics: {
    retrievalRecallAt6: number;
    positiveRetrievalRecallAt6: number;
    meanReciprocalRank: number;
    classification?: ClassificationMetrics;
    caseClassification?: ClassificationMetrics;
    positiveTargetRecall?: number;
    failedCases: number;
    failureRate: number;
    latencyMs?: {
      mean: number;
      p50: number;
      p95: number;
    };
    estimatedTokens?: {
      input: number;
      output: number;
    };
    estimatedCostUsd?: number;
  };
  cases: EvaluationCaseResult[];
}

export interface EvaluationOptions {
  sensitivity: Sensitivity;
  classifier?: EvaluationClassifier;
  provider?: LLMProvider;
  model?: string;
  pricing?: PricingSnapshot;
}

export interface QualityThresholds {
  minRetrievalRecallAt6: number;
  minPrecision: number;
  minRecall: number;
  minPositiveTargetRecall: number;
  maxFailureRate: number;
}

export interface QualityGateResult {
  passed: boolean;
  failures: string[];
}

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  minRetrievalRecallAt6: 0.95,
  minPrecision: 0.85,
  minRecall: 0.8,
  minPositiveTargetRecall: 0.8,
  maxFailureRate: 0.05,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

export function calculateClassificationMetrics(
  matrix: ConfusionMatrix
): ClassificationMetrics {
  const precision = ratio(
    matrix.truePositives,
    matrix.truePositives + matrix.falsePositives
  );
  const recall = ratio(
    matrix.truePositives,
    matrix.truePositives + matrix.falseNegatives
  );

  return {
    ...matrix,
    precision: round(precision),
    recall: round(recall),
    f1: round(ratio(2 * precision * recall, precision + recall)),
    accuracy: round(
      ratio(
        matrix.truePositives + matrix.trueNegatives,
        matrix.truePositives +
          matrix.falsePositives +
          matrix.trueNegatives +
          matrix.falseNegatives
      )
    ),
    falsePositiveRate: round(
      ratio(matrix.falsePositives, matrix.falsePositives + matrix.trueNegatives)
    ),
  };
}

export function validateEvaluationDataset(dataset: EvaluationDataset): string[] {
  const errors: string[] = [];
  if (!dataset.name?.trim()) errors.push("Dataset name is required.");
  if (!dataset.version?.trim()) errors.push("Dataset version is required.");
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) {
    errors.push("Dataset must contain at least one case.");
    return errors;
  }

  const ids = new Set<string>();
  for (const evaluationCase of dataset.cases) {
    if (!evaluationCase.id?.trim()) {
      errors.push("Every case must have a non-empty id.");
    } else if (ids.has(evaluationCase.id)) {
      errors.push(`Duplicate case id: ${evaluationCase.id}`);
    }
    ids.add(evaluationCase.id);

    if (!evaluationCase.codeFilePath?.includes(".")) {
      errors.push(`${evaluationCase.id}: codeFilePath must have an extension.`);
    }
    if (!evaluationCase.patch?.trim()) {
      errors.push(`${evaluationCase.id}: patch is required.`);
    }

    const allDocs = [...(dataset.sharedDocs ?? []), ...(evaluationCase.docs ?? [])];
    if (!allDocs.some((doc) => doc.filePath === evaluationCase.expected?.docFilePath)) {
      errors.push(
        `${evaluationCase.id}: expected doc ${evaluationCase.expected?.docFilePath ?? "(missing)"} is not present.`
      );
    }

  }

  return errors;
}

function mergeDocs(sharedDocs: EvaluationDoc[], caseDocs: EvaluationDoc[]): EvaluationDoc[] {
  const docs = new Map<string, EvaluationDoc>();
  for (const doc of sharedDocs) docs.set(doc.filePath, doc);
  for (const doc of caseDocs) docs.set(doc.filePath, doc);
  return [...docs.values()];
}

function prepareCase(
  evaluationCase: EvaluationCase,
  sharedDocs: EvaluationDoc[]
): {
  candidates: DriftCandidate[];
  expectedDocRank: number | null;
  changedFile: DriftCandidate["changedFile"];
} {
  const extension = evaluationCase.codeFilePath.split(".").pop()?.toLowerCase();
  if (!extension) throw new Error("Code file path has no extension.");

  const { changedFiles } = parsePRFiles(
    [
      {
        filename: evaluationCase.codeFilePath,
        patch: evaluationCase.patch,
        status: "modified",
      },
    ],
    [extension],
    1,
    true
  );
  const changedFile = changedFiles[0];
  if (!changedFile) throw new Error("Evaluation patch could not be parsed.");

  const rawDocs = mergeDocs(sharedDocs, evaluationCase.docs);
  const docFiles = rawDocs.map((doc) => parseDocFile(doc.filePath, doc.content, true));
  const candidates = findCandidateSections(changedFile, buildDocIndex(docFiles), 6);
  const rank = candidates.findIndex(
    (candidate) =>
      candidate.matchedSection.filePath === evaluationCase.expected.docFilePath &&
      (!evaluationCase.expected.heading ||
        candidate.matchedSection.heading === evaluationCase.expected.heading)
  );

  return {
    candidates,
    expectedDocRank: rank === -1 ? null : rank + 1,
    changedFile,
  };
}

function meetsThreshold(
  result: LLMBatchDriftResult,
  sensitivity: Sensitivity
): boolean {
  if (!result.isDrift) return false;
  const ranks = { definite: 0, likely: 1, possible: 2 } as const;
  const thresholds = { low: 0, medium: 1, high: 2 } as const;
  return ranks[result.confidence] <= thresholds[sensitivity];
}

function updateMatrix(
  matrix: ConfusionMatrix,
  expectedPositive: boolean,
  predictedPositive: boolean
): void {
  if (expectedPositive && predictedPositive) matrix.truePositives++;
  else if (!expectedPositive && predictedPositive) matrix.falsePositives++;
  else if (expectedPositive) matrix.falseNegatives++;
  else matrix.trueNegatives++;
}

export async function runEvaluation(
  dataset: EvaluationDataset,
  options: EvaluationOptions
): Promise<EvaluationReport> {
  const validationErrors = validateEvaluationDataset(dataset);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid evaluation dataset:\n- ${validationErrors.join("\n- ")}`);
  }

  const caseResults: EvaluationCaseResult[] = [];
  const candidateMatrix: ConfusionMatrix = {
    truePositives: 0,
    falsePositives: 0,
    trueNegatives: 0,
    falseNegatives: 0,
  };
  const caseMatrix: ConfusionMatrix = { ...candidateMatrix };
  const latencies: number[] = [];
  let retrieved = 0;
  let positiveRetrieved = 0;
  let reciprocalRankSum = 0;
  let failedCases = 0;
  let positiveTargetHits = 0;
  let estimatedInputTokens = 0;
  let estimatedOutputTokens = 0;

  const positiveCases = dataset.cases.filter((item) => item.expected.isDrift).length;

  for (const evaluationCase of dataset.cases) {
    let prepared: ReturnType<typeof prepareCase>;
    try {
      prepared = prepareCase(evaluationCase, dataset.sharedDocs ?? []);
    } catch (error) {
      failedCases++;
      caseResults.push({
        id: evaluationCase.id,
        expectedDrift: evaluationCase.expected.isDrift,
        expectedDocFilePath: evaluationCase.expected.docFilePath,
        expectedDocRank: null,
        retrievedDocFiles: [],
        candidateCount: 0,
        error: errorMessage(error),
      });
      if (options.classifier) {
        updateMatrix(caseMatrix, evaluationCase.expected.isDrift, false);
        if (evaluationCase.expected.isDrift) {
          updateMatrix(candidateMatrix, true, false);
        }
      }
      continue;
    }

    if (prepared.expectedDocRank !== null) {
      retrieved++;
      reciprocalRankSum += 1 / prepared.expectedDocRank;
      if (evaluationCase.expected.isDrift) positiveRetrieved++;
    }

    const result: EvaluationCaseResult = {
      id: evaluationCase.id,
      expectedDrift: evaluationCase.expected.isDrift,
      expectedDocFilePath: evaluationCase.expected.docFilePath,
      expectedDocRank: prepared.expectedDocRank,
      retrievedDocFiles: prepared.candidates.map(
        (candidate) => candidate.matchedSection.filePath
      ),
      candidateCount: prepared.candidates.length,
    };

    if (!options.classifier) {
      caseResults.push(result);
      continue;
    }

    const llmCandidates = prepared.candidates.map((candidate) => ({
      docFilePath: candidate.matchedSection.filePath,
      docHeading: candidate.matchedSection.heading,
      docContent: candidate.matchedSection.content,
    }));
    const prompt = buildDriftBatchPrompt(
      prepared.changedFile.filePath,
      prepared.changedFile.patch,
      llmCandidates,
      options.sensitivity
    );
    result.estimatedInputTokens = Math.ceil(prompt.length / 4);
    estimatedInputTokens += result.estimatedInputTokens;

    let responses: LLMBatchDriftResult[] = [];
    const startedAt = Date.now();
    try {
      responses = await options.classifier.detectDriftBatch(
        prepared.changedFile.filePath,
        prepared.changedFile.patch,
        llmCandidates,
        options.sensitivity
      );
    } catch (error) {
      result.error = errorMessage(error);
      failedCases++;
    }
    result.latencyMs = Date.now() - startedAt;
    latencies.push(result.latencyMs);
    result.estimatedOutputTokens = Math.ceil(JSON.stringify(responses).length / 4);
    estimatedOutputTokens += result.estimatedOutputTokens;

    const responsesByIndex = new Map(
      responses.map((response) => [response.candidateIndex, response])
    );
    const actionableIndices = new Set<number>();
    let missingResponses = 0;

    for (let index = 0; index < prepared.candidates.length; index++) {
      const candidate = prepared.candidates[index];
      const response = responsesByIndex.get(index);
      if (!response) missingResponses++;
      const predictedPositive = response ? meetsThreshold(response, options.sensitivity) : false;
      if (predictedPositive) actionableIndices.add(index);

      const expectedPositive =
        evaluationCase.expected.isDrift &&
        candidate.matchedSection.filePath === evaluationCase.expected.docFilePath &&
        (!evaluationCase.expected.heading ||
          candidate.matchedSection.heading === evaluationCase.expected.heading);
      updateMatrix(candidateMatrix, expectedPositive, predictedPositive);
    }

    if (prepared.expectedDocRank === null && evaluationCase.expected.isDrift) {
      updateMatrix(candidateMatrix, true, false);
    }

    if (missingResponses > 0) {
      result.missingResponseCount = missingResponses;
      if (!result.error) {
        result.error = `Model omitted ${missingResponses} candidate response(s).`;
        failedCases++;
      }
    }

    const predictedDrift = actionableIndices.size > 0;
    const targetIndex = prepared.expectedDocRank === null
      ? -1
      : prepared.expectedDocRank - 1;
    const targetDriftPredicted = targetIndex >= 0 && actionableIndices.has(targetIndex);
    result.predictedDrift = predictedDrift;
    result.targetDriftPredicted = targetDriftPredicted;
    if (evaluationCase.expected.isDrift && targetDriftPredicted) positiveTargetHits++;
    updateMatrix(caseMatrix, evaluationCase.expected.isDrift, predictedDrift);
    caseResults.push(result);
  }

  const liveMode = Boolean(options.classifier);
  const report: EvaluationReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: liveMode ? "live" : "retrieval",
    dataset: {
      name: dataset.name,
      version: dataset.version,
      description: dataset.description,
      totalCases: dataset.cases.length,
      positiveCases,
      negativeCases: dataset.cases.length - positiveCases,
    },
    provider: options.provider,
    model: options.model,
    sensitivity: options.sensitivity,
    pricing: options.pricing,
    metrics: {
      retrievalRecallAt6: round(ratio(retrieved, dataset.cases.length)),
      positiveRetrievalRecallAt6: round(ratio(positiveRetrieved, positiveCases)),
      meanReciprocalRank: round(ratio(reciprocalRankSum, dataset.cases.length)),
      failedCases,
      failureRate: round(ratio(failedCases, dataset.cases.length)),
    },
    cases: caseResults,
  };

  if (liveMode) {
    report.metrics.classification = calculateClassificationMetrics(candidateMatrix);
    report.metrics.caseClassification = calculateClassificationMetrics(caseMatrix);
    report.metrics.positiveTargetRecall = round(
      ratio(positiveTargetHits, positiveCases)
    );
    report.metrics.latencyMs = {
      mean: round(ratio(latencies.reduce((sum, value) => sum + value, 0), latencies.length), 2),
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    };
    report.metrics.estimatedTokens = {
      input: estimatedInputTokens,
      output: estimatedOutputTokens,
    };
    if (options.pricing) {
      report.metrics.estimatedCostUsd = round(
        (estimatedInputTokens / 1_000_000) * options.pricing.inputPerMillionUsd +
          (estimatedOutputTokens / 1_000_000) * options.pricing.outputPerMillionUsd,
        8
      );
    }
  }

  return report;
}

export function evaluateQualityGate(
  report: EvaluationReport,
  thresholds: QualityThresholds = DEFAULT_QUALITY_THRESHOLDS
): QualityGateResult {
  const failures: string[] = [];
  if (report.metrics.retrievalRecallAt6 < thresholds.minRetrievalRecallAt6) {
    failures.push(
      `Retrieval recall@6 ${report.metrics.retrievalRecallAt6.toFixed(3)} is below ${thresholds.minRetrievalRecallAt6.toFixed(3)}.`
    );
  }

  if (report.mode === "live") {
    const classification = report.metrics.classification;
    if (!classification) {
      failures.push("Live report is missing classification metrics.");
    } else {
      if (classification.precision < thresholds.minPrecision) {
        failures.push(
          `Precision ${classification.precision.toFixed(3)} is below ${thresholds.minPrecision.toFixed(3)}.`
        );
      }
      if (classification.recall < thresholds.minRecall) {
        failures.push(
          `Recall ${classification.recall.toFixed(3)} is below ${thresholds.minRecall.toFixed(3)}.`
        );
      }
    }

    if (
      (report.metrics.positiveTargetRecall ?? 0) < thresholds.minPositiveTargetRecall
    ) {
      failures.push(
        `Positive target recall ${(report.metrics.positiveTargetRecall ?? 0).toFixed(3)} is below ${thresholds.minPositiveTargetRecall.toFixed(3)}.`
      );
    }
  }

  if (report.metrics.failureRate > thresholds.maxFailureRate) {
    failures.push(
      `Failure rate ${report.metrics.failureRate.toFixed(3)} exceeds ${thresholds.maxFailureRate.toFixed(3)}.`
    );
  }

  return { passed: failures.length === 0, failures };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderEvaluationReport(
  report: EvaluationReport,
  gate?: QualityGateResult
): string {
  const lines = [
    `Knowledge Diff quality evaluation`,
    `Dataset: ${report.dataset.name} v${report.dataset.version} (${report.dataset.totalCases} cases: ${report.dataset.positiveCases} drift, ${report.dataset.negativeCases} no drift)`,
    `Mode: ${report.mode}${report.provider ? ` | Provider: ${report.provider} | Model: ${report.model}` : ""}`,
    "",
    `Retrieval recall@6: ${percent(report.metrics.retrievalRecallAt6)}`,
    `Positive retrieval recall@6: ${percent(report.metrics.positiveRetrievalRecallAt6)}`,
    `Mean reciprocal rank: ${report.metrics.meanReciprocalRank.toFixed(3)}`,
  ];

  if (report.metrics.classification) {
    const metrics = report.metrics.classification;
    lines.push(
      "",
      `Candidate precision: ${percent(metrics.precision)}`,
      `Candidate recall: ${percent(metrics.recall)}`,
      `Candidate F1: ${percent(metrics.f1)}`,
      `False-positive rate: ${percent(metrics.falsePositiveRate)}`,
      `Confusion matrix: TP ${metrics.truePositives} | FP ${metrics.falsePositives} | TN ${metrics.trueNegatives} | FN ${metrics.falseNegatives}`,
      `Positive target recall: ${percent(report.metrics.positiveTargetRecall ?? 0)}`,
      `Failed cases: ${report.metrics.failedCases}/${report.dataset.totalCases}`
    );
  }

  if (report.metrics.latencyMs) {
    lines.push(
      `Latency: mean ${report.metrics.latencyMs.mean.toFixed(0)} ms | p50 ${report.metrics.latencyMs.p50} ms | p95 ${report.metrics.latencyMs.p95} ms`
    );
  }
  if (report.metrics.estimatedTokens) {
    lines.push(
      `Estimated tokens: ${report.metrics.estimatedTokens.input} input | ${report.metrics.estimatedTokens.output} output`
    );
  }
  if (report.metrics.estimatedCostUsd !== undefined) {
    lines.push(`Estimated model cost: $${report.metrics.estimatedCostUsd.toFixed(6)}`);
  }

  const missed = report.cases.filter((item) => item.expectedDocRank === null);
  const errors = report.cases.filter((item) => item.error);
  if (missed.length > 0) {
    lines.push("", `Retrieval misses: ${missed.map((item) => item.id).join(", ")}`);
  }
  if (errors.length > 0) {
    lines.push("", "Failed cases:");
    for (const item of errors) lines.push(`- ${item.id}: ${item.error}`);
  }

  if (gate) {
    lines.push("", `Quality gate: ${gate.passed ? "PASS" : "FAIL"}`);
    for (const failure of gate.failures) lines.push(`- ${failure}`);
  }

  return lines.join("\n");
}
