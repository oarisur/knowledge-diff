jest.mock("@actions/core", () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
}));

import datasetJson from "../evaluation/benchmark.v1.json";
import {
  calculateClassificationMetrics,
  evaluateQualityGate,
  renderEvaluationReport,
  runEvaluation,
  validateEvaluationDataset,
  type EvaluationClassifier,
  type EvaluationDataset,
} from "../src/evaluation";

const dataset = datasetJson as EvaluationDataset;

function oracleClassifier(source: EvaluationDataset): EvaluationClassifier {
  const byInput = new Map(
    source.cases.map((item) => [`${item.codeFilePath}\u0000${item.patch}`, item])
  );
  return {
    detectDriftBatch: jest.fn(async (codeFilePath, patch, candidates) => {
      const evaluationCase = byInput.get(`${codeFilePath}\u0000${patch}`);
      if (!evaluationCase) throw new Error(`Unknown case: ${codeFilePath}`);
      return candidates.map((candidate, candidateIndex) => {
        const isDrift =
          evaluationCase.expected.isDrift &&
          candidate.docFilePath === evaluationCase.expected.docFilePath &&
          (!evaluationCase.expected.heading ||
            candidate.docHeading === evaluationCase.expected.heading);
        return {
          candidateIndex,
          isDrift,
          confidence: isDrift ? "definite" as const : "possible" as const,
          explanation: isDrift ? "The labeled contradiction is present." : "No contradiction.",
        };
      });
    }),
  };
}

describe("evaluation dataset", () => {
  test("contains 30 balanced, valid labeled cases", () => {
    expect(validateEvaluationDataset(dataset)).toEqual([]);
    expect(dataset.cases).toHaveLength(30);
    expect(dataset.cases.filter((item) => item.expected.isDrift)).toHaveLength(15);
    expect(dataset.cases.filter((item) => !item.expected.isDrift)).toHaveLength(15);
  });

  test("rejects duplicate ids, missing docs, patches, and extensions", () => {
    const invalid: EvaluationDataset = {
      name: "",
      version: "",
      description: "invalid",
      cases: [
        {
          id: "duplicate",
          description: "first",
          tags: [],
          codeFilePath: "no-extension",
          patch: "",
          docs: [],
          expected: { isDrift: true, docFilePath: "missing.md" },
        },
        {
          id: "duplicate",
          description: "second",
          tags: [],
          codeFilePath: "file.ts",
          patch: "+const value = true;",
          docs: [],
          expected: { isDrift: false, docFilePath: "also-missing.md" },
        },
      ],
    };

    const errors = validateEvaluationDataset(invalid);
    expect(errors).toEqual(expect.arrayContaining([
      "Dataset name is required.",
      "Dataset version is required.",
      "Duplicate case id: duplicate",
      "duplicate: codeFilePath must have an extension.",
      "duplicate: patch is required.",
    ]));
    expect(errors.filter((error) => error.includes("is not present"))).toHaveLength(2);
  });

  test("rejects an empty dataset", () => {
    expect(
      validateEvaluationDataset({
        name: "empty",
        version: "1",
        description: "empty",
        cases: [],
      })
    ).toContain("Dataset must contain at least one case.");
  });
});

describe("evaluation metrics", () => {
  test("calculates precision, recall, F1, accuracy, and false-positive rate", () => {
    expect(
      calculateClassificationMetrics({
        truePositives: 8,
        falsePositives: 2,
        trueNegatives: 18,
        falseNegatives: 2,
      })
    ).toEqual({
      truePositives: 8,
      falsePositives: 2,
      trueNegatives: 18,
      falseNegatives: 2,
      precision: 0.8,
      recall: 0.8,
      f1: 0.8,
      accuracy: 0.866667,
      falsePositiveRate: 0.1,
    });
  });

  test("handles empty confusion-matrix denominators", () => {
    expect(
      calculateClassificationMetrics({
        truePositives: 0,
        falsePositives: 0,
        trueNegatives: 0,
        falseNegatives: 0,
      })
    ).toMatchObject({ precision: 0, recall: 0, f1: 0, accuracy: 0 });
  });
});

