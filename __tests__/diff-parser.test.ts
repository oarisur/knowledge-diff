import { parsePRFiles, isCodeFile, extractStringLiterals } from "../src/diff-parser";
import {
  REDUX_TO_ZUSTAND_PATCH,
  API_ROUTE_PATCH,
  DB_SWITCH_PATCH,
  UNRELATED_CSS_PATCH,
  MODEL_NAME_CHANGE_PATCH,
  makePRFile,
} from "./fixtures/diffs";

// Suppress @actions/core logging during tests
jest.mock("@actions/core", () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
}));

const DEFAULT_EXTENSIONS = ["ts", "tsx", "js", "jsx", "py", "go"];

describe("isCodeFile", () => {
  it("returns true for allowed extensions", () => {
    expect(isCodeFile("src/store/cart.ts", DEFAULT_EXTENSIONS)).toBe(true);
    expect(isCodeFile("server/app.js", DEFAULT_EXTENSIONS)).toBe(true);
    expect(isCodeFile("main.py", DEFAULT_EXTENSIONS)).toBe(true);
  });

  it("returns false for non-code files", () => {
    expect(isCodeFile("README.md", DEFAULT_EXTENSIONS)).toBe(false);
    expect(isCodeFile("logo.png", DEFAULT_EXTENSIONS)).toBe(false);
    expect(isCodeFile("style.css", DEFAULT_EXTENSIONS)).toBe(false);
    expect(isCodeFile(".gitignore", DEFAULT_EXTENSIONS)).toBe(false);
  });
});

describe("parsePRFiles", () => {
  it("parses a Redux→Zustand diff and extracts symbols", () => {
    const files = [makePRFile("src/store/cart.ts", REDUX_TO_ZUSTAND_PATCH)];
    const { changedFiles, skippedFiles } = parsePRFiles(files, DEFAULT_EXTENSIONS, 20);

    expect(changedFiles).toHaveLength(1);
    expect(skippedFiles).toHaveLength(0);

    const cart = changedFiles[0];
    expect(cart.filePath).toBe("src/store/cart.ts");
    expect(cart.additions.length).toBeGreaterThan(0);
    expect(cart.deletions.length).toBeGreaterThan(0);

    // Should detect the new Zustand symbol
    expect(cart.changedSymbols).toContain("useCartStore");
    // Should detect the old Redux symbol
    expect(cart.changedSymbols).toContain("cartSlice");

    expect(cart.tokenEstimate).toBeGreaterThan(0);
  });

  it("extracts API route change symbols", () => {
    const files = [makePRFile("src/routes/users.ts", API_ROUTE_PATCH)];
    const { changedFiles } = parsePRFiles(files, DEFAULT_EXTENSIONS, 20);

    expect(changedFiles).toHaveLength(1);
    expect(changedFiles[0].additions.some((l) => l.includes("/api/v2/users"))).toBe(true);
    expect(changedFiles[0].deletions.some((l) => l.includes("/api/v1/users"))).toBe(true);
  });

  it("detects DB driver switch symbols", () => {
    const files = [makePRFile("src/db/index.ts", DB_SWITCH_PATCH)];
    const { changedFiles } = parsePRFiles(files, DEFAULT_EXTENSIONS, 20);

    expect(changedFiles).toHaveLength(1);
    const db = changedFiles[0];
    // Should detect MongoClient or Pool or getUser
    expect(db.changedSymbols.length).toBeGreaterThan(0);
  });

  it("skips non-code files silently", () => {
    const files = [
      makePRFile("src/store/cart.ts", REDUX_TO_ZUSTAND_PATCH),
      makePRFile("styles/main.css", UNRELATED_CSS_PATCH),
      makePRFile("README.md", "some patch"),
    ];
    const { changedFiles, skippedFiles } = parsePRFiles(files, DEFAULT_EXTENSIONS, 20);

    expect(changedFiles).toHaveLength(1);
    expect(changedFiles[0].filePath).toBe("src/store/cart.ts");
    // Non-code files are silently filtered, not added to skippedFiles
    expect(skippedFiles).toHaveLength(0);
  });

  it("skips deleted files", () => {
    const files = [makePRFile("src/old.ts", REDUX_TO_ZUSTAND_PATCH, "removed")];
    const { changedFiles, skippedFiles } = parsePRFiles(files, DEFAULT_EXTENSIONS, 20);

    expect(changedFiles).toHaveLength(0);
    expect(skippedFiles).toHaveLength(1);
    expect(skippedFiles[0]).toContain("deleted");
  });

  it("respects max-files-per-run limit", () => {
    const files = Array.from({ length: 5 }, (_, i) =>
      makePRFile(`src/file${i}.ts`, API_ROUTE_PATCH)
    );
    const { changedFiles, skippedFiles } = parsePRFiles(files, DEFAULT_EXTENSIONS, 3);

    expect(changedFiles).toHaveLength(3);
    expect(skippedFiles).toHaveLength(2);
    expect(skippedFiles[0]).toContain("limit reached");
  });

  it("handles files with no patch data", () => {
    const files = [{ filename: "src/binary.ts", patch: undefined, status: "modified" }];
    const { changedFiles, skippedFiles } = parsePRFiles(files, DEFAULT_EXTENSIONS, 20);

    expect(changedFiles).toHaveLength(0);
    expect(skippedFiles).toHaveLength(1);
    expect(skippedFiles[0]).toContain("no patch data");
  });

  it("extracts changedLiterals from a model name change diff", () => {
    const files = [makePRFile("src/llm-client.ts", MODEL_NAME_CHANGE_PATCH)];
    const { changedFiles } = parsePRFiles(files, DEFAULT_EXTENSIONS, 20);

    expect(changedFiles).toHaveLength(1);
    const file = changedFiles[0];
    // Only +/- lines are parsed — context lines (unchanged) are not included
    expect(file.changedLiterals).toContain("gpt-4o");
    expect(file.changedLiterals).toContain("gpt-4o-mini");
  });

  it("extracts API URL literals from route change diff", () => {
    const files = [makePRFile("src/routes/users.ts", API_ROUTE_PATCH)];
    const { changedFiles } = parsePRFiles(files, DEFAULT_EXTENSIONS, 20);

    const file = changedFiles[0];
    expect(file.changedLiterals).toContain("/api/v2/users");
    expect(file.changedLiterals).toContain("/api/v1/users");
  });
});

describe("extractStringLiterals", () => {
  it("extracts quoted string values from code lines", () => {
    const lines = [
      '  openai: "gpt-4o-mini",',
      '  anthropic: "claude-3-5-sonnet-20241022",',
    ];
    const result = extractStringLiterals(lines);
    expect(result).toContain("gpt-4o-mini");
    expect(result).toContain("claude-3-5-sonnet-20241022");
  });

  it("filters out stopword literals", () => {
    const lines = [
      '"use strict";',
      'const encoding = "utf-8";',
      'const method = "GET";',
      'const model = "gpt-4o";',
    ];
    const result = extractStringLiterals(lines);
    expect(result).not.toContain("use strict");
    expect(result).not.toContain("utf-8");
    expect(result).not.toContain("GET");
    expect(result).toContain("gpt-4o");
  });

  it("handles single-quoted strings", () => {
    const lines = ["import { create } from 'zustand';"];
    const result = extractStringLiterals(lines);
    expect(result).toContain("zustand");
  });

  it("returns empty array for lines with no literals", () => {
    const lines = ["const x = 42;", "if (y > 10) {"];
    const result = extractStringLiterals(lines);
    expect(result).toHaveLength(0);
  });
});
