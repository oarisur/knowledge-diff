/**
 * Tests for src/index.ts — the main orchestration entry point.
 *
 * Strategy: mock every external dependency (core, github, LLMClient,
 * DriftDetector, PRCommenter, DocPatcher) and verify the wiring.
 */

// ─── Mocks (must be before imports) ──────────────────────────────────────────

const mockGetInput = jest.fn();
const mockGetBooleanInput = jest.fn();
const mockSetOutput = jest.fn();
const mockSetFailed = jest.fn();
const mockSetSecret = jest.fn();

jest.mock("@actions/core", () => ({
  getInput: (...args: unknown[]) => mockGetInput(...args),
  getBooleanInput: (...args: unknown[]) => mockGetBooleanInput(...args),
  setOutput: (...args: unknown[]) => mockSetOutput(...args),
  setFailed: (...args: unknown[]) => mockSetFailed(...args),
  setSecret: (...args: unknown[]) => mockSetSecret(...args),
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

const mockPaginate = jest.fn();
const mockGetTree = jest.fn();
const mockGetContent = jest.fn();
const mockOctokit = {
  rest: {
    git: { getTree: mockGetTree },
    repos: { getContent: mockGetContent },
    pulls: { listFiles: jest.fn() },
    issues: {
      createComment: jest.fn(),
      updateComment: jest.fn(),
      listComments: jest.fn(),
    },
  },
  paginate: mockPaginate,
};

jest.mock("@actions/github", () => ({
  getOctokit: () => mockOctokit,
  context: {
    eventName: "pull_request",
    repo: { owner: "test-owner", repo: "test-repo" },
    payload: {
      pull_request: {
        number: 42,
        head: {
          sha: "abc1234567890",
          ref: "feature/test",
          repo: { owner: { login: "test-owner" } },
        },
        base: { sha: "def0987654321", ref: "main" },
      },
    },
  },
}));

// Mock the imported modules — we test index.ts wiring, not the internals
jest.mock("../src/llm-client", () => ({
  LLMClient: jest.fn().mockImplementation(() => ({
    detectDrift: jest.fn(),
  })),
  withRetry: jest.fn().mockImplementation((fn: () => unknown) => fn()),
}));

jest.mock("../src/drift-detector", () => ({
  DriftDetector: jest.fn().mockImplementation(() => ({
    analyse: jest.fn(),
  })),
}));

jest.mock("../src/pr-commenter", () => ({
  PRCommenter: jest.fn().mockImplementation(() => ({
    postOrUpdate: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/doc-patcher", () => ({
  DocPatcher: jest.fn().mockImplementation(() => ({
    createPatchPR: jest.fn().mockResolvedValue(null),
  })),
}));

jest.mock("minimatch", () => ({
  minimatch: jest.fn().mockReturnValue(true),
}));

import { DriftDetector } from "../src/drift-detector";
import { PRCommenter } from "../src/pr-commenter";

// ─── Helper ──────────────────────────────────────────────────────────────────

function setupInputs(overrides: Record<string, string> = {}) {
  const defaults: Record<string, string> = {
    "github-token": "ghp_test123",
    "llm-provider": "openai",
    "openai-api-key": "sk-test",
    "anthropic-api-key": "",
    "gemini-api-key": "",
    "llm-model": "",
    "doc-files": "README.md",
    "code-extensions": "ts,js",
    "sensitivity": "medium",
    "comment-mode": "update",
    "max-files-per-run": "20",
    ...overrides,
  };

  mockGetInput.mockImplementation((name: string, opts?: { required?: boolean }) => {
    const val = defaults[name] ?? "";
    if (opts?.required && !val) throw new Error(`Input required: ${name}`);
    return val;
  });

  mockGetBooleanInput.mockImplementation((name: string) => {
    if (name === "auto-patch") return defaults["auto-patch"] === "true";
    return false;
  });
}

function setupPRFiles(
  files: Array<{ filename: string; patch?: string; status: string }>
) {
  mockPaginate.mockResolvedValue(files);
}

function setupDocTree(docPaths: string[]) {
  mockGetTree.mockResolvedValue({
    data: {
      tree: docPaths.map((p) => ({ type: "blob", path: p })),
    },
  });

  mockGetContent.mockResolvedValue({
    data: {
      type: "file",
      content: Buffer.from("# Test Doc\n\n## Section\n\nSome content.").toString(
        "base64"
      ),
    },
  });
}

function setupDriftResult(driftResults: unknown[] = [], skippedFiles: string[] = []) {
  const mockAnalyse = jest.fn().mockResolvedValue({
    driftResults,
    skippedFiles,
    checkedFiles: 1,
    docFilesChecked: ["README.md"],
    totalCandidates: driftResults.length,
  });

  (DriftDetector as jest.Mock).mockImplementation(() => ({
    analyse: mockAnalyse,
  }));

  return mockAnalyse;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("index.ts — run()", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("runs the full pipeline and sets outputs for no-drift case", async () => {
    setupInputs();
    setupPRFiles([
      { filename: "src/app.ts", patch: "+const x = 1;", status: "modified" },
    ]);
    setupDocTree(["README.md"]);
    setupDriftResult([]);

    // Dynamic import to trigger run()
    jest.isolateModules(() => {
      require("../src/index");
    });

    // Wait for async run() to complete
    await new Promise((r) => setTimeout(r, 100));

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockSetOutput).toHaveBeenCalledWith("drift-detected", "false");
    expect(mockSetOutput).toHaveBeenCalledWith("drift-count", "0");
    expect(mockSetOutput).toHaveBeenCalledWith("patch-pr-url", "");
  });

  it("sets drift-detected=true when drift is found", async () => {
    setupInputs();
    setupPRFiles([
      { filename: "src/store.ts", patch: "+zustand", status: "modified" },
    ]);
    setupDocTree(["README.md"]);
    setupDriftResult([
      {
        changedFile: { filePath: "src/store.ts" },
        matchedSection: { filePath: "README.md", heading: "State" },
        isDrift: true,
        confidence: "definite",
        explanation: "Contradiction found",
        meetsThreshold: true,
      },
    ]);

    jest.isolateModules(() => {
      require("../src/index");
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockSetOutput).toHaveBeenCalledWith("drift-detected", "true");
    expect(mockSetOutput).toHaveBeenCalledWith("drift-count", "1");
  });

  it("calls setFailed on invalid llm-provider", async () => {
    setupInputs({ "llm-provider": "invalid-provider" });

    jest.isolateModules(() => {
      require("../src/index");
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("Invalid llm-provider")
    );
  });

  it("calls setFailed when API key is missing", async () => {
    setupInputs({ "openai-api-key": "" });

    jest.isolateModules(() => {
      require("../src/index");
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("API key")
    );
  });

  it("calls setFailed on invalid sensitivity", async () => {
    setupInputs({ sensitivity: "extreme" });

    jest.isolateModules(() => {
      require("../src/index");
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("Invalid sensitivity")
    );
  });

  it("calls setFailed on invalid max-files-per-run", async () => {
    setupInputs({ "max-files-per-run": "abc" });

    jest.isolateModules(() => {
      require("../src/index");
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("Invalid max-files-per-run")
    );
  });

  it("returns early when no code files changed", async () => {
    setupInputs();
    // Only a markdown file changed — not a code file
    setupPRFiles([
      { filename: "docs/guide.md", patch: "+hello", status: "modified" },
    ]);

    jest.isolateModules(() => {
      require("../src/index");
    });

    await new Promise((r) => setTimeout(r, 100));

    // Should NOT have set outputs or called setFailed
    expect(mockSetFailed).not.toHaveBeenCalled();
    // DriftDetector should not have been constructed
    expect(DriftDetector).not.toHaveBeenCalled();
  });

  it("posts comment even when no doc files are found", async () => {
    setupInputs();
    setupPRFiles([
      { filename: "src/app.ts", patch: "+const x = 1;", status: "modified" },
    ]);
    // Empty doc tree
    mockGetTree.mockResolvedValue({
      data: { tree: [] },
    });
    setupDriftResult([]);

    jest.isolateModules(() => {
      require("../src/index");
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(PRCommenter).toHaveBeenCalled();
  });

  it("masks the API key via core.setSecret", async () => {
    setupInputs({ "openai-api-key": "sk-secret-key-123" });
    setupPRFiles([
      { filename: "src/app.ts", patch: "+x", status: "modified" },
    ]);
    setupDocTree(["README.md"]);
    setupDriftResult([]);

    jest.isolateModules(() => {
      require("../src/index");
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(mockSetSecret).toHaveBeenCalledWith("sk-secret-key-123");
  });
});
