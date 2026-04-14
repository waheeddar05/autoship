// src/integrations-api.js
// OAuth integration routes for ClickUp and GitHub (per-user + org fallback).

import { Router } from "express";
import { pool } from "./db.js";
import { logger } from "./logger.js";
import { encrypt } from "./integrations/encryption.js";
import { generateState, consumeState } from "./integrations/oauthState.js";
import { resolveToken } from "./integrations/resolveToken.js";
import { invalidateAssigneeCache } from "./assignee-resolver.js";

const router = Router();

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";

// ── ClickUp OAuth ──────────────────────────────────────────────

const CLICKUP_CLIENT_ID = process.env.CLICKUP_CLIENT_ID;
const CLICKUP_CLIENT_SECRET = process.env.CLICKUP_CLIENT_SECRET;
const CLICKUP_REDIRECT_URI = process.env.CLICKUP_REDIRECT_URI || `${process.env.BASE_URL || "http://localhost:3457"}/api/integrations/clickup/callback`;

/**
 * GET /api/integrations/clickup/connect
 * Initiate ClickUp OAuth flow — redirects user to ClickUp consent screen.
 */
router.get("/api/integrations/clickup/connect", async (req, res) => {
  try {
    if (!CLICKUP_CLIENT_ID) {
      return res.status(500).json({ error: "ClickUp OAuth not configured" });
    }

    const state = await generateState(req.user.id, "clickup");
    const url = `https://app.clickup.com/api?client_id=${CLICKUP_CLIENT_ID}&redirect_uri=${encodeURIComponent(CLICKUP_REDIRECT_URI)}&state=${state}`;
    res.redirect(url);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to initiate ClickUp OAuth");
    res.redirect("/?page=integrations&error=clickup_connect_failed");
  }
});

/**
 * GET /api/integrations/clickup/callback
 * ClickUp OAuth callback — exchanges code for token, stores encrypted.
 */
router.get("/api/integrations/clickup/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.redirect("/?page=integrations&error=missing_params");
    }

    // Validate state
    const { userId } = await consumeState(state);

    // Exchange code for token
    const tokenRes = await fetch("https://api.clickup.com/api/v2/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLICKUP_CLIENT_ID,
        client_secret: CLICKUP_CLIENT_SECRET,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      logger.error({ status: tokenRes.status, body }, "ClickUp token exchange failed");
      return res.redirect("/?page=integrations&error=clickup_token_failed");
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Fetch ClickUp user info
    const userRes = await fetch("https://api.clickup.com/api/v2/user", {
      headers: { Authorization: accessToken },
    });

    let clickupUser = {};
    if (userRes.ok) {
      const userData = await userRes.json();
      clickupUser = userData.user || {};
    }

    const encryptedToken = encrypt(accessToken);
    const clickupUserId = String(clickupUser.id || "");
    const clickupUsername = clickupUser.username || clickupUser.email || "";

    // Look up session user to check admin status
    const { rows: userRows } = await pool.query("SELECT email FROM users WHERE id = $1", [userId]);
    const isOrgAdmin = userRows[0]?.email === ADMIN_EMAIL;

    // If org admin, upsert into org_integrations
    if (isOrgAdmin) {
      await pool.query(
        `INSERT INTO org_integrations (provider, access_token, provider_user_id, provider_account_name, connected_by, connected_at)
         VALUES ('clickup', $1, $2, $3, $4, NOW())
         ON CONFLICT (provider) DO UPDATE SET
           access_token = EXCLUDED.access_token,
           provider_user_id = EXCLUDED.provider_user_id,
           provider_account_name = EXCLUDED.provider_account_name,
           connected_by = EXCLUDED.connected_by,
           connected_at = NOW()`,
        [encryptedToken, clickupUserId, clickupUsername, userId]
      );
      logger.info({ userId }, "Org ClickUp integration updated by admin");
    }

    // Always upsert into user_integrations
    await pool.query(
      `INSERT INTO user_integrations (user_id, provider, access_token, provider_user_id, provider_username, connected_at)
       VALUES ($1, 'clickup', $2, $3, $4, NOW())
       ON CONFLICT (user_id, provider) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         provider_user_id = EXCLUDED.provider_user_id,
         provider_username = EXCLUDED.provider_username,
         connected_at = NOW()`,
      [userId, encryptedToken, clickupUserId, clickupUsername]
    );

    // Update users.clickup_user_id for webhook assignee mapping
    if (clickupUserId) {
      await pool.query(
        "UPDATE users SET clickup_user_id = $1 WHERE id = $2",
        [clickupUserId, userId]
      );
    }

    // Bust the assignee cache so this user is immediately eligible for task triggers
    invalidateAssigneeCache();

    logger.info({ userId, clickupUserId }, "ClickUp integration connected");
    res.redirect("/?page=integrations&clickup=connected");
  } catch (err) {
    logger.error({ err: err.message }, "ClickUp OAuth callback failed");
    res.redirect("/?page=integrations&error=clickup_callback_failed");
  }
});

