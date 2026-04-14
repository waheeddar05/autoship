// src/slack-notifier.js
// Enhanced Slack notifications with thread-per-task, Block Kit formatting,
// and lifecycle event coverage. Fire-and-forget (never throws).

import { logger } from "./logger.js";
import { config } from "./config-manager.js";
import { setSlackThreadTs, getSlackThreadTs } from "./task-queue.js";

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// ── Color palette for attachments ──
const COLORS = {
  info: "#7c3aed",    // accent purple
  success: "#34d399",  // green
  warning: "#fbbf24",  // yellow
  error: "#f87171",    // red
  neutral: "#94a3b8",  // grey
};

/**
 * Build common enrichment fields (assignees, triggered-by, ClickUp link).
 * These are appended to every event's fields array.
 */
function buildEnrichmentFields(d) {
  const extra = [];

  // Assignees
  if (d.assignees && Array.isArray(d.assignees) && d.assignees.length > 0) {
    const names = d.assignees.map(a => a.username || a.name || `User ${a.id}`).join(", ");
    extra.push({ title: "Assigned To", value: names, short: true });
  }

  // Triggered by
  if (d.triggeredBy) {
    extra.push({ title: "Triggered By", value: d.triggeredBy, short: true });
  }

  // ClickUp task link
  if (d.clickupUrl) {
    extra.push({ title: "ClickUp", value: `<${d.clickupUrl}|View Task>`, short: true });
  } else if (d.taskId) {
    // Build ClickUp URL from task ID as fallback
    extra.push({ title: "Task ID", value: `#${d.taskId}`, short: true });
  }

  return extra;
}

// ── Event → message builder map ──
const EVENT_BUILDERS = {
  task_triggered: (d) => ({
    color: COLORS.info,
    title: "🚀 Task Triggered",
    fields: [
      { title: "Task", value: d.taskName || "Unknown", short: true },
      { title: "Task ID", value: `#${d.taskId || "?"}`, short: true },
      ...(d.repo ? [{ title: "Repo", value: d.repo, short: true }] : []),
      ...(d.complexity ? [{ title: "Complexity", value: d.complexity, short: true }] : []),
    ],
  }),

  task_started: (d) => ({
    color: COLORS.info,
    title: "⚙️ Execution Started",
    fields: [
      { title: "Task", value: d.taskName || "Unknown", short: true },
      ...(d.repo ? [{ title: "Repo", value: d.repo, short: true }] : []),
    ],
  }),

  debate_completed: (d) => ({
    color: COLORS.success,
    title: "🧠 Debate Completed",
    fields: [
      { title: "Task", value: d.taskName || "Unknown", short: true },
      { title: "Rounds", value: String(d.rounds || 0), short: true },
      ...(d.duration ? [{ title: "Duration", value: formatDuration(d.duration), short: true }] : []),
    ],
  }),

  planning_completed: (d) => ({
    color: COLORS.info,
    title: "📋 Planning Completed",
    fields: [
      { title: "Task", value: d.taskName || "Unknown", short: true },
      ...(d.duration ? [{ title: "Duration", value: formatDuration(d.duration), short: true }] : []),
    ],
  }),

  implementation_started: (d) => ({
    color: COLORS.info,
    title: "🔨 Implementation Started",
    fields: [
      { title: "Task", value: d.taskName || "Unknown", short: true },
      ...(d.repo ? [{ title: "Repo", value: d.repo, short: true }] : []),
    ],
  }),

  pr_created: (d) => ({
    color: COLORS.success,
    title: "✅ Pull Request Created",
    fields: [
      { title: "Task", value: d.taskName || "Unknown", short: true },
      { title: "PR", value: d.prUrl ? `<${d.prUrl}|#${d.prNumber}>` : `#${d.prNumber}`, short: true },
      ...(d.repo ? [{ title: "Repo", value: d.repo, short: true }] : []),
    ],
  }),

  validation_completed: (d) => ({
    color: COLORS.success,
    title: "🔍 Validation Completed",
    fields: [
      { title: "Task", value: d.taskName || "Unknown", short: true },
      ...(d.duration ? [{ title: "Duration", value: formatDuration(d.duration), short: true }] : []),
    ],
  }),

  task_completed: (d) => ({
    color: COLORS.success,
    title: "🎉 Task Completed",
    fields: [
      { title: "Task", value: d.taskName || "Unknown", short: true },
      ...(d.prUrl ? [{ title: "PR", value: `<${d.prUrl}|View PR>`, short: true }] : []),
      ...(d.duration ? [{ title: "Duration", value: formatDuration(d.duration), short: true }] : []),
    ],
  }),

  task_failed: (d) => ({
    color: COLORS.error,
    title: "❌ Task Failed",
    fields: [
      { title: "Task", value: d.taskName || "Unknown", short: true },
      ...(d.error ? [{ title: "Error", value: d.error.substring(0, 200), short: false }] : []),
      ...(d.repo ? [{ title: "Repo", value: d.repo, short: true }] : []),
    ],
  }),

  retry_attempt: (d) => ({
    color: COLORS.warning,
    title: `🔄 Retry Attempt (${d.retryCount || "?"}/${d.maxRetries || "?"})`,
    fields: [
      { title: "Task", value: d.taskName || "Unknown", short: true },
      ...(d.failureStage ? [{ title: "Failed At", value: d.failureStage, short: true }] : []),
    ],
  }),

  pr_review_started: (d) => ({
    color: COLORS.info,
    title: "👀 PR Review Auto-Fix Started",
    fields: [
      { title: "PR", value: `#${d.prNumber}`, short: true },
      { title: "Repo", value: d.repo || "", short: true },
    ],
  }),

  pr_review_completed: (d) => ({
    color: COLORS.success,
    title: "✅ PR Review Fixes Pushed",
    fields: [
      { title: "PR", value: `#${d.prNumber}`, short: true },
      { title: "Repo", value: d.repo || "", short: true },
    ],
  }),
};

