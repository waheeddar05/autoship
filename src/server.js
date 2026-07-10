// src/server.js
// Webhook server for ClickUp → Claude Code → GitHub PR automation.
// Handles ClickUp webhooks, GitHub webhooks (PR reviews), and the dashboard.

import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { getTaskDetails } from "./clickup-client.js";
import { handleTask, handlePrReview } from "./claude-orchestrator.js";
import { extractExecutionMode, extractAllRepos } from "./execution-engine.js";
import { dashboardRouter } from "./dashboard-api.js";
import { metrics } from "./metrics.js";
import { config } from "./config-manager.js";
import { pool, initialize as initDb } from "./db.js";
import { getActiveTask, getQueueCounts, recoverStaleTasks } from "./task-queue.js";
import { startPoller } from "./poller.js";
import { providersRouter } from "./providers-api.js";
import { providerRegistry } from "./providers/provider-registry.js";
import { passport, sessionMiddleware, requireAuth, authDisabledMiddleware, isAuthEnabled } from "./auth.js";
import { adminRouter } from "./admin-api.js";
import { workflowConfigRouter } from "./admin-workflow-config-api.js";
import { integrationsRouter } from "./integrations-api.js";
import { adminIntegrationsRouter } from "./admin-integrations-api.js";
import { taskCreatorRouter } from "./task-creator-api.js";
import { handleCommentWebhook, processSlackApproval } from "./handlers/approvalHandler.js";
import { register as prometheusRegister } from "./prometheus.js";
import { getAssigneeIds } from "./assignee-resolver.js";
import { recordPROutcome, updatePRMerged, updatePRChangesRequested } from "./learning.js";
import { scheduleWeeklyDigest } from "./weekly-digest.js";
import { verifySlackSignature, openRequestChangesModal, updateApprovalMessage } from "./services/slackInteractiveService.js";
import { apiLimiter, webhookLimiter, authLimiter } from "./middleware/rateLimiter.js";
import { startCleanupSchedule } from "./services/staleTaskCleanupService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Trust proxy chain (GCP LB → Traefik → Pod).
app.set("trust proxy", 1);

// GCP LB terminates TLS and forwards plain HTTP to Traefik, which then sets
// X-Forwarded-Proto: http. Since the app is always served over HTTPS via the
// LB, override the proto header so Express (and express-session) correctly
// detect the connection as secure for cookie handling.
const FORCE_HTTPS = process.env.BASE_URL?.startsWith("https://");
if (FORCE_HTTPS) {
  app.use((req, _res, next) => {
    req.headers["x-forwarded-proto"] = "https";
    next();
  });
}

const PORT = process.env.PORT || 3457;
const WEBHOOK_SECRET = process.env.CLICKUP_WEBHOOK_SECRET || "";
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// ── Task processing cooldown (prevents webhook feedback loops) ────
// When autoship posts a comment, changes status, or reassigns a task,
// ClickUp fires webhooks back. This map tracks which fields were changed
// by autoship so we only block matching feedback events — not unrelated
// user-driven changes like updating a custom field during the cooldown.
const recentlyProcessedTasks = new Map(); // taskId → { timestamp, fields: Set }
const TASK_COOLDOWN_MS = Number(process.env.TASK_COOLDOWN_MS) || 90_000; // 90 seconds

/**
 * Mark a task as recently processed. Tracks which webhook fields autoship
 * will cause (status, assignee, tag, comment) so we can ignore only those.
 */
function markTaskProcessed(taskId) {
  // Autoship's approve/reject flow changes: status, assignee_add, tag, comment
  const fields = new Set(["status", "assignee_add", "assignee", "tag", "comment"]);
  recentlyProcessedTasks.set(taskId, { timestamp: Date.now(), fields });
}

/**
 * Check if an incoming event should be suppressed.
 * Only suppresses events whose field matches what autoship just changed.
 * Custom field changes (e.g. user updates Repo field) pass through.
 */
