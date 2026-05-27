import { DriftDetector } from "../src/drift-detector";
import type { LLMDriftResponse } from "../src/types";
import { LLMClient } from "../src/llm-client";
import { REDUX_TO_ZUSTAND_PATCH } from "./fixtures/diffs";
import { README_WITH_REDUX } from "./fixtures/docs";

// Suppress @actions/core logging during tests
jest.mock("@actions/core", () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
}));

// ─── Mock LLM Client ──────────────────────────────────────────────────────────

// We mock the entire LLMClient to avoid real API calls
jest.mock("../src/llm-client");

function createMockLLM(response: LLMDriftResponse): LLMClient {
  const mock = new LLMClient("openai", "test-key");
  (mock.detectDrift as jest.Mock) = jest.fn().mockResolvedValue(response);
  return mock;
}

// ─── Helper ────────────────────────────────────────────────────────────────────

function makeCodeFiles() {
  return [
    {
      filePath: "src/store/cart.ts",
      patch: REDUX_TO_ZUSTAND_PATCH,
      additions: REDUX_TO_ZUSTAND_PATCH.split("\n")
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .map((l) => l.slice(1)),
      deletions: REDUX_TO_ZUSTAND_PATCH.split("\n")
        .filter((l) => l.startsWith("-") && !l.startsWith("---"))
        .map((l) => l.slice(1)),
      changedSymbols: ["useCartStore", "cartSlice", "createSlice"],
      changedLiterals: [],
      tokenEstimate: Math.ceil(REDUX_TO_ZUSTAND_PATCH.length / 4),
    },
  ];
}

function makeDocFiles() {
  return [{ filePath: "README.md", content: README_WITH_REDUX }];
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("DriftDetector", () => {
  it("reports drift when LLM says isDrift: true with definite confidence", async () => {
    const llm = createMockLLM({
      isDrift: true,
      confidence: "definite",
      explanation:
        "The code replaced Redux createSlice with Zustand create(), but the doc says Redux Toolkit.",
      staleText: "We use Redux Toolkit with createSlice for all global state.",
      suggestedText: "We use Zustand for client-side global state management.",
    });

    const detector = new DriftDetector(llm, "medium");
    const result = await detector.analyse(makeCodeFiles(), makeDocFiles(), []);

    expect(result.checkedFiles).toBe(1);
    expect(result.docFilesChecked).toContain("README.md");

    const actionable = result.driftResults.filter((r) => r.meetsThreshold);
    expect(actionable.length).toBeGreaterThanOrEqual(1);

    const drift = actionable[0];
    expect(drift.isDrift).toBe(true);
    expect(drift.confidence).toBe("definite");
    expect(drift.staleText).toContain("Redux Toolkit");
    expect(drift.suggestedText).toContain("Zustand");
    expect(drift.matchedSection.heading).toBe("State Management");
  });

  it("reports no drift when LLM says isDrift: false", async () => {
    const llm = createMockLLM({
      isDrift: false,
      confidence: "possible",
      explanation: "The doc is vague enough to still be correct.",
    });

    const detector = new DriftDetector(llm, "medium");
    const result = await detector.analyse(makeCodeFiles(), makeDocFiles(), []);

    const actionable = result.driftResults.filter((r) => r.meetsThreshold);
    expect(actionable).toHaveLength(0);
  });

  it("filters by sensitivity: low excludes 'likely' confidence", async () => {
    const llm = createMockLLM({
      isDrift: true,
      confidence: "likely",
      explanation: "Probably outdated.",
    });

    const detector = new DriftDetector(llm, "low");
    const result = await detector.analyse(makeCodeFiles(), makeDocFiles(), []);

    const actionable = result.driftResults.filter((r) => r.meetsThreshold);
    expect(actionable).toHaveLength(0);

    // But the drift IS still recorded (just not flagged)
    const allDrift = result.driftResults.filter((r) => r.isDrift);
    expect(allDrift.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by sensitivity: medium includes 'likely' but excludes 'possible'", async () => {
    const llm = createMockLLM({
      isDrift: true,
      confidence: "possible",
      explanation: "Might be wrong.",
    });

    const detector = new DriftDetector(llm, "medium");
    const result = await detector.analyse(makeCodeFiles(), makeDocFiles(), []);

    const actionable = result.driftResults.filter((r) => r.meetsThreshold);
    expect(actionable).toHaveLength(0);
  });

  it("filters by sensitivity: high includes 'possible'", async () => {
    const llm = createMockLLM({
      isDrift: true,
      confidence: "possible",
      explanation: "Ambiguous but potentially wrong.",
    });

    const detector = new DriftDetector(llm, "high");
    const result = await detector.analyse(makeCodeFiles(), makeDocFiles(), []);

    const actionable = result.driftResults.filter((r) => r.meetsThreshold);
    expect(actionable.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty results when no doc files are provided", async () => {
    const llm = createMockLLM({
      isDrift: true,
      confidence: "definite",
      explanation: "Should never be called.",
    });

    const detector = new DriftDetector(llm, "medium");
    const result = await detector.analyse(makeCodeFiles(), [], []);

    expect(result.checkedFiles).toBe(0);
    expect(result.driftResults).toHaveLength(0);
    expect(result.docFilesChecked).toHaveLength(0);
  });

  it("tracks skipped files in the result", async () => {
    const llm = createMockLLM({
      isDrift: false,
      confidence: "possible",
      explanation: "No drift.",
    });

    const detector = new DriftDetector(llm, "medium");
    const skipped = ["binary.wasm (not a code file)", "huge.ts (limit reached)"];
    const result = await detector.analyse(makeCodeFiles(), makeDocFiles(), skipped);

    expect(result.skippedFiles).toEqual(skipped);
  });

  it("tracks totalCandidates count", async () => {
    const llm = createMockLLM({
      isDrift: false,
      confidence: "possible",
      explanation: "Fine.",
    });

    const detector = new DriftDetector(llm, "medium");
    const result = await detector.analyse(makeCodeFiles(), makeDocFiles(), []);

    // At least 1 candidate should be found for the cart.ts file
    expect(result.totalCandidates).toBeGreaterThanOrEqual(1);
    // And the LLM should have been called for each candidate
    expect((llm.detectDrift as jest.Mock).mock.calls.length).toBe(
      result.totalCandidates
    );
  });

  it("continues analysis when LLM throws for a candidate", async () => {
    const llm = new LLMClient("openai", "test-key");
    // First call throws, second call succeeds
    (llm.detectDrift as jest.Mock) = jest.fn()
      .mockRejectedValueOnce(new Error("API timeout"))
      .mockResolvedValue({
        isDrift: false,
        confidence: "possible",
        explanation: "No drift.",
      });

    const detector = new DriftDetector(llm, "medium");
    const result = await detector.analyse(makeCodeFiles(), makeDocFiles(), []);

    // Should not throw — the failed candidate is skipped
    expect(result.checkedFiles).toBe(1);
    // The total candidates were still counted even though one threw
    expect(result.totalCandidates).toBeGreaterThanOrEqual(1);
  });

  it("returns empty results when no code files are provided", async () => {
    const llm = createMockLLM({
      isDrift: true,
      confidence: "definite",
      explanation: "Should never be called.",
    });

    const detector = new DriftDetector(llm, "medium");
    const result = await detector.analyse([], makeDocFiles(), []);

    expect(result.checkedFiles).toBe(0);
    expect(result.driftResults).toHaveLength(0);
    expect((llm.detectDrift as jest.Mock)).not.toHaveBeenCalled();
  });
});

