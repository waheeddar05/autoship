// src/services/checkpointService.js
// Execution checkpointing: saves intermediate state so tasks can resume
// after crashes or timeouts instead of starting from scratch.

import { pool } from "../db.js";
import { logger } from "../logger.js";

/**
 * Save a checkpoint for a running task.
 *
 * @param {number} taskId
 * @param {string} step - Current step name (e.g., "debate_round_2", "coding", "testing")
 * @param {object} state - Serializable state to save
 */
export async function saveCheckpoint(taskId, step, state) {
  try {
    await pool.query(
      `INSERT INTO task_checkpoints (task_id, step, state)
       VALUES ($1, $2, $3)
       ON CONFLICT (task_id, step) DO UPDATE SET state = $3, updated_at = NOW()`,
      [taskId, step, JSON.stringify(state)]
    );
    logger.debug({ taskId, step }, "Checkpoint saved");
  } catch (err) {
    logger.warn({ taskId, step, err: err.message }, "Failed to save checkpoint");
  }
}

/**
 * Retrieve the latest checkpoint for a task.
 */
export async function getLatestCheckpoint(taskId) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM task_checkpoints
       WHERE task_id = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [taskId]
    );
    if (rows.length === 0) return null;

    const cp = rows[0];
    return {
      step: cp.step,
      state: typeof cp.state === "string" ? JSON.parse(cp.state) : cp.state,
      savedAt: cp.updated_at,
    };
  } catch (err) {
    logger.warn({ taskId, err: err.message }, "Failed to get checkpoint");
    return null;
  }
}

/**
 * Get a specific checkpoint by step name.
 */
export async function getCheckpoint(taskId, step) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM task_checkpoints WHERE task_id = $1 AND step = $2`,
      [taskId, step]
    );
    if (rows.length === 0) return null;

    return {
      step: rows[0].step,
      state: typeof rows[0].state === "string" ? JSON.parse(rows[0].state) : rows[0].state,
      savedAt: rows[0].updated_at,
    };
  } catch (err) {
    logger.warn({ taskId, step, err: err.message }, "Failed to get checkpoint");
    return null;
  }
}

/**
 * Clear all checkpoints for a task (after successful completion).
 */
export async function clearCheckpoints(taskId) {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM task_checkpoints WHERE task_id = $1`,
      [taskId]
    );
    if (rowCount > 0) {
      logger.debug({ taskId, cleared: rowCount }, "Checkpoints cleared");
    }
  } catch (err) {
    logger.warn({ taskId, err: err.message }, "Failed to clear checkpoints");
  }
}

/**
 * Check if a task has any checkpoints (for resume decision).
 */
export async function hasCheckpoint(taskId) {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) as count FROM task_checkpoints WHERE task_id = $1`,
      [taskId]
    );
    return parseInt(rows[0].count, 10) > 0;
  } catch {
    return false;
  }
}

/**
 * Get all checkpoints for a task (for debugging/dashboard).
 */
export async function getAllCheckpoints(taskId) {
  try {
    const { rows } = await pool.query(
      `SELECT step, state, created_at, updated_at FROM task_checkpoints
       WHERE task_id = $1 ORDER BY created_at ASC`,
      [taskId]
    );
    return rows.map(r => ({
      step: r.step,
      state: typeof r.state === "string" ? JSON.parse(r.state) : r.state,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  } catch (err) {
    logger.warn({ taskId, err: err.message }, "Failed to get all checkpoints");
    return [];
  }
}
