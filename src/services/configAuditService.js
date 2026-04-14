// src/services/configAuditService.js
// Config audit logging: tracks who changed what settings and when.
// Provides a trail for debugging configuration-related issues.

import { pool } from "../db.js";
import { logger } from "../logger.js";

/**
 * Record a configuration change.
 *
 * @param {object} params
 * @param {string} params.userId - Who made the change (user ID or email)
 * @param {string} params.source - Where the change came from ("dashboard", "api", "startup")
 * @param {string} params.key - Config key that changed
 * @param {*} params.oldValue - Previous value
 * @param {*} params.newValue - New value
 */
export async function recordConfigChange({ userId, source, key, oldValue, newValue }) {
  try {
    await pool.query(
      `INSERT INTO config_audit_log (user_id, source, config_key, old_value, new_value)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId || "system",
        source || "unknown",
        key,
        JSON.stringify(oldValue),
        JSON.stringify(newValue),
      ]
    );
    logger.info({ userId, source, key }, "Config change recorded");
  } catch (err) {
    logger.warn({ key, err: err.message }, "Failed to record config change");
  }
}

/**
 * Record a batch of config changes (e.g., from a settings form submission).
 */
export async function recordBatchConfigChanges({ userId, source, changes }) {
  for (const change of changes) {
    if (JSON.stringify(change.oldValue) !== JSON.stringify(change.newValue)) {
      await recordConfigChange({
        userId,
        source,
        key: change.key,
        oldValue: change.oldValue,
        newValue: change.newValue,
      });
    }
  }
}

/**
 * Get recent config changes for the dashboard.
 */
export async function getConfigAuditLog(limit = 50) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM config_audit_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return rows.map(r => ({
      ...r,
      old_value: typeof r.old_value === "string" ? JSON.parse(r.old_value) : r.old_value,
      new_value: typeof r.new_value === "string" ? JSON.parse(r.new_value) : r.new_value,
    }));
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to get config audit log");
    return [];
  }
}

/**
 * Get changes for a specific config key.
 */
export async function getConfigKeyHistory(key, limit = 20) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM config_audit_log WHERE config_key = $1 ORDER BY created_at DESC LIMIT $2`,
      [key, limit]
    );
    return rows;
  } catch (err) {
    logger.warn({ key, err: err.message }, "Failed to get config key history");
    return [];
  }
}