function isTaskOnCooldown(taskId, payload) {
  const entry = recentlyProcessedTasks.get(taskId);
  if (!entry) return false;
  if (Date.now() - entry.timestamp > TASK_COOLDOWN_MS) {
    recentlyProcessedTasks.delete(taskId);
    return false;
  }

  // Check if the incoming event's changed fields overlap with autoship's changes
  const historyItems = payload.history_items || [];
  const incomingFields = historyItems.map((h) => h.field).filter(Boolean);

  // If the event has history items with fields, only block if ALL fields
  // are ones autoship just changed (e.g. status, assignee, tag).
  // If ANY field is unrelated (e.g. custom_field), let the event through.
  if (incomingFields.length > 0) {
    const allFieldsAreAutoship = incomingFields.every((f) => entry.fields.has(f));
    if (!allFieldsAreAutoship) {
      logger.debug(
        { taskId, incomingFields, autoshipFields: [...entry.fields] },
        "[COOLDOWN] Event contains non-autoship field changes — allowing through"
      );
      return false;
    }
  }

  return true;
}

// Periodic cleanup of stale cooldown entries
setInterval(() => {
  const now = Date.now();
  for (const [taskId, entry] of recentlyProcessedTasks) {
    if (now - entry.timestamp > TASK_COOLDOWN_MS) recentlyProcessedTasks.delete(taskId);
  }
}, 60_000);

// Enforce webhook secrets in production — fail-fast if missing
if (IS_PRODUCTION) {
  if (!WEBHOOK_SECRET || WEBHOOK_SECRET === "required_in_production") {
    logger.error("CLICKUP_WEBHOOK_SECRET is required in production. Set it or disable signature verification.");
  }
  if (!GITHUB_WEBHOOK_SECRET || GITHUB_WEBHOOK_SECRET === "set_this_for_production") {
    logger.warn("GITHUB_WEBHOOK_SECRET not set — GitHub webhook signature verification disabled in production.");
  }
}

// We need raw body for signature verification, but also parsed JSON
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// URL-encoded body parser for Slack interactions (sent as application/x-www-form-urlencoded)
app.use(
  express.urlencoded({
    extended: true,
    verify: (req, _res, buf) => {
      if (!req.rawBody) req.rawBody = buf;
    },
  })
);

// ── Authentication ───────────────────────────────────────────────
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// Login page (served before auth guard)
app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "login.html"));
});

// Google OAuth routes (rate-limited: 10 attempts / 15 min per IP)
app.use("/auth/google", authLimiter);
app.get("/auth/google", passport.authenticate("google", {
  scope: ["profile", "email"],
  prompt: "select_account",
}));

app.get("/auth/google/callback", (req, res, next) => {
  passport.authenticate("google", (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      // Distinguish domain restriction from generic auth failure
      const isDomain = info?.message?.includes("restricted");
      return res.redirect(isDomain ? "/login?error=domain" : "/login?error=auth");
    }
    req.logIn(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      logger.info({ email: user.email, role: user.role }, "User logged in");
      res.redirect("/");
    });
  })(req, res, next);
});

app.get("/auth/logout", (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.redirect("/login");
    });
  });
});

// Session info endpoint (for frontend to know current user)
app.get("/api/auth/me", (req, res) => {
  if (req.isAuthenticated?.()) {
    return res.json({ user: req.user });
  }
  // Dev mode: return mock admin when auth is not configured
  if (!isAuthEnabled) {
    return res.json({ user: { id: "dev", email: process.env.ADMIN_EMAIL || "dev@localhost", name: "Dev User", role: "ADMIN" } });
  }
  res.status(401).json({ error: "Not authenticated" });
});

