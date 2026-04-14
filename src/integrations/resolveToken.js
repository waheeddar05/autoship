// src/integrations/resolveToken.js
// Token resolution service: user token → org fallback → error.
// Handles automatic refresh for expired GitHub OAuth tokens.

import { pool } from "../db.js";
import { decrypt, encrypt } from "./encryption.js";
import { IntegrationNotConnectedError } from "./errors.js";
import { logger } from "../logger.js";

const GITHUB_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET;

// Refresh tokens 5 minutes before actual expiry to avoid race conditions
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Refresh a GitHub OAuth token using the stored refresh_token.
 * Updates the encrypted tokens in the given DB table row.
 *
 * @param {string} refreshTokenEncrypted - Encrypted refresh token from DB.
 * @param {string} table - 'user_integrations' or 'org_integrations'.
 * @param {object} whereClause - { column, value } for the WHERE condition.
 * @returns {Promise<string>} The new decrypted access token.
 * @throws {Error} If refresh fails.
 */
async function refreshGitHubToken(refreshTokenEncrypted, table, whereClause) {
  const refreshToken = decrypt(refreshTokenEncrypted);

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub token refresh HTTP ${res.status}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`GitHub token refresh error: ${data.error} — ${data.error_description || ""}`);
  }

  const newAccessToken = data.access_token;
  const newRefreshToken = data.refresh_token || refreshToken; // GitHub may rotate refresh tokens
  const newExpiresAt = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000).toISOString()
    : null;

  const encryptedAccess = encrypt(newAccessToken);
  const encryptedRefresh = encrypt(newRefreshToken);

  // Update the row in-place
  await pool.query(
    `UPDATE ${table}
     SET access_token = $1, refresh_token = $2, expires_at = $3::timestamptz
     WHERE ${whereClause.column} = $4 AND provider = 'github'`,
    [encryptedAccess, encryptedRefresh, newExpiresAt, whereClause.value]
  );

  logger.info(
    { table, expiresAt: newExpiresAt },
    "GitHub OAuth token refreshed successfully"
  );

  return newAccessToken;
}

/**
 * Check if a token row is expired (or about to expire).
 * Returns false if expires_at is null (non-expiring PAT-style token).
 */
function isExpiredOrSoon(expiresAt) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - EXPIRY_BUFFER_MS <= Date.now();
}

/**
 * Resolve the best available token for a user and provider.
 * Priority: user's own token → org-level admin token → error.
 * For GitHub: automatically refreshes expired tokens using the stored refresh_token.
 *
 * @param {string} userId - The user ID to resolve for.
 * @param {string} provider - Provider name ('clickup' or 'github').
 * @returns {Promise<{ token: string, source: 'user' | 'org_fallback' }>}
 * @throws {IntegrationNotConnectedError} If no token is available.
 */
export async function resolveToken(userId, provider) {
  // 1. Check user's own token
  const { rows: userRows } = await pool.query(
    "SELECT access_token, refresh_token, expires_at FROM user_integrations WHERE user_id = $1 AND provider = $2",
    [userId, provider]
  );

  if (userRows.length > 0) {
    const row = userRows[0];
    try {
      // If GitHub token is expired and we have a refresh token, refresh it
      if (provider === "github" && isExpiredOrSoon(row.expires_at) && row.refresh_token) {
        logger.info({ userId, provider, expiresAt: row.expires_at }, "User GitHub token expired, refreshing");
        const newToken = await refreshGitHubToken(
          row.refresh_token,
          "user_integrations",
          { column: "user_id", value: userId }
        );
        return { token: newToken, source: "user" };
      }

      const token = decrypt(row.access_token);
      return { token, source: "user" };
    } catch (err) {
      logger.error({ provider, userId, err: err.message }, "Failed to resolve/refresh user integration token");
      // Fall through to org fallback
    }
  }

  // 2. Fall back to org-level token
  const { rows: orgRows } = await pool.query(
    "SELECT access_token, refresh_token, expires_at FROM org_integrations WHERE provider = $1",
    [provider]
  );

  if (orgRows.length > 0) {
    const row = orgRows[0];
    try {
      // If GitHub token is expired and we have a refresh token, refresh it
      if (provider === "github" && isExpiredOrSoon(row.expires_at) && row.refresh_token) {
        logger.info({ provider, expiresAt: row.expires_at }, "Org GitHub token expired, refreshing");
        const newToken = await refreshGitHubToken(
          row.refresh_token,
          "org_integrations",
          { column: "provider", value: provider }
        );
        return { token: newToken, source: "org_fallback" };
      }

      const token = decrypt(row.access_token);
      return { token, source: "org_fallback" };
    } catch (err) {
      logger.error({ provider, err: err.message }, "Failed to resolve/refresh org integration token");
      throw new IntegrationNotConnectedError(provider, userId);
    }
  }

  // 3. No token available
  throw new IntegrationNotConnectedError(provider, userId);
}

/**
 * Get the org-level admin token for a provider directly.
 * Used by admin routes and webhook fallback when no user context exists.
 * For GitHub: automatically refreshes expired tokens.
 *
 * @param {string} provider - Provider name ('clickup' or 'github').
 * @returns {Promise<string>} The decrypted token.
 * @throws {IntegrationNotConnectedError} If no org token is configured.
 */
export async function getOrgAdminToken(provider) {
  const { rows } = await pool.query(
    "SELECT access_token, refresh_token, expires_at FROM org_integrations WHERE provider = $1",
    [provider]
  );

  if (rows.length === 0) {
    throw new IntegrationNotConnectedError(provider);
  }

  const row = rows[0];
  try {
    // If GitHub token is expired and we have a refresh token, refresh it
    if (provider === "github" && isExpiredOrSoon(row.expires_at) && row.refresh_token) {
      logger.info({ provider, expiresAt: row.expires_at }, "Org admin GitHub token expired, refreshing");
      return await refreshGitHubToken(
        row.refresh_token,
        "org_integrations",
        { column: "provider", value: provider }
      );
    }

    return decrypt(row.access_token);
  } catch (err) {
    logger.error({ provider, err: err.message }, "Failed to resolve/refresh org admin token");
    throw new IntegrationNotConnectedError(provider);
  }
}
