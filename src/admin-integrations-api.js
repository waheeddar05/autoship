// src/admin-integrations-api.js
// Admin-only API routes for managing user integrations.

import { Router } from "express";
import { pool } from "./db.js";
import { requireRole } from "./rbac.js";
import { logger } from "./logger.js";

const router = Router();

// All routes require ADMIN role
router.use("/api/admin/integrations", requireRole("ADMIN"));

/**
 * GET /api/admin/integrations/users
 * List all users with their integration connection status.
 */
router.get("/api/admin/integrations/users", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        u.id AS "userId",
        u.email,
        u.name,
        cu.provider_username AS clickup_username,
        cu.connected_at AS clickup_connected_at,
        gu.provider_username AS github_username,
        gu.connected_at AS github_connected_at
      FROM users u
      LEFT JOIN user_integrations cu ON cu.user_id = u.id AND cu.provider = 'clickup'
      LEFT JOIN user_integrations gu ON gu.user_id = u.id AND gu.provider = 'github'
      ORDER BY u.created_at ASC
    `);

    const users = rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      name: r.name,
      clickup: r.clickup_username
        ? { connected: true, username: r.clickup_username, connectedAt: r.clickup_connected_at }
        : { connected: false },
      github: r.github_username
        ? { connected: true, username: r.github_username, connectedAt: r.github_connected_at }
        : { connected: false },
    }));

    res.json({ users });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to list user integrations");
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/admin/integrations/revoke
 * Revoke a specific user's integration. Cannot revoke org_integrations via this route.
 */
router.delete("/api/admin/integrations/revoke", async (req, res) => {
  try {
    const { userId, provider } = req.body;

    if (!userId || !provider) {
      return res.status(400).json({ error: "userId and provider are required" });
    }

    if (!["clickup", "github"].includes(provider)) {
      return res.status(400).json({ error: "Invalid provider" });
    }

    const { rowCount } = await pool.query(
      "DELETE FROM user_integrations WHERE user_id = $1 AND provider = $2",
      [userId, provider]
    );

    // Clear clickup_user_id if revoking ClickUp
    if (provider === "clickup") {
      await pool.query("UPDATE users SET clickup_user_id = NULL WHERE id = $1", [userId]);
    }

    logger.info(
      { targetUserId: userId, provider, revokedBy: req.user.email, deleted: rowCount },
      "Admin revoked user integration"
    );

    res.json({ ok: true, deleted: rowCount });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to revoke user integration");
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/integrations/org
 * Get org-level integration status (admin's own connections).
 */
router.get("/api/admin/integrations/org", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT provider, provider_account_name, connected_at FROM org_integrations"
    );

    const org = {};
    for (const row of rows) {
      org[row.provider] = {
        connected: true,
        accountName: row.provider_account_name,
        connectedAt: row.connected_at,
      };
    }

    res.json({
      clickup: org.clickup || { connected: false },
      github: org.github || { connected: false },
    });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to get org integration status");
    res.status(500).json({ error: err.message });
  }
});

export { router as adminIntegrationsRouter };
