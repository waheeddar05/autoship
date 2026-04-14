// src/services/staleTaskCleanupService.js
// Stale task cleanup: auto-fails tasks stuck in non-terminal states.
// Runs on a configurable interval to prevent task queue rot.

import { pool } from "../db.js";
import { logger } from "../logger.js";
import { notifySlack } from "../slack-notifier.js";

const STALE_THRESHOLDS = {
  received: 4 * 60 * 60 * 1000,     // 4 hours
  planning: 2 * 60 * 60 * 1000,     // 2 hours
  queued: 48 * 60 * 60 * 1000,      // 48 hours (waiting for approval)
  approved: 1 * 60 * 60 * 1000,     // 1 hour
  running: 4 * 60 * 60 * 1000,      // 4 hours (way past any timeout)
  retrying: 2 * 60 * 60 * 1000,     // 2 hours
};

/**
 * Find and handle stale tasks. Returns count of cleaned-up tasks.
 */
export async function cleanupStaleTasks() {
  let totalCleaned = 0;

  for (const [state, threshold] of Object.entries(STALE_THRESHOLDS)) {
    try {
      const cutoff = new Date(Date.now() - threshold).toISOString();

      const { rows: staleTasks } = await pool.query(
        `SELECT id, clickup_task_id, name, state, updated_at
         FROM tasks
         WHERE state = $1 AND updated_at < $2`,
        [state, cutoff]
      );

      if (staleTasks.length === 0) continue;

      for (const task of staleTasks) {
        const ageMs = Date.now() - new Date(task.updated_at).getTime();
        const ageHours = (ageMs / 3600000).toFixed(1);

        await pool.query(
          `UPDATE tasks SET state = 'failed', error_message = $2, completed_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND state = $3`,
          [task.id, `Stale task cleanup: stuck in '${state}' for ${ageHours}h`, state]
        );

        logger.warn({
          taskId: task.id,
          clickupTaskId: task.clickup_task_id,
          taskName: task.name,
          state,
          ageHours,
        }, "Stale task cleaned up");

        totalCleaned++;
      }

      if (staleTasks.length > 0) {
        try {
          await notifySlack({
            text: `🧹 *Stale Task Cleanup*: ${staleTasks.length} task(s) stuck in '${state}' for >${(threshold / 3600000).toFixed(0)}h have been auto-failed.`,
          });
        } catch (_) {}
      }
    } catch (err) {
      logger.error({ state, err: err.message }, "Stale task cleanup failed for state");
    }
  }

  if (totalCleaned > 0) {
    logger.info({ totalCleaned }, "Stale task cleanup complete");
  }

  return totalCleaned;
}

/**
 * Get stale task candidates without acting on them (for dashboard preview).
 */
export async function getStaleTasks() {
  const stale = [];

  for (const [state, threshold] of Object.entries(STALE_THRESHOLDS)) {
    try {
      const cutoff = new Date(Date.now() - threshold).toISOString();
      const { rows } = await pool.query(
        `SELECT id, clickup_task_id, name, state, updated_at
         FROM tasks
         WHERE state = $1 AND updated_at < $2`,
        [state, cutoff]
      );

      for (const task of rows) {
        const ageMs = Date.now() - new Date(task.updated_at).getTime();
        stale.push({
          ...task,
          ageHours: (ageMs / 3600000).toFixed(1),
          threshold: (threshold / 3600000).toFixed(0),
        });
      }
    } catch {
      // Skip
    }
  }

  return stale;
}

/**
 * Start a periodic cleanup interval.
 * @param {number} intervalMs - Default 30 minutes
 * @returns {NodeJS.Timeout} interval handle
 */
export function startCleanupSchedule(intervalMs = 30 * 60 * 1000) {
  logger.info({ intervalMs }, "Starting stale task cleanup schedule");

  // Run once on start
  cleanupStaleTasks().catch(err => {
    logger.warn({ err: err.message }, "Initial stale cleanup failed");
  });

  return setInterval(() => {
    cleanupStaleTasks().catch(err => {
      logger.warn({ err: err.message }, "Scheduled stale cleanup failed");
    });
  }, intervalMs);
}
