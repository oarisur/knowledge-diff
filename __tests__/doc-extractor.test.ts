import { parseDocFile, buildDocIndex, findCandidateSections } from "../src/doc-extractor";
import type { ChangedFile } from "../src/types";
import { README_WITH_REDUX, ARCHITECTURE_WITH_V1_API, UNRELATED_CHANGELOG, README_WITH_CONFIG_TABLE } from "./fixtures/docs";
import { REDUX_TO_ZUSTAND_PATCH, API_ROUTE_PATCH, DB_SWITCH_PATCH, MODEL_NAME_CHANGE_PATCH } from "./fixtures/diffs";

// Suppress @actions/core logging during tests
jest.mock("@actions/core", () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
}));

// ─── Helper ────────────────────────────────────────────────────────────────────

function makeChangedFile(
  filePath: string,
  patch: string,
  changedSymbols: string[],
  changedLiterals: string[] = []
): ChangedFile {
  const additions = patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
  const deletions = patch
    .split("\n")
    .filter((l) => l.startsWith("-") && !l.startsWith("---"))
    .map((l) => l.slice(1));

  return {
    filePath,
    patch,
    additions,
    deletions,
    changedSymbols,
    changedLiterals,
    tokenEstimate: Math.ceil(patch.length / 4),
  };
}

// ─── parseDocFile ──────────────────────────────────────────────────────────────

describe("parseDocFile", () => {
  it("splits README into sections by heading", () => {
    const doc = parseDocFile("README.md", README_WITH_REDUX);
    expect(doc.sections.length).toBeGreaterThanOrEqual(4);

    const headings = doc.sections.map((s) => s.heading);
    expect(headings).toContain("State Management");
    expect(headings).toContain("API");
    expect(headings).toContain("Database");
  });

  it("extracts keywords from headings and code spans", () => {
    const doc = parseDocFile("README.md", README_WITH_REDUX);
    const stateMgmt = doc.sections.find((s) => s.heading === "State Management");
    expect(stateMgmt).toBeDefined();

    // Should pick up technology keywords
    expect(stateMgmt!.keywords).toContain("redux");
    // Should pick up file paths
    expect(stateMgmt!.keywords.some((k) => k.includes("cart"))).toBe(true);
  });

  it("sets correct heading levels", () => {
    const doc = parseDocFile("README.md", README_WITH_REDUX);
    const appTitle = doc.sections.find((s) => s.heading === "My App");
    const stateMgmt = doc.sections.find((s) => s.heading === "State Management");

    expect(appTitle?.level).toBe(1);
    expect(stateMgmt?.level).toBe(2);
  });

  it("handles architecture doc with versioned API section", () => {
    const doc = parseDocFile("ARCHITECTURE.md", ARCHITECTURE_WITH_V1_API);
    const apiSection = doc.sections.find((s) => s.heading === "API Versioning");
    expect(apiSection).toBeDefined();
    expect(apiSection!.content).toContain("/api/v1/");
  });
});

// ─── buildDocIndex + findCandidateSections ──────────────────────────────────

