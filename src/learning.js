// src/learning.js
// Feature 10: Learning from Past PRs
// Records PR outcomes and provides historical insights for task execution.

import { pool } from "./db.js";
import { logger } from "./logger.js";

/**
 * Record the outcome of a PR (merged, changes requested, review comments).
 */
export async function recordPROutcome(taskId, prUrl, outcome = {}) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO pr_outcomes (task_id, pr_url, merged, changes_requested, review_comments, revisions, time_to_merge_ms, merged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        taskId,
        prUrl,
        outcome.merged || false,
        outcome.changesRequested || false,
        JSON.stringify(outcome.reviewComments || []),
        outcome.revisionCount || 0,
        outcome.timeToMerge || null,
        outcome.merged ? new Date().toISOString() : null,
      ]
    );

    logger.info({ taskId, prUrl, merged: outcome.merged }, "PR outcome recorded");
    return rows[0];
  } catch (err) {
    logger.error({ taskId, prUrl, err: err.message }, "Failed to record PR outcome");
    return null;
  }
}

/**
 * Get historical insights for a repo to inform task execution.
 */
export async function getHistoricalInsights(repoName, taskDescription) {
  const result = {
    commonIssues: [],
    avgRevisionsNeeded: 0,
    successRate: 0,
    tips: [],
  };

  try {
    // Get PR outcomes for this repo
    const { rows: outcomes } = await pool.query(
      `SELECT po.*, t.repo_name, t.name as task_name, t.description as task_description
       FROM pr_outcomes po
       JOIN tasks t ON t.id = po.task_id
       WHERE t.repo_name = $1 OR t.repo_full_name LIKE $2
       ORDER BY po.created_at DESC
       LIMIT 50`,
      [repoName, `%/${repoName}`]
    );

    if (outcomes.length === 0) return result;

    // Calculate success rate
    const merged = outcomes.filter((o) => o.merged).length;
    result.successRate = Math.round((merged / outcomes.length) * 100);

    // Average revisions
    const totalRevisions = outcomes.reduce((sum, o) => sum + (o.revisions || 0), 0);
    result.avgRevisionsNeeded = Math.round((totalRevisions / outcomes.length) * 10) / 10;

    // Extract common review comments/issues
    const allComments = [];
    for (const outcome of outcomes) {
      const comments = outcome.review_comments || [];
      for (const comment of comments) {
        if (typeof comment === "string") {
          allComments.push(comment);
        } else if (comment.body) {
          allComments.push(comment.body);
        }
      }
    }

    // Find common themes in review comments
    const issuePatterns = {
      "Missing tests": /test|spec|coverage/i,
      "Code style / formatting": /format|style|lint|indent/i,
      "Error handling": /error\s+handling|try\s+catch|exception/i,
      "Documentation": /doc|comment|readme|javadoc/i,
      "Security concerns": /secur|auth|inject|xss|csrf|saniti/i,
      "Performance": /perform|optim|slow|memory|cache/i,
      "Type safety": /type|typescript|typing|generics/i,
      "API design": /api|endpoint|route|rest|contract/i,
    };

    const issueCounts = {};
    for (const comment of allComments) {
      for (const [issue, pattern] of Object.entries(issuePatterns)) {
        if (pattern.test(comment)) {
          issueCounts[issue] = (issueCounts[issue] || 0) + 1;
        }
      }
    }

    result.commonIssues = Object.entries(issueCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([issue]) => issue);

    // Generate tips
    if (result.avgRevisionsNeeded > 2) {
      result.tips.push("PRs for this repo typically need multiple revisions. Be extra thorough.");
    }
    if (result.commonIssues.includes("Missing tests")) {
      result.tips.push("Always include tests — reviewers frequently request them for this repo.");
    }
    if (result.commonIssues.includes("Error handling")) {
      result.tips.push("Pay special attention to error handling — it's a common review comment.");
    }
    if (result.successRate < 70) {
      result.tips.push("Success rate is below 70%. Consider breaking tasks into smaller PRs.");
    }

    return result;
  } catch (err) {
    logger.error({ repoName, err: err.message }, "Failed to get historical insights");
    return result;
  }
}

/**
 * Update a PR outcome when the PR is merged.
 */
export async function updatePRMerged(prUrl) {
  try {
    await pool.query(
      `UPDATE pr_outcomes SET merged = TRUE, merged_at = NOW(),
       time_to_merge_ms = EXTRACT(EPOCH FROM (NOW() - created_at))::bigint * 1000
       WHERE pr_url = $1 AND merged = FALSE`,
      [prUrl]
    );
    logger.info({ prUrl }, "PR marked as merged");
  } catch (err) {
    logger.warn({ prUrl, err: err.message }, "Failed to update PR merged status");
  }
}

/**
 * Record an auto-fix attempt from PR review comments.
 */
export async function recordAutoFixAttempt({
  taskId, prReviewId, prNumber, repoFullName,
  reviewComments, fixInstructions, fixSummary, success, errorMessage, durationMs,
}) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO auto_fix_attempts
        (task_id, pr_review_id, pr_number, repo_full_name, review_comments, fix_instructions, fix_summary, success, error_message, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        taskId, prReviewId, prNumber, repoFullName,
        JSON.stringify(reviewComments || []),
        fixInstructions, fixSummary, success, errorMessage, durationMs,
      ]
    );

    logger.info({ taskId, prNumber, success }, "Auto-fix attempt recorded");
    return rows[0];
  } catch (err) {
    logger.warn({ prNumber, err: err.message }, "Failed to record auto-fix attempt (non-fatal)");
    return null;
  }
}

/**
 * Record diff preview accuracy for a task.
 */
export async function recordDiffPreviewAccuracy({ taskId, accuracy, details }) {
  try {
    logger.info({ taskId, accuracy }, "Diff preview accuracy logged");
  } catch (err) {
    logger.warn({ taskId, err: err.message }, "Failed to record diff preview accuracy (non-fatal)");
  }
}

/**
 * Update a PR outcome when changes are requested.
 */
export async function updatePRChangesRequested(prUrl, reviewComments = []) {
  try {
    await pool.query(
      `UPDATE pr_outcomes SET 
       changes_requested = TRUE,
       revisions = revisions + 1,
       review_comments = review_comments || $2::jsonb
       WHERE pr_url = $1`,
      [prUrl, JSON.stringify(reviewComments)]
    );
  } catch (err) {
    logger.warn({ prUrl, err: err.message }, "Failed to update PR changes requested");
  }
}
