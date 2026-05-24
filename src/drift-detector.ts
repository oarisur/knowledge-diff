import * as core from "@actions/core";
import type {
  DriftResult,
  Sensitivity,
  AnalysisResult,
  ChangedFile,
  DocFile,
} from "./types";
import { LLMClient } from "./llm-client";
import { parseDocFile, buildDocIndex, findCandidateSections } from "./doc-extractor";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum chars of doc content to send per LLM call.
 * llm-client already truncates patch to 4000 and doc to 3000 individually,
 * but we add a guard here to skip candidates whose section content is empty.
 */
const MAX_SECTION_CHARS = 15_000;

// ─── Sensitivity → Confidence Threshold ──────────────────────────────────────

const CONFIDENCE_ORDER = ["definite", "likely", "possible"] as const;

function meetsThreshold(
  confidence: "definite" | "likely" | "possible",
  sensitivity: Sensitivity
): boolean {
  // low: only definite
  // medium: definite + likely
  // high: all
  const thresholds: Record<Sensitivity, number> = {
    low: 0,      // only index 0 (definite)
    medium: 1,   // index 0-1
    high: 2,     // all
  };
  const resultIndex = CONFIDENCE_ORDER.indexOf(confidence);
  return resultIndex <= thresholds[sensitivity];
}

// ─── Main Drift Detector ──────────────────────────────────────────────────────

export class DriftDetector {
  private llm: LLMClient;
  private sensitivity: Sensitivity;

  constructor(llm: LLMClient, sensitivity: Sensitivity) {
    this.llm = llm;
    this.sensitivity = sensitivity;
  }

  /**
   * Run drift detection across all changed code files against all doc files.
   * Returns a full AnalysisResult including all drift findings and metadata.
   */
  async analyse(
    changedFiles: ChangedFile[],
    docRawFiles: Array<{ filePath: string; content: string }>,
    skippedFiles: string[]
  ): Promise<AnalysisResult> {
    // Parse all doc files
    const docFiles: DocFile[] = docRawFiles.map((f) =>
      parseDocFile(f.filePath, f.content)
    );

    if (docFiles.length === 0) {
      core.warning("No documentation files found — nothing to check against.");
      return {
        driftResults: [],
        skippedFiles,
        checkedFiles: 0,
        docFilesChecked: [],
        totalCandidates: 0,
      };
    }

    // Build inverted keyword index over all doc sections
    const docIndex = buildDocIndex(docFiles);
    core.info(
      `Doc index built: ${docFiles.reduce((n, d) => n + d.sections.length, 0)} sections across ${docFiles.length} files.`
    );

    const allDriftResults: DriftResult[] = [];
    let totalCandidates = 0;

    for (const changedFile of changedFiles) {
      core.info(`Analysing: ${changedFile.filePath}`);

      const candidates = findCandidateSections(changedFile, docIndex, 3);
      totalCandidates += candidates.length;

      if (candidates.length === 0) {
        core.debug(`  No candidate doc sections found for ${changedFile.filePath}`);
        continue;
      }

      for (const candidate of candidates) {
        // Guard: skip extremely large doc sections
        if (candidate.matchedSection.content.length > MAX_SECTION_CHARS) {
          core.debug(
            `  Skipping ${candidate.matchedSection.filePath}#${candidate.matchedSection.heading} — content too large (${candidate.matchedSection.content.length} chars)`
          );
          continue;
        }

        core.debug(
          `  Checking against ${candidate.matchedSection.filePath}#${candidate.matchedSection.heading} (score: ${candidate.relevanceScore.toFixed(2)})`
        );

        let llmResult;
        try {
          llmResult = await this.llm.detectDrift(
            changedFile.filePath,
            changedFile.patch,
            candidate.matchedSection.filePath,
            candidate.matchedSection.heading,
            candidate.matchedSection.content,
            this.sensitivity
          );
        } catch (err) {
          core.warning(
            `  LLM call failed for candidate ${candidate.matchedSection.filePath}#${candidate.matchedSection.heading}: ${err}`
          );
          continue;
        }

        const meetsThresh = llmResult.isDrift &&
          meetsThreshold(llmResult.confidence, this.sensitivity);

        allDriftResults.push({
          changedFile,
          matchedSection: candidate.matchedSection,
          isDrift: llmResult.isDrift,
          confidence: llmResult.confidence,
          explanation: llmResult.explanation,
          staleText: llmResult.staleText,
          suggestedText: llmResult.suggestedText,
          meetsThreshold: meetsThresh,
        });

        if (meetsThresh) {
          core.warning(
            `  ⚠ Drift detected [${llmResult.confidence}]: ${llmResult.explanation.slice(0, 100)}`
          );
        }
      }
    }

    const actionableDrift = allDriftResults.filter((r) => r.meetsThreshold);
    core.info(
      `Analysis complete. ${actionableDrift.length} drift(s) found across ${totalCandidates} candidate pairs.`
    );

    return {
      driftResults: allDriftResults,
      skippedFiles,
      checkedFiles: changedFiles.length,
      docFilesChecked: docFiles.map((d) => d.filePath),
      totalCandidates,
    };
  }
}
