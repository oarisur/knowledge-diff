import type {
  AnalysisResult,
  DriftResult,
  ChangedFile,
  DocSection,
  PRContext,
} from "../src/types";

// Suppress @actions/core logging during tests
jest.mock("@actions/core", () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDocSection(overrides?: Partial<DocSection>): DocSection {
  return {
    filePath: "README.md",
    heading: "State Management",
    content: "We use Redux Toolkit for all global state.",
    keywords: ["redux", "state"],
    level: 2,
    ...overrides,
  };
}

function makeChangedFile(overrides?: Partial<ChangedFile>): ChangedFile {
  return {
    filePath: "src/store/cart.ts",
    patch: "some patch",
    additions: ["+import zustand"],
    deletions: ["-import redux"],
    changedSymbols: ["useCartStore"],
    tokenEstimate: 50,
    ...overrides,
  };
}

function makeDriftResult(overrides?: Partial<DriftResult>): DriftResult {
  return {
    changedFile: makeChangedFile(),
    matchedSection: makeDocSection(),
    isDrift: true,
    confidence: "definite",
    explanation: "Redux was replaced with Zustand.",
    staleText: "We use Redux Toolkit for all global state.",
    suggestedText: "We use Zustand for client-side global state management.",
    meetsThreshold: true,
    ...overrides,
  };
}

function makeAnalysisResult(overrides?: Partial<AnalysisResult>): AnalysisResult {
  return {
    driftResults: [],
    skippedFiles: [],
    checkedFiles: 1,
    docFilesChecked: ["README.md"],
    totalCandidates: 3,
    ...overrides,
  };
}

// ─── Mock Octokit ─────────────────────────────────────────────────────────────

function createMockOctokit() {
  return {
    rest: {
      git: {
        getRef: jest.fn().mockResolvedValue({
          data: { object: { sha: "base-sha-123" } },
        }),
        getCommit: jest.fn().mockResolvedValue({
          data: { tree: { sha: "tree-sha-456" } },
        }),
        createBlob: jest.fn().mockResolvedValue({
          data: { sha: "blob-sha-789" },
        }),
        createTree: jest.fn().mockResolvedValue({
          data: { sha: "new-tree-sha-abc" },
        }),
        createCommit: jest.fn().mockResolvedValue({
          data: { sha: "new-commit-sha-def" },
        }),
        createRef: jest.fn().mockResolvedValue({}),
        updateRef: jest.fn().mockResolvedValue({}),
      },
      pulls: {
        list: jest.fn().mockResolvedValue({
          data: [],
        }),
        create: jest.fn().mockResolvedValue({
          data: {
            number: 99,
            html_url: "https://github.com/test-owner/test-repo/pull/99",
          },
        }),
      },
    },
  };
}

const CTX: PRContext = {
  owner: "test-owner",
  repo: "test-repo",
  prNumber: 42,
  headSha: "abc1234567890",
  baseSha: "def0987654321",
  baseRef: "main",
  headRef: "feature/zustand",
  headOwner: "test-owner",
};

const { DocPatcher } = require("../src/doc-patcher");

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DocPatcher", () => {
  describe("createPatchPR — no patchable drift", () => {
    it("returns null when no drift meets threshold", async () => {
      const octokit = createMockOctokit();
      const patcher = new DocPatcher(octokit, CTX);

      const result = makeAnalysisResult({
        driftResults: [makeDriftResult({ meetsThreshold: false })],
      });
      const docContents = new Map([["README.md", "We use Redux."]]);

      const patchPR = await patcher.createPatchPR(result, docContents);
      expect(patchPR).toBeNull();
    });

    it("returns null when drift has no staleText", async () => {
      const octokit = createMockOctokit();
      const patcher = new DocPatcher(octokit, CTX);

      const result = makeAnalysisResult({
        driftResults: [
          makeDriftResult({
            staleText: undefined,
            suggestedText: undefined,
          }),
        ],
      });
      const docContents = new Map([["README.md", "Some content."]]);

      const patchPR = await patcher.createPatchPR(result, docContents);
      expect(patchPR).toBeNull();
    });

    it("returns null when staleText is not found verbatim in doc", async () => {
      const octokit = createMockOctokit();
      const patcher = new DocPatcher(octokit, CTX);

      const result = makeAnalysisResult({
        driftResults: [
          makeDriftResult({
            staleText: "This text does not exist in the doc",
            suggestedText: "Replacement",
          }),
        ],
      });
      const docContents = new Map([["README.md", "Completely different content."]]);

      const patchPR = await patcher.createPatchPR(result, docContents);
      expect(patchPR).toBeNull();
    });
  });

  describe("createPatchPR — successful patch", () => {
    it("creates a patch PR with correct branch name and returns result", async () => {
      const octokit = createMockOctokit();
      const patcher = new DocPatcher(octokit, CTX);

      const docContent = "We use Redux Toolkit for all global state.";
      const result = makeAnalysisResult({
        driftResults: [makeDriftResult()],
      });
      const docContents = new Map([["README.md", docContent]]);

      const patchPR = await patcher.createPatchPR(result, docContents);

      expect(patchPR).not.toBeNull();
      expect(patchPR!.patchBranch).toContain("docs/knowledge-diff-42-");
      expect(patchPR!.patchPRNumber).toBe(99);
      expect(patchPR!.patchPRUrl).toContain("pull/99");
    });

    it("calls GitHub API to create blob, tree, commit, ref, and PR", async () => {
      const octokit = createMockOctokit();
      const patcher = new DocPatcher(octokit, CTX);

      const docContent = "We use Redux Toolkit for all global state.";
      const result = makeAnalysisResult({
        driftResults: [makeDriftResult()],
      });
      const docContents = new Map([["README.md", docContent]]);

      await patcher.createPatchPR(result, docContents);

      expect(octokit.rest.git.getRef).toHaveBeenCalledTimes(1);
      expect(octokit.rest.git.getCommit).toHaveBeenCalledTimes(1);
      expect(octokit.rest.git.createBlob).toHaveBeenCalledTimes(1);
      expect(octokit.rest.git.createTree).toHaveBeenCalledTimes(1);
      expect(octokit.rest.git.createCommit).toHaveBeenCalledTimes(1);
      expect(octokit.rest.git.createRef).toHaveBeenCalledTimes(1);
      expect(octokit.rest.pulls.create).toHaveBeenCalledTimes(1);
    });

    it("uses updateRef when createRef fails (branch already exists)", async () => {
      const octokit = createMockOctokit();
      octokit.rest.git.createRef.mockRejectedValue(
        Object.assign(new Error("Reference already exists"), { status: 422 })
      );
      const patcher = new DocPatcher(octokit, CTX);

      const docContent = "We use Redux Toolkit for all global state.";
      const result = makeAnalysisResult({
        driftResults: [makeDriftResult()],
      });
      const docContents = new Map([["README.md", docContent]]);

      const patchPR = await patcher.createPatchPR(result, docContents);

      expect(patchPR).not.toBeNull();
      expect(octokit.rest.git.updateRef).toHaveBeenCalledWith(
        expect.objectContaining({ force: true })
      );
    });

    it("handles multiple drift results in the same doc file", async () => {
      const octokit = createMockOctokit();
      const patcher = new DocPatcher(octokit, CTX);

      const docContent =
        "We use Redux Toolkit for all global state. We use PostgreSQL as our database.";
      const result = makeAnalysisResult({
        driftResults: [
          makeDriftResult(),
          makeDriftResult({
            matchedSection: makeDocSection({
              heading: "Database",
              filePath: "README.md",
            }),
            staleText: "We use PostgreSQL as our database.",
            suggestedText: "We use MongoDB as our database.",
          }),
        ],
      });
      const docContents = new Map([["README.md", docContent]]);

      const patchPR = await patcher.createPatchPR(result, docContents);
      expect(patchPR).not.toBeNull();
      // Should only create one blob (same file, multiple patches consolidated)
      expect(octokit.rest.git.createBlob).toHaveBeenCalledTimes(1);
    });

    it("handles drift results across different doc files", async () => {
      const octokit = createMockOctokit();
      const patcher = new DocPatcher(octokit, CTX);

      const result = makeAnalysisResult({
        driftResults: [
          makeDriftResult(),
          makeDriftResult({
            matchedSection: makeDocSection({
              heading: "API Versioning",
              filePath: "ARCHITECTURE.md",
            }),
            staleText: "/api/v1/",
            suggestedText: "/api/v2/",
          }),
        ],
      });
      const docContents = new Map([
        ["README.md", "We use Redux Toolkit for all global state."],
        ["ARCHITECTURE.md", "All endpoints are under /api/v1/ prefix."],
      ]);

      const patchPR = await patcher.createPatchPR(result, docContents);
      expect(patchPR).not.toBeNull();
      // Two different files = two blobs
      expect(octokit.rest.git.createBlob).toHaveBeenCalledTimes(2);
    });

    it("reuses an existing open PR and does not call pulls.create", async () => {
      const octokit = createMockOctokit();
      const existingPR = {
        number: 101,
        html_url: "https://github.com/test-owner/test-repo/pull/101",
      };
      (octokit.rest.pulls.list as jest.Mock).mockResolvedValue({
        data: [existingPR],
      });
      const patcher = new DocPatcher(octokit, CTX);

      const docContent = "We use Redux Toolkit for all global state.";
      const result = makeAnalysisResult({
        driftResults: [makeDriftResult()],
      });
      const docContents = new Map([["README.md", docContent]]);

      const patchPR = await patcher.createPatchPR(result, docContents);

      expect(patchPR).not.toBeNull();
      expect(patchPR!.patchPRNumber).toBe(101);
      expect(patchPR!.patchPRUrl).toBe(existingPR.html_url);
      expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
    });
  });

  describe("createPatchPR — error handling", () => {
    it("returns null when GitHub API fails", async () => {
      const octokit = createMockOctokit();
      octokit.rest.git.getRef.mockRejectedValue(new Error("API rate limit"));
      const patcher = new DocPatcher(octokit, CTX);

      const docContent = "We use Redux Toolkit for all global state.";
      const result = makeAnalysisResult({
        driftResults: [makeDriftResult()],
      });
      const docContents = new Map([["README.md", docContent]]);

      const patchPR = await patcher.createPatchPR(result, docContents);
      expect(patchPR).toBeNull();
    });
  });
});