// ── Slack Interactions endpoint (before auth guard — Slack verifies via signing secret) ──
app.post("/api/slack/interactions", webhookLimiter, async (req, res) => {
  try {
    if (process.env.SLACK_SIGNING_SECRET && !verifySlackSignature(req)) {
      logger.warn("[SLACK] Interaction signature verification failed");
      return res.status(401).json({ error: "Invalid signature" });
    }

    // Parse payload — Slack sends it as a JSON string in `payload` field
    let payload;
    if (req.body?.payload) {
      payload = JSON.parse(req.body.payload);
    } else {
      payload = req.body;
    }

    const { type } = payload;

    if (type === "block_actions") {
      const action = payload.actions?.[0];
      if (!action) return res.status(200).send();

      const clickupTaskId = action.value;
      const userName = payload.user?.name || payload.user?.username || "Unknown";
      const channelId = payload.channel?.id;
      const messageTs = payload.message?.ts;

      logger.info(
        { action: action.action_id, clickupTaskId, user: userName },
        "[SLACK] Interactive action received"
      );

      if (action.action_id === "approve_plan") {
        res.status(200).send();
        processSlackApproval(clickupTaskId, "approved").catch((err) => {
          logger.error({ clickupTaskId, err: err.message }, "[SLACK] Approval processing failed");
        });
        updateApprovalMessage(channelId, messageTs, "approved", userName).catch(() => {});
        return;
      }

      if (action.action_id === "reject_plan") {
        res.status(200).send();
        processSlackApproval(clickupTaskId, "rejected").catch((err) => {
          logger.error({ clickupTaskId, err: err.message }, "[SLACK] Rejection processing failed");
        });
        updateApprovalMessage(channelId, messageTs, "rejected", userName).catch(() => {});
        return;
      }

      if (action.action_id === "request_changes_plan") {
        openRequestChangesModal(payload.trigger_id, clickupTaskId).catch((err) => {
          logger.warn({ err: err.message }, "[SLACK] Failed to open request changes modal");
        });
        return res.status(200).send();
      }
    }

    if (type === "view_submission") {
      const callbackId = payload.view?.callback_id;
      if (callbackId === "request_changes_modal") {
        const metadata = JSON.parse(payload.view?.private_metadata || "{}");
        const clickupTaskId = metadata.clickupTaskId;
        const feedback = payload.view?.state?.values?.feedback_block?.feedback_text?.value || "";

        res.status(200).json({ response_action: "clear" });

        if (clickupTaskId && feedback) {
          processSlackApproval(clickupTaskId, "changes_requested", feedback).catch((err) => {
            logger.error({ clickupTaskId, err: err.message }, "[SLACK] Changes request processing failed");
          });
        }
        return;
      }
    }

    res.status(200).send();
  } catch (err) {
    logger.error({ err: err.message }, "[SLACK] Interaction handling error");
    res.status(200).send();
  }
});

// API rate limit — mounted before the auth guard so unauthenticated
// probing is limited; authenticated users are skipped by the limiter.
app.use("/api", apiLimiter);

// Auth guard — if auth is enabled, require login for all routes below
if (isAuthEnabled) {
  app.use(requireAuth);
} else {
  // Dev mode: inject mock admin user when OAuth not configured
  app.use(authDisabledMiddleware);
}

// ── Dashboard: static files + API routes ─────────────────────────
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(dashboardRouter);
app.use(providersRouter);
app.use(adminRouter);
app.use(workflowConfigRouter);
app.use(integrationsRouter);
app.use(adminIntegrationsRouter);
app.use(taskCreatorRouter);

// Pipe pino logs into metrics for the dashboard log feed
const _origInfo = logger.info.bind(logger);
const _origWarn = logger.warn.bind(logger);
const _origError = logger.error.bind(logger);
const _origDebug = logger.debug.bind(logger);

function captureLog(level, args) {
  try {
    const msg = typeof args[0] === "string" ? args[0] : (typeof args[1] === "string" ? args[1] : "");
    const data = typeof args[0] === "object" && args[0] !== null ? args[0] : {};
    metrics.pushLog(level, msg, data);
  } catch (_) {}
}

logger.info = (...args) => { captureLog("info", args); _origInfo(...args); };
logger.warn = (...args) => { captureLog("warn", args); _origWarn(...args); };
logger.error = (...args) => { captureLog("error", args); _origError(...args); };
logger.debug = (...args) => { captureLog("debug", args); _origDebug(...args); };

