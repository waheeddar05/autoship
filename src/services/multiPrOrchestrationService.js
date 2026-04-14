// src/services/multiPrOrchestrationService.js
// Multi-PR orchestration: parent tasks spawn child PRs with dependency ordering.
// E.g., a migration PR must merge before the service PR that depends on it.

import { pool } from "../db.js";
import { logger } from "../logger.js";

/**
 * Create a multi-PR execution plan from decomposed subtasks.
 *
 * @param {number} parentTaskId
 * @param {Array<{name: string, repo: string, type: string, dependsOn: number[]}>} prPlan
 * @returns {Array<object>} created PR plan entries
 */
export async function createMultiPrPlan(parentTaskId, prPlan) {
  const created = [];

  for (const pr of prPlan) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO multi_pr_plans (parent_task_id, name, repo_full_name, pr_type, depends_on_indices, state, "order")
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)
         RETURNING *`,
        [parentTaskId, pr.name, pr.repo, pr.type, JSON.stringify(pr.dependsOn || []), pr.order || 0]
      );
      created.push(rows[0]);
    } catch (err) {
      logger.warn({ parentTaskId, prName: pr.name, err: err.message }, "Failed to create PR plan entry");
    }
  }

  logger.info({ parentTaskId, planned: created.length }, "Multi-PR plan created");
  return created;
}

/**
 * Get the next PR to execute from a multi-PR plan.
 * Only returns a PR whose dependencies have all been completed.
 */
export async function getNextPrToExecute(parentTaskId) {
  try {
    const { rows: allPrs } = await pool.query(
      `SELECT * FROM multi_pr_plans WHERE parent_task_id = $1 ORDER BY "order" ASC`,
      [parentTaskId]
    );

    const completedIndices = new Set(
      allPrs.filter(p => p.state === "completed").map((_, i) => i)
    );

    for (const pr of allPrs) {
      if (pr.state !== "pending") continue;

      const deps = typeof pr.depends_on_indices === "string"
        ? JSON.parse(pr.depends_on_indices)
        : pr.depends_on_indices || [];

      const allDepsMet = deps.every(d => completedIndices.has(d));
      if (allDepsMet) return pr;
    }

    return null;
  } catch (err) {
    logger.warn({ parentTaskId, err: err.message }, "Failed to get next PR");
    return null;
  }
}

/**
 * Mark a PR plan entry as completed.
 */
export async function completePrPlanEntry(entryId, { prUrl, prNumber, branchName }) {
  try {
    await pool.query(
      `UPDATE multi_pr_plans SET state = 'completed', pr_url = $2, pr_number = $3, branch_name = $4, completed_at = NOW()
       WHERE id = $1`,
      [entryId, prUrl, prNumber, branchName]
    );
    logger.info({ entryId, prUrl }, "PR plan entry completed");
  } catch (err) {
    logger.warn({ entryId, err: err.message }, "Failed to complete PR plan entry");
  }
}

/**
 * Mark a PR plan entry as failed.
 */
export async function failPrPlanEntry(entryId, errorMessage) {
  try {
    await pool.query(
      `UPDATE multi_pr_plans SET state = 'failed', error_message = $2, completed_at = NOW()
       WHERE id = $1`,
      [entryId, errorMessage]
    );
  } catch (err) {
    logger.warn({ entryId, err: err.message }, "Failed to fail PR plan entry");
  }
}

/**
 * Get the full multi-PR plan status for a task.
 */
export async function getMultiPrStatus(parentTaskId) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM multi_pr_plans WHERE parent_task_id = $1 ORDER BY "order" ASC`,
      [parentTaskId]
    );

    const total = rows.length;
    const completed = rows.filter(r => r.state === "completed").length;
    const failed = rows.filter(r => r.state === "failed").length;

    return {
      entries: rows,
      total,
      completed,
      failed,
      pending: total - completed - failed,
      allComplete: completed === total && total > 0,
      progress: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  } catch (err) {
    logger.warn({ parentTaskId, err: err.message }, "Failed to get multi-PR status");
    return { entries: [], total: 0, completed: 0, failed: 0, pending: 0, allComplete: false, progress: 0 };
  }
}
