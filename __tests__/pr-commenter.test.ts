import type {
  AnalysisResult,
  DriftResult,
  ChangedFile,
  DocSection,
  PatchPRResult,
} from "../src/types";

// We need to import the module to test the comment body builder
// Since buildCommentBody is not exported, we'll test via PRCommenter
// But we can test the comment body structure by mocking octokit

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
  const comments: Array<{ id: number; body: string }> = [];
  let commentIdCounter = 1;

  return {
    comments, // expose for assertions
    rest: {
      issues: {
        createComment: jest.fn().mockImplementation(async ({ body }: { body: string }) => {
          const comment = { id: commentIdCounter++, body };
          comments.push(comment);
          return { data: comment };
        }),
        updateComment: jest.fn().mockImplementation(async ({ comment_id, body }: { comment_id: number; body: string }) => {
          const existing = comments.find((c) => c.id === comment_id);
          if (existing) existing.body = body;
          return { data: existing };
        }),
        listComments: {
          endpoint: { merge: jest.fn() },
        },
      },
    },
    paginate: jest.fn().mockResolvedValue([]),
  };
}

// We need to dynamically import PRCommenter to avoid circular mock issues
const { PRCommenter } = require("../src/pr-commenter");

const CTX = {
  owner: "test-owner",
  repo: "test-repo",
  prNumber: 42,
  headSha: "abc1234567890",
  baseSha: "def0987654321",
  baseRef: "main",
  headRef: "feature/zustand",
  headOwner: "test-owner",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PRCommenter", () => {
  describe("postOrUpdate — no drift", () => {
    it("posts an 'all clear' comment when no drift is detected", async () => {
      const octokit = createMockOctokit();
      const commenter = new PRCommenter(octokit, CTX, "new");

      const result = makeAnalysisResult({ driftResults: [] });
      await commenter.postOrUpdate(result, null);

      expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain("No Rationale Drift Detected");
      expect(body).toContain("knowledge-diff");
    });

    it("includes skipped files in the all-clear comment", async () => {
      const octokit = createMockOctokit();
      const commenter = new PRCommenter(octokit, CTX, "new");

      const result = makeAnalysisResult({
        driftResults: [],
        skippedFiles: ["big.ts (limit reached)", "old.ts (deleted)"],
      });
      await commenter.postOrUpdate(result, null);

      const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain("2 file(s) skipped");
      expect(body).toContain("big.ts");
    });
  });

  describe("postOrUpdate — drift detected", () => {
    it("posts a drift comment with the correct structure", async () => {
      const octokit = createMockOctokit();
      const commenter = new PRCommenter(octokit, CTX, "new");

      const result = makeAnalysisResult({
        driftResults: [makeDriftResult()],
      });
      await commenter.postOrUpdate(result, null);

      const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain("Rationale Drift Detected");
      expect(body).toContain("1");
      expect(body).toContain("src/store/cart.ts");
      expect(body).toContain("README.md");
      expect(body).toContain("State Management");
      expect(body).toContain("🔴"); // definite confidence badge
      expect(body).toContain("Definite contradiction");
    });

    it("includes stale text and suggested replacement", async () => {
      const octokit = createMockOctokit();
      const commenter = new PRCommenter(octokit, CTX, "new");

      const result = makeAnalysisResult({
        driftResults: [makeDriftResult()],
      });
      await commenter.postOrUpdate(result, null);

      const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain("Doc still says");
      expect(body).toContain("Redux Toolkit");
      expect(body).toContain("Suggested update");
      expect(body).toContain("Zustand");
    });

    it("includes auto-patch PR link when provided", async () => {
      const octokit = createMockOctokit();
      const commenter = new PRCommenter(octokit, CTX, "new");

      const patchPR: PatchPRResult = {
        patchBranch: "docs/knowledge-diff-42-abc1234",
        patchPRNumber: 99,
        patchPRUrl: "https://github.com/test-owner/test-repo/pull/99",
      };

      const result = makeAnalysisResult({
        driftResults: [makeDriftResult()],
      });
      await commenter.postOrUpdate(result, patchPR);

      const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain("Auto-patch available");
      expect(body).toContain("PR #99");
      expect(body).toContain("https://github.com/test-owner/test-repo/pull/99");
    });

    it("shows 'likely' confidence with yellow badge", async () => {
      const octokit = createMockOctokit();
      const commenter = new PRCommenter(octokit, CTX, "new");

      const result = makeAnalysisResult({
        driftResults: [makeDriftResult({ confidence: "likely" })],
      });
      await commenter.postOrUpdate(result, null);

      const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain("🟡");
      expect(body).toContain("Likely outdated");
    });

    it("groups multiple drifts by file", async () => {
      const octokit = createMockOctokit();
      const commenter = new PRCommenter(octokit, CTX, "new");

      const result = makeAnalysisResult({
        driftResults: [
          makeDriftResult(),
          makeDriftResult({
            matchedSection: makeDocSection({ heading: "API" }),
            explanation: "API version changed.",
          }),
        ],
        checkedFiles: 3,
      });
      await commenter.postOrUpdate(result, null);

      const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
      expect(body).toContain("2");
      expect(body).toContain("State Management");
      expect(body).toContain("API");
      // Should mention clean files
      expect(body).toContain("No drift detected in");
    });
  });

  describe("comment mode: update", () => {
    it("updates existing comment when found", async () => {
      const octokit = createMockOctokit();
      // Simulate an existing knowledge-diff comment
      octokit.paginate.mockResolvedValue([
        { id: 777, body: "<!-- knowledge-diff:v1 --> old content" },
      ]);

      const commenter = new PRCommenter(octokit, CTX, "update");
      const result = makeAnalysisResult({ driftResults: [] });
      await commenter.postOrUpdate(result, null);

      expect(octokit.rest.issues.updateComment).toHaveBeenCalledTimes(1);
      expect(octokit.rest.issues.updateComment.mock.calls[0][0].comment_id).toBe(777);
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it("creates a new comment when none exists to update", async () => {
      const octokit = createMockOctokit();
      octokit.paginate.mockResolvedValue([
        { id: 1, body: "Some unrelated comment" },
      ]);

      const commenter = new PRCommenter(octokit, CTX, "update");
      const result = makeAnalysisResult({ driftResults: [] });
      await commenter.postOrUpdate(result, null);

      expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    });
  });

  describe("comment mode: new", () => {
    it("always creates a new comment", async () => {
      const octokit = createMockOctokit();
      const commenter = new PRCommenter(octokit, CTX, "new");
      const result = makeAnalysisResult({ driftResults: [] });

      await commenter.postOrUpdate(result, null);
      await commenter.postOrUpdate(result, null);

      expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(2);
      expect(octokit.paginate).not.toHaveBeenCalled();
    });
  });
});
