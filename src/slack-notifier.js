// src/slack-notifier.js
// Slack notifications with thread-per-task and readable, low-noise formatting.
// The first message of a task posts one rich "anchor" card (task, repo,
// assignees, ClickUp link) that starts the thread; every later lifecycle
// event is a compact one-line reply so the thread reads as a timeline
// instead of a stack of repeated cards. Fire-and-forget (never throws).

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
 * Only shown on the anchor card — they never change mid-task, so repeating
 * them on every update is pure noise.
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

/**
 * Convert GitHub-flavored markdown (Claude's output) to Slack mrkdwn.
 */
function toMrkdwn(text) {
  return String(text)
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    .trim();
}

/**
 * Trim text to maxChars at a line boundary where possible.
 */
function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf("\n");
  return (lastNewline > maxChars * 0.5 ? cut.slice(0, lastNewline) : cut).trimEnd() + " …";
}

// ── Event → message builder map ──
// The anchor builder (task_triggered) returns { anchor, color, title, fields }
// and renders as a rich card. All others return { color, text } and render as
// compact one-line thread replies.
const EVENT_BUILDERS = {
  // Thread parent: the one rich card that anchors a task's thread.
  task_triggered: (d) => ({
    anchor: true,
    color: COLORS.info,
    title: `🚀 *${d.taskName || "Unknown task"}*`,
    fields: [
      ...(d.repo ? [{ title: "Repo", value: d.repo, short: true }] : []),
      ...(d.complexity ? [{ title: "Complexity", value: d.complexity, short: true }] : []),
    ],
  }),

  planning_completed: (d) => ({
    color: COLORS.info,
    text: `📋 Planning complete${d.repo ? ` — \`${d.repo}\`` : ""}${d.duration ? ` (${formatDuration(d.duration)})` : ""}`,
  }),

  debate_completed: (d) => ({
    color: COLORS.success,
    text: `🧠 Debate complete — ${d.rounds || 0} round(s)${d.duration ? ` in ${formatDuration(d.duration)}` : ""}, plan ready for review`,
  }),

  complexity_scored: (d) => ({
    color: COLORS.neutral,
    text: `🧭 Complexity: ${d.level || "unknown"} (${d.score ?? "?"}/100)${d.estimatedFiles ? ` — est. ~${d.estimatedFiles} file(s)` : ""}`,
  }),

  implementation_started: (d) => ({
    color: COLORS.info,
    text: `🔨 Implementation started${d.repo ? ` — \`${d.repo}\`` : ""}`,
  }),

  pr_created: (d) => {
    const label = `${d.repo || "PR"}#${d.prNumber || "?"}`;
    return {
      color: COLORS.success,
      text: `✅ Pull request ready: ${d.prUrl ? `<${d.prUrl}|${label}>` : label}`,
    };
  },

  validation_completed: (d) => ({
    color: COLORS.success,
    text: `🔍 Validation complete${d.duration ? ` (${formatDuration(d.duration)})` : ""}`,
  }),

  task_no_changes: (d) => ({
    color: COLORS.warning,
    text: `⚠️ Finished without code changes — nothing to push${d.repo ? ` (\`${d.repo}\`)` : ""}`,
  }),

  // Completion carries the summary of actions: what functionally changed
  // (Claude's own summary) plus file/line stats and PR links.
  task_completed: (d) => {
    const lines = [`🎉 *Task completed*${d.duration ? ` in ${formatDuration(d.duration)}` : ""}`];

    const stats = d.changeStats;
    if (stats && stats.files > 0) {
      const repoNote = stats.repos && stats.repos.length > 1 ? ` across ${stats.repos.length} repos` : "";
      lines.push(`*What changed* — ${stats.files} file(s), +${stats.insertions} −${stats.deletions}${repoNote}`);
    } else if (d.summary) {
      lines.push("*What changed*");
    }
    if (d.summary) {
      lines.push(truncate(toMrkdwn(d.summary), 1200));
    }

    const prUrls = d.prUrls || (d.prUrl ? [d.prUrl] : []);
    if (prUrls.length > 0) {
      lines.push(prUrls.map((url, i) => `→ <${url}|${prUrls.length > 1 ? `PR ${i + 1}` : "View PR"}>`).join("  "));
    }

    return { color: COLORS.success, text: lines.join("\n"), fallback: "🎉 Task completed" };
  },

  task_failed: (d) => ({
    color: COLORS.error,
    text: `❌ *Task failed*${d.failureStage ? ` at \`${d.failureStage}\`` : ""}\n\`\`\`${(d.error || "Unknown error").substring(0, 300)}\`\`\``,
    fallback: "❌ Task failed",
  }),

  retry_attempt: (d) => ({
    color: COLORS.warning,
    text: `🔄 Retrying (attempt ${d.retryCount || "?"}/${d.maxRetries || "?"})${d.failureStage ? ` after failure at \`${d.failureStage}\`` : ""}`,
  }),

  pr_review_started: (d) => ({
    color: COLORS.info,
    text: `👀 Review auto-fix started — ${d.repo || ""}#${d.prNumber}`,
  }),

  pr_review_completed: (d) => ({
    color: COLORS.success,
    text: `✅ Review fixes pushed — ${d.repo || ""}#${d.prNumber}`,
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
    const spec = builder(data);
    const useThreading = config.get("slackThreadPerTask") && data.taskDbId;
    let threadTs = null;

    if (useThreading) {
      threadTs = await getSlackThreadTs(data.taskDbId).catch(() => null);
    }

    let blocks;
    let fallback;
    if (spec.anchor) {
      const fields = [...(spec.fields || []), ...buildEnrichmentFields(data)].filter((f) => f && f.value);
      blocks = [{ type: "section", text: { type: "mrkdwn", text: spec.title } }];
      if (fields.length > 0) {
        blocks.push({
          type: "section",
          fields: fields.map((f) => ({ type: "mrkdwn", text: `*${f.title}*\n${f.value}` })),
        });
      }
      fallback = spec.title;
    } else {
      // Compact update. Inside a thread the anchor card already identifies the
      // task; outside one, prefix the task name so the message stands alone.
      const text = threadTs || !data.taskName ? spec.text : `*${data.taskName}*\n${spec.text}`;
      blocks = [{ type: "section", text: { type: "mrkdwn", text } }];
      fallback = spec.fallback || spec.text.split("\n")[0];
    }

    const attachment = { color: spec.color, blocks, fallback };
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

      // Only the anchor card starts a thread — compact updates that happen to
      // arrive first (e.g. debate before execution) must not become the parent.
      if (result.ok && spec.anchor && !threadTs && useThreading && result.ts) {
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

/**
 * Send a plain mrkdwn text message to Slack, outside the event-builder system.
 * Used by operational alerts (stale task cleanup, cost anomalies) that don't
 * belong to a task lifecycle event. Fire-and-forget — never throws.
 *
 * @param {string} text - mrkdwn message text
 * @param {string} [channel] - Channel override; defaults to configured channel
 */
export async function sendSlackText(text, channel) {
  if (!SLACK_WEBHOOK_URL && !SLACK_BOT_TOKEN) return;

  try {
    const channelId = channel || config.get("slackChannel") || process.env.SLACK_CHANNEL_ID;

    if (SLACK_BOT_TOKEN && channelId) {
      const resp = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        },
        body: JSON.stringify({ channel: channelId, text, unfurl_links: false }),
      });
      const result = await resp.json();
      if (!result.ok) {
        logger.warn({ error: result.error }, "Slack text message failed (non-fatal)");
      }
    } else if (SLACK_WEBHOOK_URL) {
      const payload = { text };
      if (channelId) payload.channel = channelId;
      await fetch(SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
  } catch (err) {
    logger.warn({ err: err.message }, "Slack text message failed (non-fatal)");
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
