// src/dashboard-api.js
// Dashboard REST API routes, SSE stream, and task queue management endpoints.

import { Router } from "express";
import { metrics } from "./metrics.js";
import { config } from "./config-manager.js";
import { logger } from "./logger.js";
import {
  getTasksByState, getTaskById, getQueueCounts, getRecentTasks,
  approveTask, rejectTask, retryTask, requestUpdate, deleteTask, cancelTask, requestUpdateOnFailed,
  addTaskMessage, getTaskMessages,
  getExecutionLogs, getExecutableTasks,
  getPendingPrReviews,
  getTaskCostSummary, getAverageCosts, getSteps,
} from "./task-queue.js";
import { execute, executePrReview, getActiveSessions, cancelExecution } from "./execution-engine.js";
import { createDebateSession, getDebateSessionByTaskId } from "./task-queue.js";
import { DebateOrchestrator } from "./debate/debate-orchestrator.js";
import { providerRegistry } from "./providers/provider-registry.js";
import { requireRole } from "./rbac.js";
import { pool } from "./db.js";
import { scoreComplexity } from "./complexity.js";
import { recordConfigChange, getConfigAuditLog, getConfigKeyHistory } from "./services/configAuditService.js";
import { getStaleTasks } from "./services/staleTaskCleanupService.js";
import { getCostAnomalyHistory, getCostStats } from "./services/costAnomalyService.js";
import { getPromptEvolutionSummary, getPromptVariantStats, getBestPromptVariant } from "./services/promptEvolutionService.js";
import { getSubtaskProgress } from "./services/taskDecompositionService.js";
import { getMultiPrStatus, getNextPrToExecute } from "./services/multiPrOrchestrationService.js";
import { getFailurePareto, getRecentFailures } from "./services/failureAnalysisService.js";

const router = Router();

// ── SSE: Real-time event stream ──────────────────────────────────
const sseClients = new Set();

router.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  res.write("data: {\"type\":\"connected\"}\n\n");

  const client = { res };
  sseClients.add(client);
  req.on("close", () => sseClients.delete(client));
});

// Forward metrics events to all SSE clients
metrics.on("event", (event) => {
  const data = JSON.stringify(event);
  for (const client of sseClients) {
    try {
      client.res.write(`data: ${data}\n\n`);
    } catch (_) {
      sseClients.delete(client);
    }
  }
});

function broadcastSSE(event) {
  const data = JSON.stringify(event);
  for (const client of sseClients) {
    try { client.res.write(`data: ${data}\n\n`); } catch (_) { sseClients.delete(client); }
  }
}

