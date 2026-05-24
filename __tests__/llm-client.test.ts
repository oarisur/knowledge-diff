import { buildDriftPrompt, withRetry, LLMClient } from "../src/llm-client";

// Suppress @actions/core logging during tests
jest.mock("@actions/core", () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

// Mock the OpenAI and Anthropic SDKs so we never make real API calls
jest.mock("openai", () => {
  class APIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }

  const MockOpenAI = jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn(),
      },
    },
  }));

  (MockOpenAI as any).APIError = APIError;
  return MockOpenAI;
});

jest.mock("@anthropic-ai/sdk", () => {
  const mockCreate = jest.fn();
  const MockAnthropic = jest.fn().mockImplementation(() => ({
    messages: {
      create: mockCreate,
    },
  }));
  // Attach APIError for isRetryable checks
  (MockAnthropic as any).APIError = class APIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  };
  return MockAnthropic;
});

jest.mock("@google/genai", () => {
  const mockGenerateContent = jest.fn();
  return {
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      models: {
        generateContent: mockGenerateContent,
      },
    })),
  };
});

// ─── buildDriftPrompt ─────────────────────────────────────────────────────────

describe("buildDriftPrompt", () => {
  const baseArgs = {
    codeFilePath: "src/store/cart.ts",
    patch: "@@ -1,5 +1,5 @@\n-import Redux\n+import Zustand",
    docFilePath: "README.md",
    docHeading: "State Management",
    docContent: "We use Redux Toolkit for all global state.",
  };

  it("includes all required context in the prompt", () => {
    const prompt = buildDriftPrompt(
      baseArgs.codeFilePath,
      baseArgs.patch,
      baseArgs.docFilePath,
      baseArgs.docHeading,
      baseArgs.docContent,
      "medium"
    );

    expect(prompt).toContain("src/store/cart.ts");
    expect(prompt).toContain("import Zustand");
    expect(prompt).toContain("README.md");
    expect(prompt).toContain("State Management");
    expect(prompt).toContain("Redux Toolkit");
    expect(prompt).toContain("isDrift");
  });

  it("uses low sensitivity instructions for 'low'", () => {
    const prompt = buildDriftPrompt(
      baseArgs.codeFilePath,
      baseArgs.patch,
      baseArgs.docFilePath,
      baseArgs.docHeading,
      baseArgs.docContent,
      "low"
    );

    expect(prompt).toContain("Only flag definite contradictions");
  });

  it("uses high sensitivity instructions for 'high'", () => {
    const prompt = buildDriftPrompt(
      baseArgs.codeFilePath,
      baseArgs.patch,
      baseArgs.docFilePath,
      baseArgs.docHeading,
      baseArgs.docContent,
      "high"
    );

    expect(prompt).toContain("possible");
    expect(prompt).toContain("Err on the side of caution");
  });

  it("truncates long patches to 4000 chars", () => {
    const longPatch = "x".repeat(8000);
    const prompt = buildDriftPrompt(
      baseArgs.codeFilePath,
      longPatch,
      baseArgs.docFilePath,
      baseArgs.docHeading,
      baseArgs.docContent,
      "medium"
    );

    // The patch inside the prompt should be truncated
    const patchInPrompt = prompt.match(/```diff\n([\s\S]*?)```/);
    expect(patchInPrompt).toBeDefined();
    expect(patchInPrompt![1].length).toBeLessThanOrEqual(4001); // 4000 + newline
  });

  it("truncates long doc content to 3000 chars", () => {
    const longContent = "y".repeat(6000);
    const prompt = buildDriftPrompt(
      baseArgs.codeFilePath,
      baseArgs.patch,
      baseArgs.docFilePath,
      baseArgs.docHeading,
      longContent,
      "medium"
    );

    const docInPrompt = prompt.match(/```markdown\n([\s\S]*?)```/);
    expect(docInPrompt).toBeDefined();
    expect(docInPrompt![1].length).toBeLessThanOrEqual(3001);
  });
});

