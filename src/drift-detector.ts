import * as core from "@actions/core";
import type {
  AnalysisError,
  AnalysisResult,
  ChangedFile,
  DocFile,
  DriftResult,
  Sensitivity,
} from "./types";
import { LLMClient } from "./llm-client";
import { parseDocFile, buildDocIndex, findCandidateSections } from "./doc-extractor";

const CONFIDENCE_ORDER = ["definite", "likely", "possible"] as const;

function meetsThreshold(
  confidence: "definite" | "likely" | "possible",
  sensitivity: Sensitivity
): boolean {
  const thresholds: Record<Sensitivity, number> = {
    low: 0,
    medium: 1,
    high: 2,
  };
  return CONFIDENCE_ORDER.indexOf(confidence) <= thresholds[sensitivity];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
   * Each changed file is evaluated in one batched LLM request containing up to
   * six relevant documentation sections.
   */
  async analyse(
    changedFiles: ChangedFile[],
    docRawFiles: Array<{ filePath: string; content: string }>,
    skippedFiles: string[]
  ): Promise<AnalysisResult> {
    const docFiles: DocFile[] = docRawFiles.map((file) =>
      parseDocFile(file.filePath, file.content)
    );

    if (docFiles.length === 0) {
      const message = "No documentation files were found, so drift analysis could not run.";
      core.warning(message);
      return {
        driftResults: [],
        skippedFiles,
        checkedFiles: 0,
        docFilesChecked: [],
        totalCandidates: 0,
        analysisErrors: [{ filePath: "*", message }],
      };
    }

    const docIndex = buildDocIndex(docFiles);
    core.info(
      `Doc index built: ${docFiles.reduce((count, doc) => count + doc.sections.length, 0)} sections across ${docFiles.length} files.`
    );

    const allDriftResults: DriftResult[] = [];
    const analysisErrors: AnalysisError[] = [];
    let totalCandidates = 0;

    for (const changedFile of changedFiles) {
      core.info(`Analysing: ${changedFile.filePath}`);

      const candidates = findCandidateSections(changedFile, docIndex, 6);
      totalCandidates += candidates.length;

      if (candidates.length === 0) {
        core.debug(`  No candidate doc sections found for ${changedFile.filePath}`);
        continue;
      }

      for (const candidate of candidates) {
        core.debug(
          `  Candidate ${candidate.matchedSection.filePath}#${candidate.matchedSection.heading} (score: ${candidate.relevanceScore.toFixed(2)})`
        );
      }

      let batchResults;
      try {
        batchResults = await this.llm.detectDriftBatch(
          changedFile.filePath,
          changedFile.patch,
          candidates.map((candidate) => ({
            docFilePath: candidate.matchedSection.filePath,
            docHeading: candidate.matchedSection.heading,
            docContent: candidate.matchedSection.content,
          })),
          this.sensitivity
        );
      } catch (err) {
        const message = `LLM analysis failed: ${errorMessage(err)}`;
        core.warning(`  ${changedFile.filePath}: ${message}`);
        analysisErrors.push({ filePath: changedFile.filePath, message });
        continue;
      }

      const resultsByIndex = new Map(
        batchResults.map((result) => [result.candidateIndex, result])
      );

      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
        const candidate = candidates[candidateIndex];
        const llmResult = resultsByIndex.get(candidateIndex);

        if (!llmResult) {
          const message =
            `LLM response omitted documentation candidate ${candidateIndex} ` +
            `(${candidate.matchedSection.filePath}#${candidate.matchedSection.heading}).`;
          core.warning(`  ${changedFile.filePath}: ${message}`);
          analysisErrors.push({ filePath: changedFile.filePath, message });
          continue;
        }

        const meetsThresh =
          llmResult.isDrift && meetsThreshold(llmResult.confidence, this.sensitivity);

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

    const actionableDrift = allDriftResults.filter((result) => result.meetsThreshold);
    core.info(
      `Analysis complete. ${actionableDrift.length} drift(s) found across ${totalCandidates} candidate pairs; ${analysisErrors.length} analysis error(s).`
    );

    return {
      driftResults: allDriftResults,
      skippedFiles,
      checkedFiles: changedFiles.length,
      docFilesChecked: docFiles.map((doc) => doc.filePath),
      totalCandidates,
      analysisErrors,
    };
  }
}
