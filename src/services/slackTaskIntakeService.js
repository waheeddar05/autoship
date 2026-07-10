// src/services/slackTaskIntakeService.js
// Slack task intake: "@autoship fix the login redirect in org/webapp" →
// AI-generated task draft posted back in-thread with Create / Create & Run /
// Cancel buttons. Confirming creates the ClickUp task via the same path as
// the dashboard task creator (repo field, Execution Mode, optional trigger).

import { pool } from "../db.js";
import { logger } from "../logger.js";
import { config } from "../config-manager.js";
import { generateTaskDraft, createClickUpTask } from "../task-creator-api.js";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const INTAKE_MODEL = process.env.SLACK_INTAKE_MODEL || "anthropic:claude-sonnet-4-6";

async function slackApi(method, body) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`Slack ${method} failed: ${result.error}`);
  return result;
}

/** Extract an owner/repo (or bare repo) reference from the message text. */
function extractRepo(text) {
  const full = text.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/);
  if (full) return full[1];
  const tagged = text.match(/\brepo[:=]\s*([A-Za-z0-9_.-]+)\b/i);
  return tagged ? tagged[1] : null;
}

/**
 * Handle a Slack app_mention event: generate a draft task and post it back
 * in-thread with confirmation buttons. Fire-and-forget from the endpoint.
 */
export async function handleAppMention(event) {
  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const requestedBy = event.user;

  // Strip the bot mention(s) from the text
  const prompt = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!prompt) {
    await slackApi("chat.postMessage", {
      channel, thread_ts: threadTs,
      text: "Tell me what to build, e.g. `@AutoShip fix the login redirect in acme/webapp`",
    }).catch(() => {});
    return;
  }

  const listId = config.get("slackIntakeListId");
  if (!listId) {
    await slackApi("chat.postMessage", {
      channel, thread_ts: threadTs,
      text: "⚙️ Slack intake isn't configured yet — set *Slack Intake List ID* in the AutoShip dashboard settings.",
    }).catch(() => {});
    return;
  }

  const repoFullName = extractRepo(prompt);

  let draft;
  try {
    draft = await generateTaskDraft({ prompt, repoFullName, modelSpec: INTAKE_MODEL });
  } catch (err) {
    logger.error({ err: err.message }, "[SLACK-INTAKE] Draft generation failed");
    await slackApi("chat.postMessage", {
      channel, thread_ts: threadTs,
      text: `❌ Couldn't generate a task draft: ${err.message}`,
    }).catch(() => {});
    return;
  }

  const { rows } = await pool.query(
    `INSERT INTO slack_task_drafts (channel, thread_ts, requested_by, draft, repo_full_name, list_id, state)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING id`,
    [channel, threadTs, requestedBy, JSON.stringify(draft), repoFullName, String(listId)]
  );
  const draftId = String(rows[0].id);

  const preview = (draft.description || "").slice(0, 500);
  await slackApi("chat.postMessage", {
    channel,
    thread_ts: threadTs,
    text: `Task draft: ${draft.title}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `📝 *${draft.title}*${repoFullName ? `\n*Repo:* \`${repoFullName}\`` : "\n⚠️ _No repo detected — the task won't auto-execute without one._"}` },
      },
      { type: "section", text: { type: "mrkdwn", text: preview + (preview.length < (draft.description || "").length ? "…" : "") } },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Tags: ${(draft.tags || []).join(", ") || "none"} · Priority: ${draft.priority || 3} · Complexity: ${draft.estimatedComplexity || "?"}` }],
      },
      {
        type: "actions",
        elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Create & Run" }, action_id: "slack_task_create_run", value: draftId },
          { type: "button", text: { type: "plain_text", text: "Create Only" }, action_id: "slack_task_create", value: draftId },
          { type: "button", style: "danger", text: { type: "plain_text", text: "Cancel" }, action_id: "slack_task_cancel", value: draftId },
        ],
      },
    ],
  });

  logger.info({ draftId, channel, repoFullName }, "[SLACK-INTAKE] Draft posted for confirmation");
}

/**
 * Handle a button click on a draft message. Returns a status string used
 * to update the original message.
 */
export async function handleIntakeAction(actionId, draftId, userName, { channel, messageTs } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM slack_task_drafts WHERE id = $1 AND state = 'pending'`,
    [parseInt(draftId, 10)]
  );
  const draftRow = rows[0];
  if (!draftRow) {
    await updateIntakeMessage(channel, messageTs, "⚠️ This draft was already handled.");
    return;
  }

  if (actionId === "slack_task_cancel") {
    await pool.query(`UPDATE slack_task_drafts SET state = 'cancelled' WHERE id = $1`, [draftRow.id]);
    await updateIntakeMessage(channel, messageTs, `🗑️ Draft cancelled by ${userName}.`);
    return;
  }

  const triggerImplementation = actionId === "slack_task_create_run";
  const draft = typeof draftRow.draft === "string" ? JSON.parse(draftRow.draft) : draftRow.draft;

  try {
    const result = await createClickUpTask({
      listId: draftRow.list_id,
      title: draft.title,
      description: draft.description,
      tags: draft.tags,
      priority: draft.priority,
      repoFullName: draftRow.repo_full_name,
      triggerImplementation: triggerImplementation && !!draftRow.repo_full_name,
      source: "slack_intake",
    });

    await pool.query(
      `UPDATE slack_task_drafts SET state = 'created', created_task_id = $2 WHERE id = $1`,
      [draftRow.id, result.taskId]
    );

    const runNote = result.implementationTriggered ? " — AutoShip is on it 🚀" : "";
    await updateIntakeMessage(
      channel, messageTs,
      `✅ Task created by ${userName}: <${result.url}|${draft.title}>${runNote}`
    );
    logger.info({ draftId: draftRow.id, taskId: result.taskId, triggered: result.implementationTriggered }, "[SLACK-INTAKE] Task created");
  } catch (err) {
    logger.error({ draftId: draftRow.id, err: err.message }, "[SLACK-INTAKE] Task creation failed");
    await updateIntakeMessage(channel, messageTs, `❌ Task creation failed: ${err.message}`);
  }
}

async function updateIntakeMessage(channel, ts, text) {
  if (!channel || !ts) return;
  try {
    await slackApi("chat.update", { channel, ts, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
  } catch (err) {
    logger.warn({ err: err.message }, "[SLACK-INTAKE] Failed to update message");
  }
}