// ── Prometheus metrics endpoint (no auth — Prometheus scrapes it) ──
app.get("/metrics", async (_req, res) => {
  try {
    res.set("Content-Type", prometheusRegister.contentType);
    res.end(await prometheusRegister.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// ── Health check ─────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  const health = {
    status: "ok",
    mode: config.get("mode"),
    executionMode: config.get("executionMode"),
    uptime: process.uptime(),
    triggerStatuses: config.getList("triggerStatuses"),
    memory: process.memoryUsage(),
  };

  // DB connectivity check
  try {
    const start = Date.now();
    await pool.query("SELECT 1");
    health.db = { status: "connected", latencyMs: Date.now() - start };
  } catch (err) {
    health.db = { status: "disconnected", error: err.message };
    health.status = "degraded";
  }

  // Queue stats
  try {
    health.queue = await getQueueCounts();
  } catch (_) {
    health.queue = null;
  }

  const statusCode = health.status === "ok" ? 200 : 503;
  res.status(statusCode).json(health);
});

// ── ClickUp Webhook endpoint ─────────────────────────────────────
app.post("/webhook/clickup", webhookLimiter, async (req, res) => {
  res.status(200).json({ received: true });

  const payload = req.body;
  const webhookId = `wh-${Date.now().toString(36)}`;

  try {
    if (WEBHOOK_SECRET && !verifyClickUpSignature(req)) {
      logger.warn({ webhookId }, "[WEBHOOK] ❌ Signature verification failed — ignoring request");
      return;
    }

    const historyItems = payload.history_items?.map((h) => ({
      field: h.field,
      before: typeof h.before === "object" ? JSON.stringify(h.before) : h.before,
      after: typeof h.after === "object" ? JSON.stringify(h.after) : h.after,
    }));

    logger.info(
      {
        webhookId,
        event: payload.event,
        taskId: payload.task_id,
        historyItems,
      },
      `[WEBHOOK] 📨 Received: ${payload.event} for task ${payload.task_id}`
    );

    // Route taskCommentPosted to approval handler (before relevance check).
    // NOTE: We intentionally do NOT apply cooldown to comment events.
    // The approval handler has its own gating (plan_comment_id, plan_posted_at)
    // that correctly filters autoship's own comments, and the DB state machine
    // (pending_approval → approved) prevents double-triggers. Applying cooldown
    // here would block legitimate user approval comments that arrive within
    // the cooldown window after the original task trigger.
    if (payload.event === "taskCommentPosted") {
      logger.info({ webhookId, taskId: payload.task_id }, "[WEBHOOK] 💬 Comment event — routing to approval handler");
      handleCommentWebhook(payload).catch((err) => {
        logger.error({ webhookId, taskId: payload.task_id, err: err.message, stack: err.stack }, "[WEBHOOK] ❌ Comment webhook handler failed");
      });
      return;
    }

    // Cooldown guard: skip events for tasks we recently processed,
    // but only if the event's fields match autoship's own changes.
    // Custom field updates (e.g. user sets Repo field) pass through.
    if (isTaskOnCooldown(payload.task_id, payload)) {
      const historyFields = (payload.history_items || []).map((h) => h.field);
      logger.debug({ webhookId, taskId: payload.task_id, event: payload.event, historyFields }, "[WEBHOOK] ⏭️ SKIP: Task on cooldown (autoship-triggered fields)");
      return;
    }

    // Check 1: Is this a relevant event type?
    const triggerEvents = config.getList("triggerEvents");
    if (!isRelevantEvent(payload)) {
      logger.info(
        { webhookId, event: payload.event, configuredTriggers: triggerEvents },
        `[WEBHOOK] ⏭️ SKIP: Event "${payload.event}" is not in configured triggers [${triggerEvents.join(", ")}]`
      );
      return;
    }
    logger.debug({ webhookId, event: payload.event }, `[WEBHOOK] ✅ Event type is relevant`);

    // Check 2: Was it triggered by a configured user?
    if (!(await isTriggeredByUser(payload))) {
      const configuredUsers = await getAssigneeIds();
      logger.info(
        { webhookId, taskId: payload.task_id, configuredUsers, historyItems },
        `[WEBHOOK] ⏭️ SKIP: Not triggered by configured users [${configuredUsers.join(", ")}]`
      );
      return;
    }
    logger.debug({ webhookId }, "[WEBHOOK] ✅ Triggered by configured user");

    const taskId = payload.task_id;

    // Check 3: Duplicate guard
    const existing = await getActiveTask(taskId);
    if (existing) {
      logger.info(
        { webhookId, taskId, existingState: existing.state, existingId: existing.id },
        `[WEBHOOK] ⏭️ SKIP: Task ${taskId} already active in queue (state: ${existing.state}, db_id: ${existing.id})`
      );
      return;
    }

    logger.debug({ webhookId, taskId, event: payload.event }, "[WEBHOOK] 🔍 Fetching full task details from ClickUp...");
    const task = await getTaskDetails(taskId);
    logger.debug(
      {
        webhookId, taskId,
        name: task.name,
        status: task.status,
        assignees: task.assignees?.map(a => `${a.username}(${a.id})`),
      },
      `[WEBHOOK] 📋 Task details: "${task.name}" [${task.status}]`
    );

    // Check 4: Assignee verification
    const assigneeIds = await getAssigneeIds();
    const taskAssigneeIds = task.assignees.map(a => String(a.id));
    const isMyTask = task.assignees.some((a) => assigneeIds.includes(String(a.id)));
    if (!isMyTask) {
      logger.info(
        { webhookId, taskId, taskAssignees: taskAssigneeIds, configuredAssignees: assigneeIds },
        `[WEBHOOK] ⏭️ SKIP: Task assignees [${taskAssigneeIds.join(", ")}] don't match configured users [${assigneeIds.join(", ")}]`
      );
      return;
    }
    logger.debug({ webhookId }, "[WEBHOOK] ✅ Assignee verified");

    // Check 5: Execution Mode or tag
    const executionMode = extractExecutionMode(task);
    if (executionMode === "autoship") {
      logger.info({ webhookId, taskId, executionMode }, "[WEBHOOK] ✅ Execution Mode = autoship — trigger confirmed");
    } else {
      const triggerTag = config.get("triggerTag") || "autoship";
      const taskTags = task.tags.map(t => typeof t === "string" ? t.toLowerCase() : (t.name || "").toLowerCase());
      if (!taskTags.includes(triggerTag.toLowerCase())) {
        logger.info(
          { webhookId, taskId, executionMode: executionMode || "(not set)", taskTags, requiredTag: triggerTag },
          `[WEBHOOK] ⏭️ SKIP: Execution Mode is "${executionMode || "not set"}" and tags [${taskTags.join(", ")}] don't include "${triggerTag}"`
        );
        return;
      }
      logger.info({ webhookId, triggerTag }, "[WEBHOOK] ✅ Trigger tag found");
    }

    // Check 6: Status
    const triggerStatuses = config.getList("triggerStatuses");
    if (!triggerStatuses.includes(task.status)) {
      logger.info(
        { webhookId, taskId, taskStatus: task.status, allowedStatuses: triggerStatuses },
        `[WEBHOOK] ⏭️ SKIP: Task status "${task.status}" not in allowed statuses [${triggerStatuses.join(", ")}]`
      );
      return;
    }
    logger.debug({ webhookId, status: task.status }, "[WEBHOOK] ✅ Status is triggerable");

    // Check 7: Location filter
    if (!passesLocationFilter(task)) {
      logger.info(
        { webhookId, taskId, list: task.list, folder: task.folder, space: task.space },
        "[WEBHOOK] ⏭️ SKIP: Task failed location filter (space/folder/list)"
      );
      return;
    }

    // All checks passed — trigger!
    logger.info(
      { webhookId, taskId, taskName: task.name, event: payload.event },
      `[WEBHOOK] 🚀 ALL CHECKS PASSED — Triggering task "${task.name}" (${taskId})`
    );

    // Mark task on cooldown BEFORE triggering to prevent feedback loops
    // (handleTask may post comments, change status, reassign — all of which fire webhooks back)
    markTaskProcessed(taskId);

    handleTask(task, { source: "webhook", webhookId }).catch((err) => {
      logger.error(
        { webhookId, taskId, err: err.message, stack: err.stack },
        `[WEBHOOK] ❌ Task handling failed for "${task.name}": ${err.message}`
      );
    });
  } catch (err) {
    logger.error(
      { webhookId, taskId: payload?.task_id, event: payload?.event, err: err.message, stack: err.stack },
      `[WEBHOOK] ❌ Unhandled error processing ${payload?.event}: ${err.message}`
    );
  }
});

// ── GitHub Webhook endpoint (PR review comments) ─────────────────
app.post("/webhook/github", webhookLimiter, async (req, res) => {
  res.status(200).json({ received: true });

  const payload = req.body;
  const event = req.headers["x-github-event"];

  try {
    if (GITHUB_WEBHOOK_SECRET && !verifyGitHubSignature(req)) {
      logger.warn("[GITHUB] ❌ Webhook signature verification failed — ignoring");
      return;
    }

    const pr = payload.pull_request;
    const repo = payload.repository;
    logger.info(
      {
        event, action: payload.action,
        prNumber: pr?.number,
        prTitle: pr?.title,
        branch: pr?.head?.ref,
        repo: repo?.full_name,
        reviewer: payload.review?.user?.login,
        reviewState: payload.review?.state,
        commentUser: payload.comment?.user?.login,
      },
      `[GITHUB] 📨 ${event}/${payload.action} — PR #${pr?.number || "?"} "${pr?.title || "?"}" on ${repo?.full_name || "?"}`
    );

    // Feature 10: Learning — record PR merged events
    if (event === "pull_request" && payload.action === "closed" && payload.pull_request?.merged) {
      const prUrl = pr.html_url;
      logger.info({ prUrl, prNumber: pr.number }, "[GITHUB] ✅ PR merged — recording");
      updatePRMerged(prUrl).catch((err) => {
        logger.warn({ prUrl, err: err.message }, "[GITHUB] Failed to record PR merge (non-fatal)");
      });
    }

    // Feature 10: Learning — record changes_requested
    if (event === "pull_request_review" && payload.action === "submitted" && payload.review?.state === "changes_requested") {
      if (pr) {
        logger.info({ prNumber: pr.number, reviewer: payload.review.user?.login }, "[GITHUB] 📝 Changes requested — recording for learning");
        const comments = payload.review.body ? [{ body: payload.review.body, user: payload.review.user?.login }] : [];
        updatePRChangesRequested(pr.html_url, comments).catch(() => {});
      }
    }

    if (
      (event === "pull_request_review_comment" && payload.action === "created") ||
      (event === "pull_request_review" && payload.action === "submitted" && payload.review?.state === "changes_requested")
    ) {
      if (!pr) {
        logger.warn({ event }, "[GITHUB] ⏭️ SKIP: No pull_request in payload");
        return;
      }

      if (!pr.head?.ref?.startsWith("feature/")) {
        logger.info(
          { branch: pr.head?.ref, prNumber: pr.number },
          `[GITHUB] ⏭️ SKIP: Branch "${pr.head?.ref}" doesn't start with "feature/" — not an AutoShip PR`
        );
        return;
      }

      const reviewComments = [];

      if (event === "pull_request_review_comment") {
        reviewComments.push({
          path: payload.comment.path,
          line: payload.comment.line || payload.comment.original_line,
          body: payload.comment.body,
          user: payload.comment.user?.login,
        });
      } else if (event === "pull_request_review") {
        if (payload.review.body) {
          reviewComments.push({
            path: null,
            line: null,
            body: payload.review.body,
            user: payload.review.user?.login,
          });
        }
      }

      if (reviewComments.length === 0) return;

      const repo = payload.repository;
      handlePrReview({
        prNumber: pr.number,
        prTitle: pr.title,
        prUrl: pr.html_url,
        branch: pr.head.ref,
        baseBranch: pr.base.ref,
        repoFullName: repo.full_name,
        repoName: repo.name,
        reviewComments,
      }).catch((err) => {
        logger.error({ prNumber: pr.number, err: err.message }, "PR review handling failed");
      });
    }
  } catch (err) {
    logger.error({ err: err.message }, "Error processing GitHub webhook");
  }
});

// ── Webhook signature verification ────────────────────────────────
function verifyClickUpSignature(req) {
  const signature = req.headers["x-signature"];
  if (!signature) return false;

  const hash = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(hash));
  } catch {
    return false;
  }
}

