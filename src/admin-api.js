// src/admin-api.js
// Admin-only API routes for user management.

import { Router } from "express";
import { pool } from "./db.js";
import { requireRole, isValidRole } from "./rbac.js";
import { logger } from "./logger.js";

const router = Router();

// All admin routes require ADMIN role
router.use("/api/admin", requireRole("ADMIN"));

// List all users
router.get("/api/admin/users", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, email, name, image, role, created_at, last_active_at FROM users ORDER BY created_at ASC"
    );
    res.json({ users: rows });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to list users");
    res.status(500).json({ error: err.message });
  }
});

// Update a user's role
router.patch("/api/admin/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!role || !isValidRole(role)) {
      return res.status(400).json({
        error: `Invalid role. Must be one of: ADMIN, DEVELOPER, READ_ONLY`,
      });
    }

    // Prevent admin from demoting themselves (lockout protection)
    if (String(id) === String(req.user.id) && role !== "ADMIN") {
      return res.status(400).json({
        error: "Cannot change your own role. Another admin must do this.",
      });
    }

    const { rows } = await pool.query(
      "UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, name, role",
      [role, id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: "User not found" });
    }

    logger.info({ targetUser: rows[0].email, newRole: role, changedBy: req.user.email }, "User role updated");
    res.json({ ok: true, user: rows[0] });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to update user role");
    res.status(500).json({ error: err.message });
  }
});

export { router as adminRouter };