/**
 * DELETE /api/integrations/clickup/disconnect
 * Remove user's ClickUp integration. Admin also removes org-level.
 */
router.delete("/api/integrations/clickup/disconnect", async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM user_integrations WHERE user_id = $1 AND provider = 'clickup'",
      [req.user.id]
    );

    // Clear clickup_user_id
    await pool.query("UPDATE users SET clickup_user_id = NULL WHERE id = $1", [req.user.id]);

    // If admin, also remove org-level
    if (req.user.email === ADMIN_EMAIL) {
      await pool.query("DELETE FROM org_integrations WHERE provider = 'clickup'");
      logger.info({ userId: req.user.id }, "Org ClickUp integration removed by admin");
    }

    logger.info({ userId: req.user.id }, "ClickUp integration disconnected");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to disconnect ClickUp");
    res.status(500).json({ error: "Failed to disconnect ClickUp" });
  }
});

/**
 * GET /api/integrations/clickup/status
 * Return connection status for current user.
 */
router.get("/api/integrations/clickup/status", async (req, res) => {
  try {
    // Check user's own connection
    const { rows: userRows } = await pool.query(
      "SELECT provider_username, connected_at FROM user_integrations WHERE user_id = $1 AND provider = 'clickup'",
      [req.user.id]
    );

    if (userRows.length > 0) {
      return res.json({
        connected: true,
        username: userRows[0].provider_username,
        connectedAt: userRows[0].connected_at,
        source: "user",
      });
    }

    // Check org fallback
    const { rows: orgRows } = await pool.query(
      "SELECT provider_account_name FROM org_integrations WHERE provider = 'clickup'"
    );

    if (orgRows.length > 0) {
      return res.json({
        connected: false,
        username: orgRows[0].provider_account_name,
        source: "org_fallback",
      });
    }

    res.json({ connected: false, username: null, source: null });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to get ClickUp status");
    res.status(500).json({ error: "Failed to get integration status" });
  }
});

// ── GitHub OAuth ───────────────────────────────────────────────

const GITHUB_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET;
const GITHUB_REDIRECT_URI = process.env.GITHUB_REDIRECT_URI || `${process.env.BASE_URL || "http://localhost:3457"}/api/integrations/github/callback`;

/**
 * GET /api/integrations/github/connect
 * Initiate GitHub OAuth flow.
 */
