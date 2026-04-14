// src/services/diffPreviewService.js
// AI-powered diff/impact preview generation for coding plans.

import { providerRegistry } from "../providers/provider-registry.js";
import { logger } from "../logger.js";
import { config } from "../config-manager.js";
import { pool } from "../db.js";
import { addTaskCost } from "../task-queue.js";
import { recordTokenUsage } from "../prometheus.js";

const PREVIEW_MODEL = process.env.DIFF_PREVIEW_MODEL || "anthropic:claude-sonnet-4-6";
const PREVIEW_TIMEOUT = 60_000; // 60 seconds

/**
 * Generate a predicted impact preview for a coding plan.
 *
 * @param {object} params
 * @param {string} params.codingPlan - The generated coding plan markdown
 * @param {string} params.taskName - Task name
 * @param {string} [params.repoContext] - Repository context
 * @param {number} [params.taskId] - DB task ID for cost tracking
 * @returns {{ preview: string, predictedFiles: object[] }}
 */
export async function generateDiffPreview({ codingPlan, taskName, repoContext, taskId }) {
  const systemPrompt = `You are a senior engineer predicting the impact of a coding plan.

Given a coding plan, output a structured "Impact Preview" in markdown with:

1. **Files to Modify** — List each existing file that will be changed, with a brief description of the change and estimated lines changed (+added / -removed).
2. **Files to Create** — List each new file to be created, with purpose and estimated size.
3. **Files to Delete** — List any files to be removed (if applicable).
4. **Estimated Total Impact** — Total files affected, estimated net lines changed.

Format as clean markdown. Be precise about file paths. Use the coding plan and repo context to make accurate predictions. Do NOT include any caveats or hedging.`;

  const userContent = [
    `# Task: ${taskName}`,
    "",
    "## Coding Plan",
    codingPlan.substring(0, 6000),
  ];

  if (repoContext) {
    userContent.push("", "## Repository Context", repoContext.substring(0, 3000));
  }

  userContent.push("", "Generate the Impact Preview now.");

  const messages = [{ role: "user", content: userContent.join("\n") }];

  try {
    const response = await providerRegistry.chat(PREVIEW_MODEL, messages, {
      systemPrompt,
      temperature: 0.3,
      maxTokens: 2048,
      timeout: PREVIEW_TIMEOUT,
    });

    const preview = typeof response === "string" ? response : response.content || response.text || "";
    const usage = response.usage || {};

    // Track costs
    if (taskId && config.get("costTrackingEnabled")) {
      try {
        await addTaskCost(taskId, {
          stepName: "diff_preview",
          modelUsed: PREVIEW_MODEL,
          promptTokens: usage.inputTokens || 0,
          completionTokens: usage.outputTokens || 0,
          totalTokens: (usage.inputTokens || 0) + (usage.outputTokens || 0),
          estimatedCost: 0,
        });
        recordTokenUsage(PREVIEW_MODEL, "diff_preview", (usage.inputTokens || 0) + (usage.outputTokens || 0));
      } catch (_) {}
    }

    // Parse predicted files from the preview
    const predictedFiles = parsePredictedFiles(preview);

    logger.info(
      { taskName, previewLength: preview.length, fileCount: predictedFiles.length },
      "Diff preview generated"
    );

    return { preview: preview.trim(), predictedFiles };
  } catch (err) {
    logger.error({ taskName, err: err.message }, "Diff preview generation failed");
    throw err;
  }
}

/**
 * Compare predicted diff with actual changes after execution.
 * Records accuracy metrics to the database.
 *
 * @param {object} params
 * @param {number} params.taskId - DB task ID
 * @param {object[]} params.predictedFiles - From generateDiffPreview
 * @param {string[]} params.actualFiles - Actual files changed (from git diff --name-only)
 */
export async function comparePredictedVsActual({ taskId, predictedFiles, actualFiles }) {
  try {
    const predictedPaths = predictedFiles.map((f) => f.path);
    const actualSet = new Set(actualFiles);
    const predictedSet = new Set(predictedPaths);

    const correctlyPredicted = predictedPaths.filter((p) => actualSet.has(p));
    const missed = actualFiles.filter((p) => !predictedSet.has(p));
    const falsePositives = predictedPaths.filter((p) => !actualSet.has(p));

    const accuracy = actualFiles.length > 0
      ? Math.round((correctlyPredicted.length / actualFiles.length) * 100)
      : 100;

    const result = {
      accuracy,
      correctlyPredicted: correctlyPredicted.length,
      missed: missed.length,
      falsePositives: falsePositives.length,
      totalPredicted: predictedPaths.length,
      totalActual: actualFiles.length,
      missedFiles: missed.slice(0, 10),
      falsePositiveFiles: falsePositives.slice(0, 10),
    };

    // Store accuracy in database
    await pool.query(
      `INSERT INTO diff_preview_accuracy (task_id, accuracy, predicted_count, actual_count, correctly_predicted, missed, false_positives, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        taskId, accuracy, predictedPaths.length, actualFiles.length,
        correctlyPredicted.length, missed.length, falsePositives.length,
        JSON.stringify(result),
      ]
    );

    logger.info(
      { taskId, accuracy, predicted: predictedPaths.length, actual: actualFiles.length },
      "Diff preview accuracy recorded"
    );

    return result;
  } catch (err) {
    logger.warn({ taskId, err: err.message }, "Failed to record diff preview accuracy (non-fatal)");
    return null;
  }
}

/**
 * Parse predicted file paths from the generated preview markdown.
 */
function parsePredictedFiles(preview) {
  const files = [];
  const lines = preview.split("\n");

  for (const line of lines) {
    // Match patterns like: - `src/foo/bar.js` — description (+10 / -5)
    // or: - src/foo/bar.js — description
    const fileMatch = line.match(/[-*]\s+`?([^\s`]+\.\w+)`?\s*[-—:]/);
    if (fileMatch) {
      const filePath = fileMatch[1];
      const linesMatch = line.match(/\+(\d+)\s*\/?\s*-(\d+)/);
      files.push({
        path: filePath,
        linesAdded: linesMatch ? parseInt(linesMatch[1]) : 0,
        linesRemoved: linesMatch ? parseInt(linesMatch[2]) : 0,
        action: line.toLowerCase().includes("create") ? "create" :
                line.toLowerCase().includes("delete") ? "delete" : "modify",
      });
    }
  }

  return files;
}