function verifyGitHubSignature(req) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) return false;

  const hash = "sha256=" + crypto
    .createHmac("sha256", GITHUB_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(hash));
  } catch {
    return false;
  }
}

// ── Event relevance checks ───────────────────────────────────────

// getAssigneeIds is now imported from ./assignee-resolver.js
// It dynamically resolves from the users table (any user with ClickUp connected),
// with static config override and MY_USER_ID fallback.

/**
 * Check if this webhook event type is one we should handle.
 * Supports configurable trigger events via config.
 */
function isRelevantEvent(payload) {
  const triggerEvents = config.getList("triggerEvents");
  const event = payload.event;

  const eventMap = {
    taskAssigneeUpdated: "assignment",
    taskCreated: "assignment",
    taskStatusUpdated: "status_change",
    taskTagUpdated: "tag_change",
    taskCustomFieldUpdated: "custom_field_change",
    taskUpdated: "custom_field_change",
  };

  const mappedTrigger = eventMap[event];
  if (!mappedTrigger) return false;

  // custom_field_change and taskUpdated are always allowed if assignment trigger is on
  // (Execution Mode custom field changes need to pass through)
  if ((event === "taskCustomFieldUpdated" || event === "taskUpdated") &&
      (triggerEvents.includes("custom_field_change") || triggerEvents.includes("assignment"))) {
    return true;
  }

  return triggerEvents.includes(mappedTrigger);
}

