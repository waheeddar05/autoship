// src/integrations/oauthState.js
// Short-lived OAuth state token management for CSRF protection.
// Uses the oauth_states DB table instead of Redis.

import crypto from "node:crypto";
import { pool } from "../db.js";
import { logger } from "../logger.js";

const STATE_TTL_MINUTES = 10;

/**
 * Generate a cryptographically random OAuth state token and persist it.
 * @param {string} userId - The user initiating the OAuth flow.
 * @param {string} provider - Provider name ('clickup' or 'github').
 * @returns {Promise<string>} The generated state string.
 */
export async function generateState(userId, provider) {
  const state = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + STATE_TTL_MINUTES * 60 * 1000);

  await pool.query(
    `INSERT INTO oauth_states (state, user_id, provider, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [state, userId, provider, expiresAt.toISOString()]
  );

  logger.debug({ provider, userId }, "OAuth state generated");
  return state;
}

/**
 * Validate and consume an OAuth state token. Deletes the token on success
 * and cleans up any expired states.
 * @param {string} state - The state string from the OAuth callback.
 * @returns {Promise<{ userId: string, provider: string }>}
 * @throws {Error} If state is missing, expired, or invalid.
 */
export async function consumeState(state) {
  if (!state) {
    throw new Error("Missing OAuth state parameter");
  }

  // Clean up expired states opportunistically
  await pool.query("DELETE FROM oauth_states WHERE expires_at < NOW()").catch(() => {});

  const { rows } = await pool.query(
    `DELETE FROM oauth_states
     WHERE state = $1 AND expires_at > NOW()
     RETURNING user_id, provider`,
    [state]
  );

  if (rows.length === 0) {
    throw new Error("Invalid or expired OAuth state");
  }

  logger.debug({ provider: rows[0].provider }, "OAuth state consumed");
  return { userId: rows[0].user_id, provider: rows[0].provider };
}