/**
 * Send a Slack notification. Fire-and-forget — never throws.
 * Supports thread-per-task when taskDbId is provided and slackThreadPerTask is enabled.
 *
 * @param {string} event - Event type
 * @param {object} data - Event-specific data. Include taskDbId for threading.
 */
export async function notifySlack(event, data = {}) {
  if (!SLACK_WEBHOOK_URL && !SLACK_BOT_TOKEN) return;

  const builder = EVENT_BUILDERS[event];
  if (!builder) return;

  try {
    const { color, title, fields } = builder(data);
    // Append enrichment fields (assignees, triggered-by, ClickUp link)
    const enrichedFields = [...fields, ...buildEnrichmentFields(data)];
    const useThreading = config.get("slackThreadPerTask") && data.taskDbId;
    let threadTs = null;

    if (useThreading) {
      threadTs = await getSlackThreadTs(data.taskDbId).catch(() => null);
    }

    // Build the payload
    const attachment = {
      color,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${title}*` },
        },
        {
          type: "section",
          fields: enrichedFields.map(f => ({
            type: "mrkdwn",
            text: `*${f.title}*\n${f.value}`,
          })),
        },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `_${new Date().toISOString()}_` },
          ],
        },
      ],
      fallback: title,
    };

    const channelId = config.get("slackChannel") || process.env.SLACK_CHANNEL_ID;

    if (SLACK_BOT_TOKEN && channelId) {
      // Use Slack Web API for threading support
      const body = {
        channel: channelId,
        attachments: [attachment],
        unfurl_links: false,
      };

      if (threadTs) {
        body.thread_ts = threadTs;
      }

      const resp = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        },
        body: JSON.stringify(body),
      });

      const result = await resp.json();

      // Store thread_ts from first message for task threading
      if (result.ok && !threadTs && useThreading && result.ts) {
        await setSlackThreadTs(data.taskDbId, result.ts).catch(() => {});
      }
    } else if (SLACK_WEBHOOK_URL) {
      // Fallback: webhook (no threading)
      const payload = { attachments: [attachment] };
      if (channelId) payload.channel = channelId;

      await fetch(SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
  } catch (err) {
    logger.warn({ err: err.message, event }, "Slack notification failed (non-fatal)");
  }
}

function formatDuration(ms) {
  if (!ms) return "N/A";
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}