describe("findCandidateSections", () => {
  it("matches Redux→Zustand code change to State Management section", () => {
    const docs = [
      parseDocFile("README.md", README_WITH_REDUX),
      parseDocFile("ARCHITECTURE.md", ARCHITECTURE_WITH_V1_API),
    ];
    const index = buildDocIndex(docs);

    const cartChange = makeChangedFile(
      "src/store/cart.ts",
      REDUX_TO_ZUSTAND_PATCH,
      ["useCartStore", "cartSlice", "createSlice"]
    );

    const candidates = findCandidateSections(cartChange, index, 3);
    expect(candidates.length).toBeGreaterThan(0);

    // The top candidate should be the State Management section
    const topCandidate = candidates[0];
    expect(topCandidate.matchedSection.heading).toBe("State Management");
    expect(topCandidate.relevanceScore).toBe(1);
  });

  it("matches API route change to API Versioning section", () => {
    const docs = [
      parseDocFile("README.md", README_WITH_REDUX),
      parseDocFile("ARCHITECTURE.md", ARCHITECTURE_WITH_V1_API),
    ];
    const index = buildDocIndex(docs);

    const routeChange = makeChangedFile(
      "src/routes/users.ts",
      API_ROUTE_PATCH,
      ["router"]
    );

    const candidates = findCandidateSections(routeChange, index, 3);
    expect(candidates.length).toBeGreaterThan(0);

    // Should find API Versioning in ARCHITECTURE.md as a top candidate
    const apiCandidate = candidates.find(
      (c) => c.matchedSection.heading === "API Versioning"
    );
    expect(apiCandidate).toBeDefined();
  });

  it("matches DB driver change to Database section", () => {
    const docs = [
      parseDocFile("README.md", README_WITH_REDUX),
      parseDocFile("ARCHITECTURE.md", ARCHITECTURE_WITH_V1_API),
    ];
    const index = buildDocIndex(docs);

    const dbChange = makeChangedFile(
      "src/db/index.ts",
      DB_SWITCH_PATCH,
      ["MongoClient", "Pool", "getUser"]
    );

    const candidates = findCandidateSections(dbChange, index, 5);
    expect(candidates.length).toBeGreaterThan(0);

    // Should find a Database section
    const dbCandidate = candidates.find(
      (c) => c.matchedSection.heading === "Database"
    );
    expect(dbCandidate).toBeDefined();
  });

  it("returns empty candidates for unrelated changes", () => {
    const docs = [parseDocFile("CHANGELOG.md", UNRELATED_CHANGELOG)];
    const index = buildDocIndex(docs);

    const cartChange = makeChangedFile(
      "src/store/cart.ts",
      REDUX_TO_ZUSTAND_PATCH,
      ["useCartStore", "cartSlice"]
    );

    const candidates = findCandidateSections(cartChange, index, 3);
    expect(candidates).toHaveLength(0);
  });

  it("limits results to topN", () => {
    const docs = [
      parseDocFile("README.md", README_WITH_REDUX),
      parseDocFile("ARCHITECTURE.md", ARCHITECTURE_WITH_V1_API),
    ];
    const index = buildDocIndex(docs);

    const dbChange = makeChangedFile(
      "src/db/index.ts",
      DB_SWITCH_PATCH,
      ["MongoClient", "Pool", "getUser"]
    );

    const candidates = findCandidateSections(dbChange, index, 1);
    expect(candidates.length).toBeLessThanOrEqual(1);
  });

  it("matches model name change to Configuration section via string literals", () => {
    const docs = [
      parseDocFile("README.md", README_WITH_CONFIG_TABLE),
    ];
    const index = buildDocIndex(docs);

    const modelChange = makeChangedFile(
      "src/llm-client.ts",
      MODEL_NAME_CHANGE_PATCH,
      ["DEFAULT_MODELS"],
      ["gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet-20241022", "gemini-2.5-flash"]
    );

    const candidates = findCandidateSections(modelChange, index, 5);
    expect(candidates.length).toBeGreaterThan(0);

    // The Configuration section should be a top candidate because
    // it contains the string literals "gpt-4o", "claude-3-5-sonnet-20241022", etc.
    const configCandidate = candidates.find(
      (c) => c.matchedSection.heading === "Configuration"
    );
    expect(configCandidate).toBeDefined();
    expect(configCandidate!.relevanceScore).toBeGreaterThan(0);
  });

  it("indexes quoted string values from doc content as keywords", () => {
    const doc = parseDocFile("README.md", README_WITH_CONFIG_TABLE);
    const configSection = doc.sections.find((s) => s.heading === "Configuration");
    expect(configSection).toBeDefined();

    // The config table mentions gpt-4o in backtick-quoted inline code
    expect(configSection!.keywords).toContain("gpt-4o");
    expect(configSection!.keywords).toContain("claude-3-5-sonnet-20241022");
    expect(configSection!.keywords).toContain("gemini-2.5-flash");
  });
});