/**
 * Check if the event was triggered by/for one of our configured users.
 */
async function isTriggeredByUser(payload) {
  const assigneeIds = await getAssigneeIds();
  const historyItems = payload.history_items || [];

  for (const item of historyItems) {
    // Assignment events
    if (item.field === "assignee_add" || item.field === "assignee") {
      const afterId = item.after?.id ?? item.after;
      if (assigneeIds.includes(String(afterId))) {
        logger.debug({ field: item.field, afterId }, "Assignment to configured user detected");
        return true;
      }
    }
    // Status change events — always relevant if event type matched
    if (item.field === "status") {
      return true;
    }
    // Tag change events — always relevant if event type matched
    if (item.field === "tag") {
      return true;
    }
    // Custom field change events — always relevant if event type matched
    // This covers "Execution Mode" and other custom field updates
    if (item.field === "custom_field" || item.field?.startsWith("custom_field")) {
      return true;
    }
  }

  // For taskCreated events, verify assignee after fetching full task
  if (payload.event === "taskCreated") return true;

  // For taskCustomFieldUpdated events that didn't match known fields,
  // allow through — ClickUp may use various field names for custom fields.
  if (payload.event === "taskCustomFieldUpdated") {
    logger.debug({ event: payload.event, historyFields: historyItems.map(h => h.field) },
      "[WEBHOOK] ✅ Allowing taskCustomFieldUpdated through — downstream checks will filter");
    return true;
  }

  // NOTE: We intentionally do NOT blanket-allow taskUpdated here.
  // taskUpdated fires for status/assignee changes made by autoship itself,
  // which would cause feedback loops. Only specific field matches above are allowed.

  if (historyItems.length > 0) {
    logger.info(
      { fields: historyItems.map((h) => ({ field: h.field, afterId: h.after?.id ?? h.after })), event: payload.event },
      "[WEBHOOK] ⚠️ No matching trigger field found in history_items — dumping fields for debugging"
    );
  }

  return false;
}

