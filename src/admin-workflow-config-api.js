// src/admin-workflow-config-api.js
// CRUD routes for admin workflow configuration.

import { Router } from "express";
import { pool } from "./db.js";
import { requireRole } from "./rbac.js";
import { logger } from "./logger.js";

const router = Router();

// PUT requires ADMIN role; GET is open to all authenticated users
router.put("/api/admin/workflow-config", requireRole("ADMIN"));

// GET — read current config (all authenticated users can view)
router.get("/api/admin/workflow-config", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM admin_workflow_config WHERE id = 1");
    if (!rows[0]) {
      // Seed row if missing
      await pool.query("INSERT INTO admin_workflow_config (id) VALUES (1) ON CONFLICT DO NOTHING");
      const { rows: seeded } = await pool.query("SELECT * FROM admin_workflow_config WHERE id = 1");
      return res.json({ config: formatConfig(seeded[0]) });
    }
    res.json({ config: formatConfig(rows[0]) });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to get workflow config");
    res.status(500).json({ error: err.message });
  }
});

// PUT — update config
router.put("/api/admin/workflow-config", async (req, res) => {
  try {
    const allowed = [
      "quality_check_reject_flow",
      "quality_check_approve_flow",
      "quality_score_threshold",
      "reject_status",
      "approve_status",
      "pr_raised_status",
      "approval_keywords",
      "needs_revision_tag",
      "require_repo_field",
      "debate_complexity_threshold",
    ];

    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    // Validate types
    if (updates.quality_score_threshold !== undefined) {
      const t = Number(updates.quality_score_threshold);
      if (isNaN(t) || t < 0 || t > 100) {
        return res.status(400).json({ error: "quality_score_threshold must be 0-100" });
      }
      updates.quality_score_threshold = t;
    }

    if (updates.approval_keywords !== undefined) {
      if (!Array.isArray(updates.approval_keywords)) {
        return res.status(400).json({ error: "approval_keywords must be an array of strings" });
      }
      updates.approval_keywords = JSON.stringify(updates.approval_keywords);
    }

    if (updates.require_repo_field !== undefined) {
      updates.require_repo_field = !!updates.require_repo_field;
    }

    if (updates.debate_complexity_threshold !== undefined) {
      const validLevels = ["simple", "medium", "complex", "critical", "disabled"];
      if (!validLevels.includes(updates.debate_complexity_threshold)) {
        return res.status(400).json({ error: "debate_complexity_threshold must be one of: " + validLevels.join(", ") });
      }
    }

    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
      setClauses.push(`${key} = $${idx}`);
      values.push(value);
      idx++;
    }

    setClauses.push("updated_at = NOW()");

    const { rows } = await pool.query(
      `UPDATE admin_workflow_config SET ${setClauses.join(", ")} WHERE id = 1 RETURNING *`,
      values
    );

    logger.info({ changedBy: req.user?.email, fields: Object.keys(updates) }, "Workflow config updated");
    res.json({ ok: true, config: formatConfig(rows[0]) });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to update workflow config");
    res.status(500).json({ error: err.message });
  }
});

function formatConfig(row) {
  if (!row) return null;
  return {
    quality_check_reject_flow: row.quality_check_reject_flow,
    quality_check_approve_flow: row.quality_check_approve_flow,
    quality_score_threshold: row.quality_score_threshold,
    reject_status: row.reject_status,
    approve_status: row.approve_status,
    pr_raised_status: row.pr_raised_status,
    approval_keywords: typeof row.approval_keywords === "string"
      ? JSON.parse(row.approval_keywords)
      : row.approval_keywords,
    needs_revision_tag: row.needs_revision_tag,
    require_repo_field: row.require_repo_field,
    debate_complexity_threshold: row.debate_complexity_threshold || "complex",
    updated_at: row.updated_at,
  };
}

export { router as workflowConfigRouter };
