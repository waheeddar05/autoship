// src/services/slackInteractiveService.js
// Slack Block Kit interactive messages for plan approvals.

import crypto from "node:crypto";
import { logger } from "../logger.js";
import { config } from "../config-manager.js";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

/**
 * Verify a Slack interaction request signature.
 *
 * @param {object} req - Express request with rawBody, headers
 * @returns {boolean}
 */
export function verifySlackSignature(req) {
  if (!SLACK_SIGNING_SECRET) return false;

  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];

  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;

  const sigBasestring = `v0:${timestamp}:${req.rawBody}`;
  const mySignature =
    "v0=" +
    crypto.createHmac("sha256", SLACK_SIGNING_SECRET).update(sigBasestring).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Send a Slack Block Kit approval message for a coding plan.
 *
 * @param {object} params
 * @param {string} params.clickupTaskId - ClickUp task ID
 * @param {string} params.taskName - Task name for display
 * @param {string} params.planSummary - Truncated plan summary
 * @param {number} params.qualityScore - Quality score
 * @param {string} [params.repoName] - Target repo name
 * @param {string} [params.threadTs] - Slack thread timestamp for threading
 * @returns {{ ok: boolean, ts?: string }}
 */
export async function sendApprovalMessage({
  clickupTaskId,
  taskName,
  planSummary,
  qualityScore,
  repoName,
  threadTs,
}) {
  if (!SLACK_BOT_TOKEN) {
    logger.debug("No SLACK_BOT_TOKEN, skipping Slack approval message");
    return { ok: false };
  }

  const channelId = config.get("slackChannel") || process.env.SLACK_CHANNEL_ID;
  if (!channelId) {
    logger.debug("No Slack channel configured, skipping approval message");
    return { ok: false };
  }

  const truncatedPlan = (planSummary || "").substring(0, 2500);

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "📋 Coding Plan — Approval Required", emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Task:*\n${taskName}` },
        { type: "mrkdwn", text: `*Quality Score:*\n${qualityScore}/100` },
        ...(repoName ? [{ type: "mrkdwn", text: `*Repo:*\n\`${repoName}\`` }] : []),
        { type: "mrkdwn", text: `*Task ID:*\n${clickupTaskId}` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Plan Preview:*\n\`\`\`${truncatedPlan.substring(0, 500)}${truncatedPlan.length > 500 ? "\n..." : ""}\`\`\``,
      },
    },
    {
      type: "actions",
      block_id: `plan_approval_${clickupTaskId}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Approve", emoji: true },
          style: "primary",
          action_id: "approve_plan",
          value: clickupTaskId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ Reject", emoji: true },
          style: "danger",
          action_id: "reject_plan",
          value: clickupTaskId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "✏️ Request Changes", emoji: true },
          action_id: "request_changes_plan",
          value: clickupTaskId,
        },
      ],
    },
  ];

  const body = {
    channel: channelId,
    blocks,
    text: `Coding plan for "${taskName}" needs approval`,
    unfurl_links: false,
  };

  if (threadTs) {
    body.thread_ts = threadTs;
  }

  try {
    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    const result = await resp.json();
    if (!result.ok) {
      logger.warn({ error: result.error }, "Slack approval message failed");
      return { ok: false };
    }

    logger.info(
      { clickupTaskId, channel: channelId, ts: result.ts },
      "Slack approval message sent"
    );
    return { ok: true, ts: result.ts };
  } catch (err) {
    logger.warn({ err: err.message }, "Slack approval message failed (non-fatal)");
    return { ok: false };
  }
}

/**
 * Open a Slack modal dialog for "Request Changes" feedback.
 *
 * @param {string} triggerId - Slack trigger_id from interaction payload
 * @param {string} clickupTaskId - ClickUp task ID to include in metadata
 */
export async function openRequestChangesModal(triggerId, clickupTaskId) {
  if (!SLACK_BOT_TOKEN) return;

  const view = {
    type: "modal",
    callback_id: "request_changes_modal",
    private_metadata: JSON.stringify({ clickupTaskId }),
    title: { type: "plain_text", text: "Request Changes" },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "feedback_block",
        element: {
          type: "plain_text_input",
          action_id: "feedback_text",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "Describe the changes needed for the coding plan...",
          },
        },
        label: { type: "plain_text", text: "Feedback" },
      },
    ],
  };

  try {
    const resp = await fetch("https://slack.com/api/views.open", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({ trigger_id: triggerId, view }),
    });

    const result = await resp.json();
    if (!result.ok) {
      logger.warn({ error: result.error }, "Failed to open Slack modal");
    }
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to open Slack modal (non-fatal)");
  }
}

/**
 * Update the original approval message to show the action result.
 *
 * @param {string} channelId
 * @param {string} messageTs
 * @param {string} action - "approved" | "rejected" | "changes_requested"
 * @param {string} userName
 */
export async function updateApprovalMessage(channelId, messageTs, action, userName) {
  if (!SLACK_BOT_TOKEN) return;

  const statusMap = {
    approved: "✅ Approved",
    rejected: "❌ Rejected",
    changes_requested: "✏️ Changes Requested",
  };

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Plan ${statusMap[action] || action}* by ${userName}`,
      },
    },
  ];

  try {
    await fetch("https://slack.com/api/chat.update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({ channel: channelId, ts: messageTs, blocks, text: `Plan ${action}` }),
    });
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to update Slack approval message (non-fatal)");
  }
}
