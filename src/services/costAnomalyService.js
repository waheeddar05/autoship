// src/services/costAnomalyService.js
// Cost anomaly detection: alerts when task costs exceed thresholds.
// Uses rolling average comparison and absolute limits.

import { pool } from "../db.js";
import { logger } from "../logger.js";
import { sendSlackText } from "../slack-notifier.js";

const DEFAULT_ABSOLUTE_LIMIT = parseFloat(process.env.COST_ABSOLUTE_LIMIT || "5.00");
const DEFAULT_MULTIPLIER = parseFloat(process.env.COST_ANOMALY_MULTIPLIER || "3.0");

/**
 * Check if a task's cost is anomalous and alert if so.
 *
 * @param {number} taskId
 * @param {string} taskName
 * @param {string} [repoFullName]
 * @returns {{ isAnomaly: boolean, reason: string, currentCost: number, avgCost: number }}
 */
export async function checkCostAnomaly(taskId, taskName, repoFullName) {
  try {
    // Get current task's total cost
    const { rows: costRows } = await pool.query(
      `SELECT COALESCE(SUM(estimated_cost), 0) as total_cost,
              COALESCE(SUM(total_tokens), 0) as total_tokens
       FROM task_costs WHERE task_id = $1`,
      [taskId]
    );
    const currentCost = parseFloat(costRows[0].total_cost);
    const currentTokens = parseInt(costRows[0].total_tokens, 10);

    // Get rolling average cost (last 30 tasks)
    const { rows: avgRows } = await pool.query(
      `SELECT AVG(task_total) as avg_cost, STDDEV(task_total) as stddev_cost
       FROM (
         SELECT tc.task_id, SUM(tc.estimated_cost) as task_total
         FROM task_costs tc
         JOIN tasks t ON t.id = tc.task_id
         WHERE t.state = 'success' AND tc.task_id != $1
         GROUP BY tc.task_id
         ORDER BY MAX(tc.created_at) DESC
         LIMIT 30
       ) recent_costs`,
      [taskId]
    );

    const avgCost = parseFloat(avgRows[0]?.avg_cost || 0);
    const stddevCost = parseFloat(avgRows[0]?.stddev_cost || 0);

    let isAnomaly = false;
    let reason = "";

    // Check 1: Absolute limit
    if (currentCost > DEFAULT_ABSOLUTE_LIMIT) {
      isAnomaly = true;
      reason = `Cost ($${currentCost.toFixed(2)}) exceeds absolute limit ($${DEFAULT_ABSOLUTE_LIMIT.toFixed(2)})`;
    }

    // Check 2: Rolling average multiplier
    if (avgCost > 0 && currentCost > avgCost * DEFAULT_MULTIPLIER) {
      isAnomaly = true;
      const multiplierReason = `Cost ($${currentCost.toFixed(2)}) is ${(currentCost / avgCost).toFixed(1)}x the average ($${avgCost.toFixed(2)})`;
      reason = reason ? `${reason}; ${multiplierReason}` : multiplierReason;
    }

    // Check 3: Statistical outlier (> 2 standard deviations)
    if (avgCost > 0 && stddevCost > 0 && currentCost > avgCost + 2 * stddevCost) {
      isAnomaly = true;
      reason = reason || `Cost is a statistical outlier (>2σ from mean)`;
    }

    if (isAnomaly) {
      logger.warn({ taskId, taskName, currentCost, avgCost, reason }, "Cost anomaly detected");

      // Record the anomaly
      await pool.query(
        `INSERT INTO cost_anomalies (task_id, task_name, current_cost, avg_cost, reason, total_tokens)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [taskId, taskName, currentCost, avgCost, reason, currentTokens]
      );

      // Alert via Slack
      try {
        await sendSlackText(
          `⚠️ *Cost Anomaly Detected*\nTask: ${taskName}\n${reason}\nTokens used: ${currentTokens.toLocaleString()}`,
          process.env.SLACK_ALERT_CHANNEL || process.env.SLACK_CHANNEL_ID
        );
      } catch (_) {}
    }

    return { isAnomaly, reason, currentCost, avgCost };
  } catch (err) {
    logger.warn({ taskId, err: err.message }, "Cost anomaly check failed");
    return { isAnomaly: false, reason: "", currentCost: 0, avgCost: 0 };
  }
}

/**
 * Get cost anomaly history for the dashboard.
 */
export async function getCostAnomalyHistory(limit = 20) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM cost_anomalies ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return rows;
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to get cost anomaly history");
    return [];
  }
}

/**
 * Get cost summary stats for monitoring.
 */
export async function getCostStats() {
  try {
    const { rows } = await pool.query(
      `SELECT
        COUNT(DISTINCT task_id) as tasks_tracked,
        SUM(estimated_cost) as total_cost,
        AVG(estimated_cost) as avg_step_cost,
        SUM(total_tokens) as total_tokens,
        (SELECT COUNT(*) FROM cost_anomalies WHERE created_at > NOW() - INTERVAL '7 days') as anomalies_7d
       FROM task_costs`
    );
    return rows[0] || {};
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to get cost stats");
    return {};
  }
}