// ── Dashboard snapshot ───────────────────────────────────────────
router.get("/api/dashboard", async (_req, res) => {
  try {
    const snapshot = metrics.getSnapshot();
    const configAll = config.getAll();
    const queueCounts = await getQueueCounts();

    res.json({
      ...snapshot,
      config: configAll,
      queueCounts,
      server: {
        port: process.env.PORT || 3457,
        mode: config.get("mode"),
        executionMode: config.get("executionMode"),
        nodeEnv: process.env.NODE_ENV || "development",
        pid: process.pid,
        memoryUsage: process.memoryUsage(),
      },
      integrations: {
        clickup: {
          configured: !!process.env.CLICKUP_API_TOKEN,
          workspaceId: config.get("clickupWorkspaceId"),
          webhookSecret: process.env.CLICKUP_WEBHOOK_SECRET ? "configured" : "not set",
        },
        github: {
          configured: !!process.env.GITHUB_TOKEN,
          org: config.get("githubOrg"),
          webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ? "configured" : "not set",
        },
        claude: {
          model: config.get("claudeModel"),
          timeout: config.get("claudeTimeout"),
          path: process.env.CLAUDE_CODE_PATH || "claude",
        },
        debate: {
          enabled: config.get("debateEnabled"),
          style: config.get("debateStyle"),
          leaderModel: config.get("debateLeaderModel"),
          participantCount: (config.getJSON("debateParticipants") || []).length,
          maxRounds: config.get("debateMaxRounds"),
          executionModel: config.get("executionModel"),
          executionModelMode: config.get("executionModelMode"),
        },
        providers: providerRegistry.getConfiguredProviders(),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Logs ─────────────────────────────────────────────────────────
router.get("/api/logs", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);
  res.json(metrics.getRecentLogs(limit));
});

// ── Config CRUD ──────────────────────────────────────────────────
router.get("/api/config", (req, res) => {
  const grouped = config.getAllGrouped();
  const adminOnlyGroups = ["analytics"];

  // Non-admin users can't see cost/analytics config
  if (req.user?.role !== "ADMIN") {
    for (const group of adminOnlyGroups) {
      delete grouped[group];
    }
  }

  res.json(grouped);
});

router.put("/api/config/:key", requireRole("ADMIN"), (req, res) => {
  const { key } = req.params;
  const { value } = req.body;

  try {
    const oldValue = config.get(key);
    config.set(key, value);
    logger.info({ key, value }, "Config updated via dashboard");

    recordConfigChange({
      userId: req.user?.email || req.user?.id,
      source: "dashboard",
      key,
      oldValue,
      newValue: value,
    }).catch(() => {});

    broadcastSSE({ type: "config:changed", data: { key, value }, ts: new Date().toISOString() });
    res.json({ ok: true, key, value });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/api/config/:key", requireRole("ADMIN"), (req, res) => {
  const { key } = req.params;
  try {
    const oldValue = config.get(key);
    config.reset(key);

    recordConfigChange({
      userId: req.user?.email || req.user?.id,
      source: "dashboard",
      key,
      oldValue,
      newValue: config.get(key),
    }).catch(() => {});

    res.json({ ok: true, key, reverted: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Config audit trail (ADMIN) ───────────────────────────────────
router.get("/api/config-audit", requireRole("ADMIN"), async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
  res.json(await getConfigAuditLog(limit));
});

router.get("/api/config-audit/:key", requireRole("ADMIN"), async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
  res.json(await getConfigKeyHistory(req.params.key, limit));
});

// ── Operational health: stale tasks + cost anomalies ────────────
router.get("/api/stale-tasks", async (_req, res) => {
  res.json(await getStaleTasks());
});

router.get("/api/cost-anomalies", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
  res.json(await getCostAnomalyHistory(limit));
});

router.get("/api/cost-stats", async (_req, res) => {
  res.json(await getCostStats());
});

// ── Failure post-mortems ─────────────────────────────────────────
router.get("/api/failure-causes", async (req, res) => {
  const days = parseInt(req.query.days || "30", 10);
  const pareto = await getFailurePareto(days);
  const recent = await getRecentFailures(parseInt(req.query.limit || "20", 10));
  res.json({ ...pareto, recent });
});

// ── Decomposition + multi-PR progress ────────────────────────────
router.get("/api/tasks/:id/subtasks", async (req, res) => {
  res.json(await getSubtaskProgress(parseInt(req.params.id, 10)));
});

router.get("/api/tasks/:id/multi-pr", async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const status = await getMultiPrStatus(taskId);
  const next = await getNextPrToExecute(taskId);
  res.json({ ...status, next });
});

// ── Prompt evolution: variant performance ────────────────────────
router.get("/api/prompt-evolution", async (req, res) => {
  const summary = await getPromptEvolutionSummary();
  const promptType = req.query.type || "execution";
  const stats = await getPromptVariantStats(promptType, req.query.repo || null);
  const best = await getBestPromptVariant(promptType, req.query.repo || null);
  res.json({ summary, stats, best });
});

// ── Task Queue Management ────────────────────────────────────────

// List tasks by state
router.get("/api/queue", async (req, res) => {
  try {
    const state = req.query.state || "all";
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const offset = parseInt(req.query.offset || "0", 10);

    const tasks = await getTasksByState(state, { limit, offset });
    const counts = await getQueueCounts();

    const { pool } = await import("./db.js");
    let totalQuery;
    if (state === "all") {
      totalQuery = await pool.query("SELECT COUNT(*)::int as total FROM tasks");
    } else {
      totalQuery = await pool.query("SELECT COUNT(*)::int as total FROM tasks WHERE state = $1", [state]);
    }

    // Attach multi-repo PR info to each task
    const taskIds = tasks.filter((t) => t.id).map((t) => t.id);
    if (taskIds.length > 0) {
      const { rows: allPrs } = await pool.query(
        "SELECT task_id, pr_url, merged FROM pr_outcomes WHERE task_id = ANY($1) ORDER BY id",
        [taskIds]
      );
      const prsByTask = {};
      for (const pr of allPrs) {
        (prsByTask[pr.task_id] ||= []).push(pr);
      }
      for (const t of tasks) {
        t.all_prs = prsByTask[t.id] || [];
      }
    }

    res.json({ tasks, counts, limit, offset, total: totalQuery.rows[0].total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single task with messages + logs
router.get("/api/queue/:id", async (req, res) => {
  try {
    const task = await getTaskById(parseInt(req.params.id, 10));
    if (!task) return res.status(404).json({ error: "Task not found" });

    const { pool: dbPool } = await import("./db.js");
    const [messages, logs, prOutcomes] = await Promise.all([
      getTaskMessages(task.id),
      getExecutionLogs(task.id),
      dbPool.query(
        "SELECT pr_url, merged, changes_requested, revisions, time_to_merge_ms, merged_at FROM pr_outcomes WHERE task_id = $1 ORDER BY id",
        [task.id]
      ).then((r) => r.rows).catch(() => []),
    ]);

    // Attach all PRs to the task object for multi-repo visibility
    task.all_prs = prOutcomes;

    res.json({ task, messages, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve a queued task (DEVELOPER, ADMIN only)
router.post("/api/queue/:id/approve", requireRole("DEVELOPER", "ADMIN"), async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const { customInstructions } = req.body || {};

    const task = await approveTask(taskId, { customInstructions });
    broadcastSSE({ type: "queue:approved", data: { id: task.id, name: task.name }, ts: new Date().toISOString() });

    // If debate is enabled and auto-start is on, check if task complexity warrants debate
    const debateEnabled = config.get("debateEnabled") === true || config.get("debateEnabled") === "true";
    const debateAutoStart = config.get("debateAutoStart") === true || config.get("debateAutoStart") === "true";

    // Determine task complexity level (use stored value or compute on the fly)
    let taskComplexity = task.complexity_level;
    if (!taskComplexity) {
      const desc = task.description || task.name || "";
      const result = scoreComplexity(desc);
      taskComplexity = result.level;
    }

    // Check admin-configured debate complexity threshold
    // Only run debate for tasks at or above the threshold level
    const complexityOrder = ["simple", "medium", "complex", "critical"];
    let debateThreshold = "complex"; // default: only complex+ tasks get debate
    try {
      const { rows } = await pool.query("SELECT debate_complexity_threshold FROM admin_workflow_config WHERE id = 1");
      if (rows[0]?.debate_complexity_threshold) {
        debateThreshold = rows[0].debate_complexity_threshold;
      }
    } catch (_) { /* use default */ }

    const taskComplexityIdx = complexityOrder.indexOf(taskComplexity);
    const thresholdIdx = complexityOrder.indexOf(debateThreshold);
    const meetsComplexityThreshold = debateThreshold !== "disabled" && taskComplexityIdx >= 0 && thresholdIdx >= 0 && taskComplexityIdx >= thresholdIdx;

    if (debateEnabled && debateAutoStart && meetsComplexityThreshold) {
      const leaderModel = config.get("debateLeaderModel");
      const participants = config.getJSON("debateParticipants") || [];
      const debateStyle = config.get("debateStyle");
      const maxRounds = config.get("debateMaxRounds");

      if (participants.length >= 2) {
        const session = await createDebateSession(taskId, {
          leaderModel, participants, debateStyle, maxRounds,
        });

        const orchestrator = new DebateOrchestrator(task, {
          debateSessionId: session.id,
          leaderModel,
          participants,
          debateStyle,
          maxRounds,
          timeout: config.get("debateModelTimeout"),
          temperature: config.get("debateTemperature"),
          maxTokens: config.get("debateMaxTokens"),
        });

        orchestrator.run().catch((err) => {
          logger.error({ taskId: task.id, debateId: session.id, err: err.message }, "Debate after approval failed");
        });

        return res.json({ ok: true, task, debateStarted: true, debateId: session.id });
      }
      // Fall through to direct execution if not enough participants
      logger.warn({ taskId: task.id }, "Debate enabled but < 2 participants configured, executing directly");
    }

    // Direct execution (no debate, complexity below threshold, or debate not configured)
    if (debateEnabled && !meetsComplexityThreshold) {
      logger.info({ taskId: task.id, complexity: taskComplexity, threshold: debateThreshold }, "Skipping debate — task complexity below threshold, executing directly");
    }
    execute(task).catch((err) => {
      logger.error({ taskId: task.id, err: err.message }, "Execution after approval failed");
    });

    res.json({ ok: true, task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reject a queued task (DEVELOPER, ADMIN only)
router.post("/api/queue/:id/reject", requireRole("DEVELOPER", "ADMIN"), async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const { reason } = req.body || {};

    const task = await rejectTask(taskId, { reason });
    broadcastSSE({ type: "queue:rejected", data: { id: task.id, name: task.name }, ts: new Date().toISOString() });

    res.json({ ok: true, task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Retry a failed task (DEVELOPER, ADMIN only)
router.post("/api/queue/:id/retry", requireRole("DEVELOPER", "ADMIN"), async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const { modifiedInstructions } = req.body || {};

    const task = await retryTask(taskId, { modifiedInstructions });
    broadcastSSE({ type: "queue:retrying", data: { id: task.id, name: task.name }, ts: new Date().toISOString() });

    // Auto-execute retried task
    execute(task).catch((err) => {
      logger.error({ taskId: task.id, err: err.message }, "Retry execution failed");
    });

    res.json({ ok: true, task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete a task (soft-delete, works from any state) (DEVELOPER, ADMIN only)
router.delete("/api/queue/:id", requireRole("DEVELOPER", "ADMIN"), async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);

    const task = await deleteTask(taskId);
    broadcastSSE({ type: "queue:deleted", data: { id: task.id, name: task.name }, ts: new Date().toISOString() });

    res.json({ ok: true, task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Cancel a running task (DEVELOPER, ADMIN only)
router.post("/api/queue/:id/cancel", requireRole("DEVELOPER", "ADMIN"), async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);

    // First, cancel the execution process
    await cancelExecution(taskId);

    // Then mark the task as failed
    const task = await cancelTask(taskId);
    broadcastSSE({ type: "queue:cancelled", data: { id: task.id, name: task.name }, ts: new Date().toISOString() });

    res.json({ ok: true, task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update custom instructions before approval (DEVELOPER, ADMIN only)
router.put("/api/queue/:id/instructions", requireRole("DEVELOPER", "ADMIN"), async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const { instructions } = req.body;

    const { pool } = await import("./db.js");
    await pool.query(
      "UPDATE tasks SET custom_instructions = $1, updated_at = NOW() WHERE id = $2",
      [instructions, taskId]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Edit task description before approval (DEVELOPER, ADMIN only)
router.put("/api/queue/:id/description", requireRole("DEVELOPER", "ADMIN"), async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const { description } = req.body;

    const { pool } = await import("./db.js");
    await pool.query(
      "UPDATE tasks SET modified_description = $1, updated_at = NOW() WHERE id = $2",
      [description, taskId]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Chat / Incremental Updates ───────────────────────────────────

// Get chat messages for a task
router.get("/api/queue/:id/messages", async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const messages = await getTaskMessages(taskId);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add message + trigger state-specific actions (DEVELOPER, ADMIN only)
router.post("/api/queue/:id/messages", requireRole("DEVELOPER", "ADMIN"), async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: "Message content required" });
    }

    const currentTask = await getTaskById(taskId);
    if (!currentTask) return res.status(404).json({ error: "Task not found" });

    const state = currentTask.state;
    let task;

    if (state === "success") {
      // Incremental update on successful task: sets state to approved, triggers execution
      task = await requestUpdate(taskId, content.trim());
      broadcastSSE({ type: "queue:update_requested", data: { id: task.id, name: task.name }, ts: new Date().toISOString() });

      execute(task).catch((err) => {
        logger.error({ taskId: task.id, err: err.message }, "Incremental update execution failed");
      });
    } else if (state === "failed") {
      // Retry with guidance: sets state to retrying with instructions
      task = await requestUpdateOnFailed(taskId, content.trim());
      broadcastSSE({ type: "queue:retrying", data: { id: task.id, name: task.name }, ts: new Date().toISOString() });

      execute(task).catch((err) => {
        logger.error({ taskId: task.id, err: err.message }, "Retry execution failed");
      });
    } else if (state === "running") {
      // Live guidance: just store the message, Claude will pick it up
      await addTaskMessage(taskId, "user", content.trim());
      broadcastSSE({ type: "queue:message", data: { taskId, role: "user" }, ts: new Date().toISOString() });
      task = currentTask;
    } else if (state === "queued" || state === "received") {
      // Pre-set instructions: store message and update custom_instructions
      await addTaskMessage(taskId, "user", content.trim());
      const { pool } = await import("./db.js");
      await pool.query(
        "UPDATE tasks SET custom_instructions = $1, updated_at = NOW() WHERE id = $2",
        [content.trim(), taskId]
      );
      broadcastSSE({ type: "queue:message", data: { taskId, role: "user" }, ts: new Date().toISOString() });
      task = currentTask;
    } else {
      return res.status(400).json({ error: `Cannot add message to task in state '${state}'` });
    }

    res.json({ ok: true, task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Execution Logs ──────────────────────────────────────────────
router.get("/api/queue/:id/logs", async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const logs = await getExecutionLogs(taskId);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Task history (from database) ─────────────────────────────────
router.get("/api/tasks", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const offset = parseInt(req.query.offset || "0", 10);
    const tasks = await getRecentTasks(limit, offset);
    const { pool } = await import("./db.js");
    const { rows } = await pool.query("SELECT COUNT(*)::int as total FROM tasks");
    res.json({ tasks, total: rows[0].total, limit, offset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Active sessions ──────────────────────────────────────────────
router.get("/api/sessions", (_req, res) => {
  res.json(getActiveSessions());
});

// ── PR Reviews ──────────────────────────────────────────────────
router.get("/api/pr-reviews", async (_req, res) => {
  try {
    const reviews = await getPendingPrReviews();
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cost Tracking ────────────────────────────────────────────────
router.get("/api/tasks/:id/costs", async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const summary = await getTaskCostSummary(taskId);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/tasks/:id/steps", async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const steps = await getSteps(taskId);
    res.json(steps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/metrics/costs", async (_req, res) => {
  try {
    const costs = await getAverageCosts();
    res.json(costs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Metrics API ──────────────────────────────────────────────────
router.get("/api/metrics", async (_req, res) => {
  try {
    const { pool } = await import("./db.js");

    // Average step durations from task_steps
    const stepDurations = await pool.query(`
      SELECT 
        step->>'name' as step_name,
        AVG((step->>'duration_ms')::float)::float as avg_duration_ms,
        COUNT(*)::int as count
      FROM tasks, jsonb_array_elements(COALESCE(task_steps, '[]'::jsonb)) step
      WHERE step->>'duration_ms' IS NOT NULL AND (step->>'duration_ms')::float > 0
      GROUP BY step->>'name'
    `);

    const stepAvgs = {};
    for (const row of stepDurations.rows) {
      stepAvgs[row.step_name] = { avg_ms: Math.round(row.avg_duration_ms), count: row.count };
    }

    // Task-level stats
    const taskStats = await pool.query(`
      SELECT 
        COUNT(*)::int as total_tasks,
        COUNT(*) FILTER (WHERE state = 'success')::int as success_count,
        COUNT(*) FILTER (WHERE state = 'failed')::int as failed_count,
        COUNT(*) FILTER (WHERE retry_count > 0)::int as retried_count,
        AVG(duration_ms) FILTER (WHERE state = 'success')::float as avg_task_duration_ms
      FROM tasks WHERE state IN ('success', 'failed')
    `);
    const ts = taskStats.rows[0] || {};

    // Cost data
    const costData = await getAverageCosts();

    const total = ts.total_tasks || 0;
    res.json({
      average_debate_time_ms: stepAvgs.debate?.avg_ms || 0,
      average_planning_time_ms: stepAvgs.planning?.avg_ms || 0,
      average_implementation_time_ms: stepAvgs.implementation?.avg_ms || 0,
      average_task_duration_ms: Math.round(ts.avg_task_duration_ms || 0),
      average_cost_per_task: costData.avg_cost_per_task || 0,
      success_rate: total > 0 ? ((ts.success_count / total) * 100) : 0,
      failure_rate: total > 0 ? ((ts.failed_count / total) * 100) : 0,
      retry_rate: total > 0 ? ((ts.retried_count / total) * 100) : 0,
      total_tasks: total,
      total_cost: costData.total_cost || 0,
      step_averages: stepAvgs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ROI Metrics (Feature 15) ─────────────────────────────────────
router.get("/api/metrics/roi", requireRole("ADMIN", "DEVELOPER", "READ_ONLY"), async (_req, res) => {
  try {
    const { pool } = await import("./db.js");

    const devRate = config.get("developerHourlyRate") || 50;
    const simpleH = config.get("simpleTaskHours") || 2;
    const mediumH = config.get("mediumTaskHours") || 4;
    const complexH = config.get("complexTaskHours") || 8;

    // All-time stats
    const { rows: allTime } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE state = 'success')::int as completed,
              COUNT(*) FILTER (WHERE state = 'failed')::int as failed
       FROM tasks`
    );

    // This week
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { rows: thisWeek } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE state = 'success')::int as completed
       FROM tasks WHERE completed_at >= $1`, [weekAgo]
    );

    // This month
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { rows: thisMonth } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE state = 'success')::int as completed
       FROM tasks WHERE completed_at >= $1`, [monthAgo]
    );

    // Hours saved by complexity
    const { rows: complexityData } = await pool.query(
      `SELECT complexity_level, COUNT(*)::int as count
       FROM tasks WHERE state = 'success' AND complexity_level IS NOT NULL
       GROUP BY complexity_level`
    );

    let totalHoursSaved = 0;
    for (const row of complexityData) {
      switch (row.complexity_level) {
        case "simple": totalHoursSaved += row.count * simpleH; break;
        case "medium": totalHoursSaved += row.count * mediumH; break;
        case "complex": totalHoursSaved += row.count * complexH; break;
        case "critical": totalHoursSaved += row.count * complexH * 1.5; break;
        default: totalHoursSaved += row.count * mediumH;
      }
    }

    // Fallback: if no complexity data, estimate
    const totalCompleted = allTime[0]?.completed || 0;
    if (totalHoursSaved === 0 && totalCompleted > 0) {
      totalHoursSaved = totalCompleted * mediumH;
    }

    // Total AutoShip cost
    const { rows: costData } = await pool.query(
      `SELECT COALESCE(SUM(estimated_cost), 0)::float as total_cost FROM task_costs`
    );
    const totalAutoshipCost = costData[0]?.total_cost || 0;

    const totalCostSaved = totalHoursSaved * devRate - totalAutoshipCost;
    const roiPercentage = totalAutoshipCost > 0
      ? Math.round((totalCostSaved / totalAutoshipCost) * 100)
      : (totalHoursSaved > 0 ? 100 : 0);

    // Weekly trends
    const { rows: weeklyTrends } = await pool.query(
      `SELECT 
        date_trunc('week', completed_at)::date as week,
        COUNT(*) FILTER (WHERE state = 'success')::int as tasks,
        COALESCE(SUM(tc_sum.cost), 0)::float as cost
       FROM tasks t
       LEFT JOIN (
         SELECT task_id, SUM(estimated_cost) as cost
         FROM task_costs GROUP BY task_id
       ) tc_sum ON tc_sum.task_id = t.id
       WHERE t.completed_at IS NOT NULL AND t.completed_at >= NOW() - INTERVAL '12 weeks'
       GROUP BY date_trunc('week', completed_at)
       ORDER BY week DESC
       LIMIT 12`
    );

    // Monthly trends
    const { rows: monthlyTrends } = await pool.query(
      `SELECT 
        date_trunc('month', completed_at)::date as month,
        COUNT(*) FILTER (WHERE state = 'success')::int as tasks,
        COALESCE(SUM(tc_sum.cost), 0)::float as cost
       FROM tasks t
       LEFT JOIN (
         SELECT task_id, SUM(estimated_cost) as cost
         FROM task_costs GROUP BY task_id
       ) tc_sum ON tc_sum.task_id = t.id
       WHERE t.completed_at IS NOT NULL AND t.completed_at >= NOW() - INTERVAL '6 months'
       GROUP BY date_trunc('month', completed_at)
       ORDER BY month DESC
       LIMIT 6`
    );

    // Add estimated hours saved to trends
    const enrichedWeekly = weeklyTrends.map((w) => ({
      week: w.week,
      tasks: w.tasks,
      hoursSaved: w.tasks * mediumH, // simplified estimate
      cost: w.cost,
    }));

    const enrichedMonthly = monthlyTrends.map((m) => ({
      month: m.month,
      tasks: m.tasks,
      hoursSaved: m.tasks * mediumH,
      cost: m.cost,
    }));

    res.json({
      totalTasksCompleted: totalCompleted,
      thisWeekCompleted: thisWeek[0]?.completed || 0,
      thisMonthCompleted: thisMonth[0]?.completed || 0,
      totalHoursSaved,
      totalCostSaved,
      totalAutoshipCost,
      roi_percentage: roiPercentage,
      weeklyTrends: enrichedWeekly,
      monthlyTrends: enrichedMonthly,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── User Activity ────────────────────────────────────────────────
router.get("/api/admin/activity", requireRole("ADMIN"), async (_req, res) => {
  try {
    const { pool } = await import("./db.js");
    const { rows } = await pool.query(
      `SELECT id, email, name, role, last_active_at, activity_source
       FROM users WHERE last_active_at IS NOT NULL
       ORDER BY last_active_at DESC LIMIT 50`
    );
    res.json({ users: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Connectivity checks ──────────────────────────────────────────
router.get("/api/check/clickup", async (_req, res) => {
  try {
    const resp = await fetch("https://api.clickup.com/api/v2/user", {
      headers: { Authorization: process.env.CLICKUP_API_TOKEN },
    });
    if (resp.ok) {
      const data = await resp.json();
      res.json({ ok: true, user: data.user?.username });
    } else {
      res.json({ ok: false, error: `HTTP ${resp.status}` });
    }
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.get("/api/check/github", async (_req, res) => {
  try {
    const token = process.env.GITHUB_TOKEN;
    const resp = await fetch("https://api.github.com/user", {
      headers: { Authorization: `token ${token}`, "User-Agent": "clickup-claude-automation" },
    });
    if (resp.ok) {
      const data = await resp.json();
      res.json({ ok: true, user: data.login });
    } else {
      res.json({ ok: false, error: `HTTP ${resp.status}` });
    }
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.get("/api/check/claude", async (_req, res) => {
  try {
    const { execSync } = await import("node:child_process");
    const version = execSync("claude --version 2>&1", { timeout: 5000 }).toString().trim();
    res.json({ ok: true, version });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

export { router as dashboardRouter, broadcastSSE };