describe("evaluation runner", () => {
  test("passes the deterministic retrieval gate on the benchmark", async () => {
    const report = await runEvaluation(dataset, { sensitivity: "medium" });

    expect(report.mode).toBe("retrieval");
    expect(report.metrics.retrievalRecallAt6).toBe(1);
    expect(report.metrics.positiveRetrievalRecallAt6).toBe(1);
    expect(report.metrics.meanReciprocalRank).toBe(1);
    expect(report.metrics.classification).toBeUndefined();
    expect(evaluateQualityGate(report)).toEqual({ passed: true, failures: [] });
    expect(renderEvaluationReport(report)).toContain("Retrieval recall@6: 100.0%");
  });

  test("scores live classification, latency, token use, and estimated cost", async () => {
    const classifier = oracleClassifier(dataset);
    const report = await runEvaluation(dataset, {
      sensitivity: "medium",
      classifier,
      provider: "openai",
      model: "gpt-4o-mini",
      pricing: {
        inputPerMillionUsd: 0.15,
        outputPerMillionUsd: 0.6,
        asOf: "2026-08-30",
        source: "test",
      },
    });

    expect(report.mode).toBe("live");
    expect(report.provider).toBe("openai");
    expect(report.metrics.classification).toMatchObject({
      precision: 1,
      recall: 1,
      f1: 1,
      falsePositives: 0,
      falseNegatives: 0,
    });
    expect(report.metrics.caseClassification).toMatchObject({ precision: 1, recall: 1 });
    expect(report.metrics.positiveTargetRecall).toBe(1);
    expect(report.metrics.latencyMs).toBeDefined();
    expect(report.metrics.estimatedTokens!.input).toBeGreaterThan(0);
    expect(report.metrics.estimatedTokens!.output).toBeGreaterThan(0);
    expect(report.metrics.estimatedCostUsd).toBeGreaterThan(0);
    expect(evaluateQualityGate(report).passed).toBe(true);
    expect(renderEvaluationReport(report, evaluateQualityGate(report))).toContain(
      "Quality gate: PASS"
    );
  });

  test("fails the gate for false positives, false negatives, and provider failures", async () => {
    const subset: EvaluationDataset = {
      ...dataset,
      cases: [dataset.cases[0], dataset.cases[15]],
    };
    let calls = 0;
    const classifier: EvaluationClassifier = {
      detectDriftBatch: jest.fn(async (_path, _patch, candidates) => {
        calls++;
        if (calls === 1) throw new Error("provider unavailable");
        return candidates.map((_candidate, candidateIndex) => ({
          candidateIndex,
          isDrift: true,
          confidence: "definite" as const,
          explanation: "Incorrect drift prediction.",
        }));
      }),
    };

    const report = await runEvaluation(subset, {
      sensitivity: "medium",
      classifier,
      provider: "openai",
      model: "gpt-4o-mini",
    });
    const gate = evaluateQualityGate(report);

    expect(report.metrics.classification).toMatchObject({
      truePositives: 0,
      falsePositives: expect.any(Number),
      falseNegatives: 1,
    });
    expect(report.metrics.failedCases).toBe(1);
    expect(gate.passed).toBe(false);
    expect(gate.failures).toEqual(expect.arrayContaining([
      expect.stringContaining("Precision"),
      expect.stringContaining("Recall"),
      expect.stringContaining("Positive target recall"),
      expect.stringContaining("Failure rate"),
    ]));
    expect(renderEvaluationReport(report, gate)).toContain("provider unavailable");
  });

  test("marks omitted model responses as failed cases", async () => {
    const subset: EvaluationDataset = { ...dataset, cases: [dataset.cases[0]] };
    const classifier: EvaluationClassifier = {
      detectDriftBatch: jest.fn(async () => []),
    };
    const report = await runEvaluation(subset, {
      sensitivity: "medium",
      classifier,
    });

    expect(report.metrics.failedCases).toBe(1);
    expect(report.cases[0].missingResponseCount).toBeGreaterThan(0);
    expect(report.cases[0].error).toContain("Model omitted");
  });

  test("rejects invalid datasets before running", async () => {
    await expect(
      runEvaluation(
        { name: "", version: "", description: "bad", cases: [] },
        { sensitivity: "medium" }
      )
    ).rejects.toThrow("Invalid evaluation dataset");
  });
});