/**
 * Multi-level location filtering: space, folder, list.
 * Returns true if the task passes all configured filters (empty = no filter).
 */
function passesLocationFilter(task) {
  const spaceIds = config.getList("clickupSpaceIds");
  const folderIds = config.getList("clickupFolderIds");
  const listIds = config.getList("clickupListIds");

  if (spaceIds.length > 0 && task.space?.id && !spaceIds.includes(String(task.space.id))) {
    logger.info({ taskId: task.id, space: task.space.id, configured: spaceIds }, "Task not in configured space, skipping");
    return false;
  }

  if (folderIds.length > 0 && task.folder?.id && !folderIds.includes(String(task.folder.id))) {
    logger.info({ taskId: task.id, folder: task.folder.id, configured: folderIds }, "Task not in configured folder, skipping");
    return false;
  }

  if (listIds.length > 0 && task.list?.id && !listIds.includes(String(task.list.id))) {
    logger.info({ taskId: task.id, list: task.list.id, configured: listIds }, "Task not in configured list, skipping");
    return false;
  }

  return true;
}

// ── Start ────────────────────────────────────────────────────────

async function start() {
  // Initialize database
  await initDb();

  // Load config overrides from database (survives container restarts)
  await config.initFromDb(pool);

  // Recover tasks stuck in running/planning from prior crash/restart
  await recoverStaleTasks();

  // Initialize AI providers
  providerRegistry.initialize();

  const mode = config.get("mode");
  const executionMode = config.get("executionMode");
  const triggerStatuses = config.getList("triggerStatuses");
  const triggerEvents = config.getList("triggerEvents");

  const httpServer = app.listen(PORT, () => {
    logger.info("═══════════════════════════════════════════════════");
    logger.info("  ClickUp → Claude Code Automation");
    logger.info("═══════════════════════════════════════════════════");
    logger.info(`  Dashboard:        http://localhost:${PORT}`);
    logger.info(`  ClickUp webhook:  http://localhost:${PORT}/webhook/clickup`);
    logger.info(`  GitHub webhook:   http://localhost:${PORT}/webhook/github`);
    logger.info(`  Health:           http://localhost:${PORT}/health`);
    logger.info(`  Server mode:      ${mode}`);
    logger.info(`  Execution mode:   ${executionMode}`);
    logger.info(`  Signature:        ${WEBHOOK_SECRET ? "enabled" : "disabled"}`);
    logger.info(`  Trigger statuses: ${triggerStatuses.join(", ")}`);
    logger.info(`  Trigger events:   ${triggerEvents.join(", ")}`);
    logger.info("═══════════════════════════════════════════════════");
  });

  // Start poller if mode is 'poller' or 'both'
  if (mode === "poller" || mode === "both") {
    startPoller();
  }

  // Schedule weekly digest if enabled
  scheduleWeeklyDigest();

  // Periodic stale-task cleanup: auto-fail tasks stuck in non-terminal states
  const staleIntervalMs = Number(process.env.STALE_CLEANUP_INTERVAL_MS) || 30 * 60 * 1000;
  const staleCleanupTimer = startCleanupSchedule(staleIntervalMs);
  if (staleCleanupTimer.unref) staleCleanupTimer.unref();

  return httpServer;
}

let server;

start().then((s) => { server = s; }).catch((err) => {
  logger.error({ err: err.message }, "Fatal startup error");
  process.exit(1);
});

// ── Graceful Shutdown ───────────────────────────────────────────
const SHUTDOWN_TIMEOUT_MS = 30_000;

async function shutdown(signal) {
  logger.info({ signal }, "Shutdown signal received, draining…");

  // 1. Stop accepting new connections
  if (server) {
    server.close(() => logger.info("HTTP server closed"));
  }

  // 2. Wait briefly for in-flight requests
  await new Promise((r) => setTimeout(r, 2_000));

  // 3. Close database pool
  try {
    await pool.end();
    logger.info("Database pool closed");
  } catch (err) {
    logger.error({ err: err.message }, "Error closing database pool");
  }

  logger.info("Shutdown complete");
  process.exit(0);
}

// Force exit after timeout so Docker SIGKILL doesn't have to
function forceExit(signal) {
  setTimeout(() => {
    logger.error({ signal }, `Forced exit after ${SHUTDOWN_TIMEOUT_MS}ms`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  shutdown(signal);
}

process.on("SIGTERM", () => forceExit("SIGTERM"));
process.on("SIGINT", () => forceExit("SIGINT"));
