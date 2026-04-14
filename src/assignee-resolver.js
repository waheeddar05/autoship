// src/assignee-resolver.js
// Dynamic assignee resolution: pulls eligible ClickUp user IDs from the
// users table (any user who has connected their ClickUp integration).
// Falls back to static config / env var for backward compatibility.

import { pool } from "./db.js";
import { config } from "./config-manager.js";
import { logger } from "./logger.js";

const MY_USER_ID = process.env.CLICKUP_MY_USER_ID || "";

// Cache connected user IDs for a short TTL to avoid hitting DB on every webhook
let cachedIds = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute

/**
 * Fetch ClickUp user IDs for all users who have connected their ClickUp integration.
 * Results are cached for CACHE_TTL_MS to avoid DB churn on rapid webhook bursts.
 *
 * @returns {Promise<string[]>} Array of ClickUp user IDs.
 */
async function getConnectedClickUpUserIds() {
  if (cachedIds && Date.now() < cacheExpiresAt) {
    return cachedIds;
  }

  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.clickup_user_id
       FROM users u
       JOIN user_integrations ui ON ui.user_id = u.id AND ui.provider = 'clickup'
       WHERE u.clickup_user_id IS NOT NULL AND u.clickup_user_id != ''`
    );

    const ids = rows.map((r) => String(r.clickup_user_id));
    if (ids.length > 0) {
      cachedIds = ids;
      cacheExpiresAt = Date.now() + CACHE_TTL_MS;
      logger.debug({ count: ids.length, ids }, "Resolved connected ClickUp user IDs from DB");
      return ids;
    }
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to query connected ClickUp users, falling back to static config");
  }

  // DB returned nothing or errored — fall through to static config
  return null;
}

/**
 * Get the list of ClickUp user IDs that Autoship should trigger on.
 *
 * Resolution order:
 *   1. Static config: CLICKUP_ASSIGNEE_IDS (if explicitly set, always wins — allows manual override)
 *   2. Dynamic: All users who have connected ClickUp via OAuth
 *   3. Fallback: CLICKUP_MY_USER_ID env var (original single-admin behavior)
 *
 * @returns {Promise<string[]>}
 */
export async function getAssigneeIds() {
  // 1. Explicit static override — if set, respect it (operator knows best)
  const configured = config.getList("clickupAssigneeIds");
  if (configured.length > 0) {
    return configured;
  }

  // 2. Dynamic — any user who connected ClickUp
  const dynamicIds = await getConnectedClickUpUserIds();
  if (dynamicIds && dynamicIds.length > 0) {
    return dynamicIds;
  }

  // 3. Legacy fallback
  return [MY_USER_ID];
}

/**
 * Invalidate the cache (e.g. after a new user connects their ClickUp integration).
 */
export function invalidateAssigneeCache() {
  cachedIds = null;
  cacheExpiresAt = 0;
}
