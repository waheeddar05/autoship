// src/providers-api.js
// REST endpoints for AI providers and debate management.

import { Router } from "express";
import { providerRegistry } from "./providers/provider-registry.js";
import { config } from "./config-manager.js";
import { logger } from "./logger.js";
import {
  getTaskById, createDebateSession, getDebateSession,
  getDebateSessionByTaskId, updateDebateSession,
} from "./task-queue.js";
import { DebateOrchestrator } from "./debate/debate-orchestrator.js";
import { execute } from "./execution-engine.js";

const router = Router();

// ── Provider endpoints ──────────────────────────────────────
// NOTE: Static paths MUST come before parameterized ":name" routes
// so Express doesn't match "models" or "execution-models" as a :name param.

/** List providers with configuration status. */
router.get("/api/providers", (_req, res) => {
  res.json(providerRegistry.getConfiguredProviders());
});

/** List all models across all providers. */
router.get("/api/providers/models", async (_req, res) => {
  try {
    const models = await providerRegistry.listAllModels();
    res.json(models);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Anthropic models only (for execution model selection). */
router.get("/api/providers/execution-models", async (_req, res) => {
  try {
    const models = await providerRegistry.getAnthropicModels();
    res.json(models);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Validate a provider's API key. */
router.post("/api/providers/:name/validate", async (req, res) => {
  try {
    const provider = providerRegistry.getProvider(req.params.name);
    if (!provider) return res.status(404).json({ error: "Provider not found" });
    if (!provider.configured) return res.json({ valid: false, error: "API key not set" });

    const valid = await provider.validateKey();
    res.json({ valid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** List models for a specific provider. */
router.get("/api/providers/:name/models", async (req, res) => {
  try {
    const models = await providerRegistry.listModels(req.params.name);
    res.json(models);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Configuration Presets ────────────────────────────────────

/** List available configuration presets. */
router.get("/api/presets", (_req, res) => {
  res.json(config.getPresets());
});

/** Apply a configuration preset. */
router.post("/api/presets/:id/apply", (req, res) => {
  try {
    const result = config.applyPreset(req.params.id);
    logger.info({ preset: result.preset.name, keys: result.applied.length }, "Configuration preset applied");
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Debate endpoints ────────────────────────────────────────

/** Start a debate for a task. */
router.post("/api/debate/:taskId/start", async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId, 10);
    const task = await getTaskById(taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });

    // Allow body overrides or fall back to config
    const leaderModel = req.body.leaderModel || config.get("debateLeaderModel");
    const participants = req.body.participants || config.getJSON("debateParticipants") || [];
    const debateStyle = req.body.debateStyle || config.get("debateStyle");
    const maxRounds = req.body.maxRounds || config.get("debateMaxRounds");

    if (participants.length < 2) {
      return res.status(400).json({ error: "At least 2 debate participants are required" });
    }

    // Check for existing active debate
    const existing = await getDebateSessionByTaskId(taskId);
    if (existing && !["done", "approved", "rejected", "failed"].includes(existing.state)) {
      return res.status(409).json({ error: "Debate already in progress", debateId: existing.id });
    }

    const session = await createDebateSession(taskId, {
      leaderModel, participants, debateStyle, maxRounds,
    });

    // Run debate asynchronously
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
      logger.error({ taskId, debateId: session.id, err: err.message }, "Debate failed");
    });

    res.json({ ok: true, debateId: session.id, state: "pending" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Get debate session status + transcript. */
router.get("/api/debate/:taskId", async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId, 10);
    const session = await getDebateSessionByTaskId(taskId);
    if (!session) return res.status(404).json({ error: "No debate session found" });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Approve the debate plan and trigger execution. */
router.post("/api/debate/:taskId/approve", async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId, 10);
    const session = await getDebateSessionByTaskId(taskId);
    if (!session) return res.status(404).json({ error: "No debate session found" });
    if (session.state !== "done") {
      return res.status(400).json({ error: `Debate is in state "${session.state}", must be "done" to approve` });
    }

    await updateDebateSession(session.id, {
      state: "approved",
      approved_at: new Date().toISOString(),
    });

    // Trigger execution with the debate plan
    const task = await getTaskById(taskId);
    execute(task).catch((err) => {
      logger.error({ taskId, err: err.message }, "Execution after debate approval failed");
    });

    res.json({ ok: true, debateId: session.id, state: "approved" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Reject the debate plan. */
router.post("/api/debate/:taskId/reject", async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId, 10);
    const session = await getDebateSessionByTaskId(taskId);
    if (!session) return res.status(404).json({ error: "No debate session found" });

    await updateDebateSession(session.id, {
      state: "rejected",
      error_message: req.body.reason || "Rejected by user",
    });

    res.json({ ok: true, debateId: session.id, state: "rejected" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { router as providersRouter };