router.get("/api/integrations/github/connect", async (req, res) => {
  try {
    if (!GITHUB_CLIENT_ID) {
      return res.status(500).json({ error: "GitHub OAuth not configured" });
    }

    const state = await generateState(req.user.id, "github");
    const url = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&scope=repo,read:user,workflow&state=${state}`;
    res.redirect(url);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to initiate GitHub OAuth");
    res.redirect("/?page=integrations&error=github_connect_failed");
  }
});

/**
 * GET /api/integrations/github/callback
 * GitHub OAuth callback — exchanges code for token, stores encrypted.
 */
router.get("/api/integrations/github/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.redirect("/?page=integrations&error=missing_params");
    }

    const { userId } = await consumeState(state);

    // Exchange code for token
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      logger.error({ status: tokenRes.status, body }, "GitHub token exchange failed");
      return res.redirect("/?page=integrations&error=github_token_failed");
    }

    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      logger.error({ error: tokenData.error }, "GitHub OAuth error");
      return res.redirect("/?page=integrations&error=github_token_failed");
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;
    // GitHub returns expires_in (seconds) for expiring tokens
    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : null;

    // Fetch GitHub user info
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    let githubUser = {};
    if (userRes.ok) {
      githubUser = await userRes.json();
    }

    const encryptedToken = encrypt(accessToken);
    const githubUserId = String(githubUser.id || "");
    const githubUsername = githubUser.login || "";

    // Look up session user
    const { rows: userRows } = await pool.query("SELECT email FROM users WHERE id = $1", [userId]);
    const isOrgAdmin = userRows[0]?.email === ADMIN_EMAIL;

    const encryptedRefresh = refreshToken ? encrypt(refreshToken) : null;

    // If org admin, upsert into org_integrations
    if (isOrgAdmin) {
      await pool.query(
        `INSERT INTO org_integrations (provider, access_token, refresh_token, provider_user_id, provider_account_name, scopes, connected_by, connected_at, expires_at)
         VALUES ('github', $1, $2, $3, $4, 'repo,read:user,workflow', $5, NOW(), $6::timestamptz)
         ON CONFLICT (provider) DO UPDATE SET
           access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           provider_user_id = EXCLUDED.provider_user_id,
           provider_account_name = EXCLUDED.provider_account_name,
           scopes = EXCLUDED.scopes,
           connected_by = EXCLUDED.connected_by,
           connected_at = NOW(),
           expires_at = EXCLUDED.expires_at`,
        [encryptedToken, encryptedRefresh, githubUserId, githubUsername, userId, expiresAt]
      );
      logger.info({ userId, expiresAt }, "Org GitHub integration updated by admin");
    }

    // Always upsert into user_integrations
    await pool.query(
      `INSERT INTO user_integrations (user_id, provider, access_token, refresh_token, provider_user_id, provider_username, scopes, connected_at, expires_at)
       VALUES ($1, 'github', $2, $3, $4, $5, 'repo,read:user,workflow', NOW(), $6::timestamptz)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         provider_user_id = EXCLUDED.provider_user_id,
         provider_username = EXCLUDED.provider_username,
         scopes = EXCLUDED.scopes,
         connected_at = NOW(),
         expires_at = EXCLUDED.expires_at`,
      [userId, encryptedToken, encryptedRefresh, githubUserId, githubUsername, expiresAt]
    );

    logger.info({ userId, githubUsername }, "GitHub integration connected");
    res.redirect("/?page=integrations&github=connected");
  } catch (err) {
    logger.error({ err: err.message }, "GitHub OAuth callback failed");
    res.redirect("/?page=integrations&error=github_callback_failed");
  }
});

/**
 * DELETE /api/integrations/github/disconnect
 * Remove user's GitHub integration. Admin also removes org-level.
 */
router.delete("/api/integrations/github/disconnect", async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM user_integrations WHERE user_id = $1 AND provider = 'github'",
      [req.user.id]
    );

    if (req.user.email === ADMIN_EMAIL) {
      await pool.query("DELETE FROM org_integrations WHERE provider = 'github'");
      logger.info({ userId: req.user.id }, "Org GitHub integration removed by admin");
    }

    logger.info({ userId: req.user.id }, "GitHub integration disconnected");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to disconnect GitHub");
    res.status(500).json({ error: "Failed to disconnect GitHub" });
  }
});

/**
 * GET /api/integrations/github/status
 * Return connection status for current user.
 */
router.get("/api/integrations/github/status", async (req, res) => {
  try {
    const { rows: userRows } = await pool.query(
      "SELECT provider_username, connected_at FROM user_integrations WHERE user_id = $1 AND provider = 'github'",
      [req.user.id]
    );

    if (userRows.length > 0) {
      return res.json({
        connected: true,
        username: userRows[0].provider_username,
        connectedAt: userRows[0].connected_at,
        source: "user",
      });
    }

    const { rows: orgRows } = await pool.query(
      "SELECT provider_account_name FROM org_integrations WHERE provider = 'github'"
    );

    if (orgRows.length > 0) {
      return res.json({
        connected: false,
        username: orgRows[0].provider_account_name,
        source: "org_fallback",
      });
    }

    res.json({ connected: false, username: null, source: null });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to get GitHub status");
    res.status(500).json({ error: "Failed to get integration status" });
  }
});

export { router as integrationsRouter };