// ─── withRetry ────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  it("returns result on first successful call", async () => {
    const fn = jest.fn().mockResolvedValue("success");
    const result = await withRetry(fn, "test");
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws immediately on non-retryable errors", async () => {
    const err = new Error("Invalid API key");
    const fn = jest.fn().mockRejectedValue(err);

    await expect(withRetry(fn, "test")).rejects.toThrow("Invalid API key");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on network errors and eventually succeeds", async () => {
    const networkErr = new Error("fetch failed");
    const fn = jest
      .fn()
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValue("recovered");

    const result = await withRetry(fn, "test");
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  }, 15000);

  it("retries on ETIMEDOUT errors", async () => {
    const timeoutErr = new Error("ETIMEDOUT");
    const fn = jest
      .fn()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValue("ok");

    const result = await withRetry(fn, "test");
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  }, 15000);
});

// ─── LLMClient.detectDrift ────────────────────────────────────────────────────

describe("LLMClient", () => {
  it("creates an OpenAI client when provider is openai", () => {
    const client = new LLMClient("openai", "test-key");
    expect(client).toBeDefined();
  });

  it("creates an Anthropic client when provider is anthropic", () => {
    const client = new LLMClient("anthropic", "test-key");
    expect(client).toBeDefined();
  });

  it("creates a Gemini client when provider is gemini", () => {
    const client = new LLMClient("gemini", "test-key");
    expect(client).toBeDefined();
  });

  it("uses custom model when modelOverride is provided", () => {
    const client = new LLMClient("openai", "test-key", "gpt-4o-mini");
    expect(client).toBeDefined();
  });

  describe("parseResponse (via detectDrift)", () => {
    it("handles valid JSON drift response from OpenAI", async () => {
      const OpenAI = require("openai");
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                isDrift: true,
                confidence: "definite",
                explanation: "Redux replaced with Zustand",
                staleText: "We use Redux",
                suggestedText: "We use Zustand",
              }),
            },
          },
        ],
      });

      OpenAI.mockImplementation(() => ({
        chat: { completions: { create: mockCreate } },
      }));

      const client = new LLMClient("openai", "test-key");
      const result = await client.detectDrift(
        "cart.ts",
        "patch",
        "README.md",
        "State",
        "doc content",
        "medium"
      );

      expect(result.isDrift).toBe(true);
      expect(result.confidence).toBe("definite");
      expect(result.explanation).toContain("Redux");
      expect(result.staleText).toBe("We use Redux");
      expect(result.suggestedText).toBe("We use Zustand");
    });

    it("handles JSON wrapped in markdown code fences", async () => {
      const OpenAI = require("openai");
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: '```json\n{"isDrift": false, "confidence": "possible", "explanation": "No contradiction."}\n```',
            },
          },
        ],
      });

      OpenAI.mockImplementation(() => ({
        chat: { completions: { create: mockCreate } },
      }));

      const client = new LLMClient("openai", "test-key");
      const result = await client.detectDrift(
        "file.ts",
        "patch",
        "doc.md",
        "Section",
        "content",
        "medium"
      );

      expect(result.isDrift).toBe(false);
      expect(result.confidence).toBe("possible");
    });

    it("handles valid JSON drift response from Gemini", async () => {
      const { GoogleGenAI } = require("@google/genai");
      const mockGenerateContent = jest.fn().mockResolvedValue({
        text: JSON.stringify({
          isDrift: true,
          confidence: "definite",
          explanation: "Gemini explains drift",
        }),
      });

      GoogleGenAI.mockImplementation(() => ({
        models: { generateContent: mockGenerateContent },
      }));

      const client = new LLMClient("gemini", "test-key");
      const result = await client.detectDrift(
        "file.ts",
        "patch",
        "doc.md",
        "Section",
        "content",
        "medium"
      );

      expect(result.isDrift).toBe(true);
      expect(result.confidence).toBe("definite");
      expect(result.explanation).toContain("Gemini explains");
    });

    it("returns safe defaults on unparseable response", async () => {
      const OpenAI = require("openai");
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content: "this is not json at all" } }],
      });

      OpenAI.mockImplementation(() => ({
        chat: { completions: { create: mockCreate } },
      }));

      const client = new LLMClient("openai", "test-key");
      const result = await client.detectDrift(
        "file.ts",
        "patch",
        "doc.md",
        "Section",
        "content",
        "medium"
      );

      expect(result.isDrift).toBe(false);
      expect(result.confidence).toBe("possible");
      expect(result.explanation).toContain("Could not parse");
    });

    it("returns safe defaults on empty OpenAI response", async () => {
      const OpenAI = require("openai");
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content: null } }],
      });

      OpenAI.mockImplementation(() => ({
        chat: { completions: { create: mockCreate } },
      }));

      const client = new LLMClient("openai", "test-key");
      const result = await client.detectDrift(
        "file.ts",
        "patch",
        "doc.md",
        "Section",
        "content",
        "medium"
      );

      // Empty JSON {} → isDrift: false
      expect(result.isDrift).toBe(false);
    });

    it("returns safe defaults when LLM call throws", async () => {
      const OpenAI = require("openai");
      const mockCreate = jest.fn().mockRejectedValue(new Error("API down"));

      OpenAI.mockImplementation(() => ({
        chat: { completions: { create: mockCreate } },
      }));

      const client = new LLMClient("openai", "test-key");
      const result = await client.detectDrift(
        "file.ts",
        "patch",
        "doc.md",
        "Section",
        "content",
        "medium"
      );

      expect(result.isDrift).toBe(false);
      expect(result.explanation).toContain("LLM call failed");
    });

    it("handles valid JSON drift response from Anthropic", async () => {
      const Anthropic = require("@anthropic-ai/sdk");
      const mockCreate = jest.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: '"isDrift": true, "confidence": "definite", "explanation": "Anthropic detected drift", "staleText": "old text", "suggestedText": "new text"}',
          },
        ],
      });

      Anthropic.mockImplementation(() => ({
        messages: { create: mockCreate },
      }));

      const client = new LLMClient("anthropic", "test-key");
      const result = await client.detectDrift(
        "file.ts",
        "patch",
        "doc.md",
        "Section",
        "content",
        "medium"
      );

      expect(result.isDrift).toBe(true);
      expect(result.confidence).toBe("definite");
      expect(result.explanation).toContain("Anthropic detected drift");
      expect(result.staleText).toBe("old text");
      expect(result.suggestedText).toBe("new text");
    });

    it("handles Anthropic response where model includes opening brace", async () => {
      const Anthropic = require("@anthropic-ai/sdk");
      const mockCreate = jest.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: '{"isDrift": false, "confidence": "possible", "explanation": "No drift found."}',
          },
        ],
      });

      Anthropic.mockImplementation(() => ({
        messages: { create: mockCreate },
      }));

      const client = new LLMClient("anthropic", "test-key");
      const result = await client.detectDrift(
        "file.ts",
        "patch",
        "doc.md",
        "Section",
        "content",
        "medium"
      );

      expect(result.isDrift).toBe(false);
      expect(result.confidence).toBe("possible");
    });

    it("handles Anthropic non-text content block", async () => {
      const Anthropic = require("@anthropic-ai/sdk");
      const mockCreate = jest.fn().mockResolvedValue({
        content: [{ type: "tool_use", id: "123", name: "test", input: {} }],
      });

      Anthropic.mockImplementation(() => ({
        messages: { create: mockCreate },
      }));

      const client = new LLMClient("anthropic", "test-key");
      const result = await client.detectDrift(
        "file.ts",
        "patch",
        "doc.md",
        "Section",
        "content",
        "medium"
      );

      // Returns empty JSON defaults
      expect(result.isDrift).toBe(false);
    });
  });
});

// ─── withRetry exhaustion ─────────────────────────────────────────────────────

describe("withRetry — exhaustion", () => {
  it("throws after exhausting all retries on retryable error", async () => {
    const retryableErr = new Error("fetch failed");
    const fn = jest.fn().mockRejectedValue(retryableErr);

    await expect(withRetry(fn, "test")).rejects.toThrow("fetch failed");
    // MAX_RETRIES is 4, so 5 total attempts (0..4)
    expect(fn).toHaveBeenCalledTimes(5);
  }, 30000);

  it("retries on HTTP 429 status errors", async () => {
    const rateLimitErr = Object.assign(new Error("Rate limited"), { status: 429 });
    const fn = jest
      .fn()
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValue("ok");

    const result = await withRetry(fn, "test");
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  }, 15000);
});

