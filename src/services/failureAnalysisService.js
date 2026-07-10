// src/services/failureAnalysisService.js
// Failure post-mortems: classifies why a task failed into a root-cause
// taxonomy so the dashboard can show where AutoShip actually breaks.

import { providerRegistry } from "../providers/provider-registry.js";
import { pool } from "../db.js";
import { logger } from "../logger.js";

const ANALYSIS_MODEL = process.env.FAILURE_ANALYSIS_MODEL || "anthropic:claude-haiku-4-5-20251001";
const ANALYSIS_TIMEOUT = 30_000;

export const FAILURE_CATEGORIES = [
  "vague_ticket",      // task description too ambiguous to implement
  "auth_error",        // GitHub/ClickUp/Anthropic credentials or permissions
  "build_environment", // missing deps, wrong toolchain, build/test env broken
  "model_gave_up",     // Claude produced no changes or an incomplete result
  "timeout",           // run exceeded the configured timeout
  "budget_exceeded",   // live budget enforcement stopped the run
  "cancelled",         // user cancelled the run
  "git_error",         // clone/push/branch/merge conflicts
  "api_error",         // ClickUp/GitHub API failures (rate limits, 5xx)
  "infrastructure",    // DB, disk, network, process-level failures
  "unknown",
];

// Deterministic pre-classification for unambiguous failures — no AI needed
function quickClassify(errorMessage = "") {
  const msg = errorMessage.toLowerCase();
  if (msg.startsWith("budget exceeded")) return "budget_exceeded";
  if (msg.includes("cancelled by user")) return "cancelled";
  if (msg.includes("timed out") || msg.includes("timeout")) return "timeout";
  if (msg.includes("produced no output") || msg.includes("no code changes")) return "model_gave_up";
  if (msg.includes("authentication") || msg.includes("401") || msg.includes("403") || msg.includes("credentials")) return "auth_error";
  return null;
}

/**
 * Classify a failed task's root cause and persist it to failure_causes.
 * Fire-and-forget from the pipeline — never throws.
 */
export async function analyzeFailure({ taskId, taskName, repoFullName, failureStage, errorMessage }) {
  try {
    let category = quickClassify(errorMessage);
    let summary = errorMessage?.slice(0, 300) || "";
    let recommendation = "";

    if (!category) {
      // Pull recent execution logs for context
      let logLines = "";
      try {
        const { rows } = await pool.query(
          `SELECT level, step, message FROM execution_logs
           WHERE task_id = $1 ORDER BY created_at DESC LIMIT 25`,
          [taskId]
        );
        logLines = rows.reverse().map((r) => `[${r.level}] ${r.step}: ${r.message}`).join("\n").slice(0, 4000);
      } catch (_) {}

      const systemPrompt = `You classify why an automated coding-agent pipeline run failed.
Categories: ${FAILURE_CATEGORIES.join(", ")}.
Return ONLY a JSON object: {"category": "<one category>", "summary": "<1 sentence root cause>", "recommendation": "<1 sentence: how to prevent this class of failure>"}`;

      const userContent = [
        `Task: ${taskName}`,
        `Failed at stage: ${failureStage || "unknown"}`,
        `Error: ${errorMessage || "(none)"}`,
        logLines ? `\nRecent execution log:\n${logLines}` : "",
      ].join("\n");

      const response = await providerRegistry.chat(ANALYSIS_MODEL, [
        { role: "user", content: userContent },
      ], { systemPrompt, temperature: 0.1, maxTokens: 512, timeout: ANALYSIS_TIMEOUT });

      const content = typeof response === "string" ? response : response.content || response.text || "";
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/(\{[\s\S]*\})/);
      try {
        const parsed = JSON.parse(jsonMatch ? jsonMatch[1].trim() : content.trim());
        category = FAILURE_CATEGORIES.includes(parsed.category) ? parsed.category : "unknown";
        summary = String(parsed.summary || summary).slice(0, 500);
        recommendation = String(parsed.recommendation || "").slice(0, 500);
      } catch {
        category = "unknown";
      }
    }

    await pool.query(
      `INSERT INTO failure_causes (task_id, task_name, repo_full_name, failure_stage, category, summary, recommendation, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [taskId, taskName, repoFullName || null, failureStage || null, category, summary, recommendation, (errorMessage || "").slice(0, 2000)]
    );

    logger.info({ taskId, category }, "Failure classified");
    return { category, summary, recommendation };
  } catch (err) {
    logger.warn({ taskId, err: err.message }, "Failure analysis failed (non-fatal)");
    return null;
  }
}

/**
 * Pareto data: failure counts per category (for the Analytics page).
 */
export async function getFailurePareto(days = 30) {
  try {
    const { rows } = await pool.query(
      `SELECT category, COUNT(*)::int as count,
              MAX(created_at) as last_seen
       FROM failure_causes
       WHERE created_at > NOW() - ($1 || ' days')::interval
       GROUP BY category
       ORDER BY count DESC`,
      [String(Math.max(1, parseInt(days, 10) || 30))]
    );
    const total = rows.reduce((n, r) => n + r.count, 0);
    return {
      total,
      categories: rows.map((r) => ({ ...r, percent: total > 0 ? Math.round((r.count / total) * 100) : 0 })),
    };
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to get failure pareto");
    return { total: 0, categories: [] };
  }
}

/**
 * Recent classified failures with details.
 */
export async function getRecentFailures(limit = 20) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM failure_causes ORDER BY created_at DESC LIMIT $1`,
      [Math.min(limit, 100)]
    );
    return rows;
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to get recent failures");
    return [];
  }
}
