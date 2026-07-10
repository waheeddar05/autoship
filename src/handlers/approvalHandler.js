// src/handlers/approvalHandler.js
// Approval detection for coding plans via webhook events or polling fallback.
// Ensures execution only triggers on comments posted AFTER the plan comment.

import { pool } from "../db.js";
import { logger } from "../logger.js";
import {
  getTaskComments,
  getTaskDetails,
  postTaskComment,
  updateTaskStatus,
  removeTagFromTask,
} from "../clickup-client.js";
import { execute } from "../execution-engine.js";
import { approveTask, addExecutionLog, failTask, getTaskById } from "../task-queue.js";
import { config } from "../config-manager.js";
import { runWorkflow } from "../orchestrators/workflowOrchestrator.js";
import {
  getPendingClarification, recordClarificationAnswer, buildEnrichedDescription,
} from "../services/clarificationService.js";

const POLL_INTERVAL_MS = Number(process.env.APPROVAL_POLL_INTERVAL_MS) || 5 * 60 * 1000; // 5 minutes
const MAX_POLL_ATTEMPTS = Number(process.env.APPROVAL_MAX_POLL_ATTEMPTS) || 288; // 24 hours

// Track active polling intervals so we can cancel them
const activePollers = new Map(); // clickupTaskId → { intervalId, attempts, planCommentId }

// ── Webhook-based Approval Detection ─────────────────────────────

/**
 * Handle a taskCommentPosted webhook event.
 * Checks if the comment matches approval keywords for a pending workflow.
 * Only considers comments posted AFTER the plan comment.
 *
 * @param {object} payload - ClickUp webhook payload
 */
export async function handleCommentWebhook(payload) {
  const taskId = payload.task_id;
  if (!taskId) return;

  // Clarification answers take precedence — they happen pre-plan, so no
  // approval row exists yet for these tasks
  const clarification = await getPendingClarification(taskId);
  if (clarification) {
    const commentInfo = extractCommentInfo(payload);
    const isOwnComment = commentInfo?.id && commentInfo.id === clarification.comment_id;
    const postedBefore = commentInfo?.date && clarification.created_at &&
      Number(commentInfo.date) <= new Date(clarification.created_at).getTime();
    if (commentInfo?.text && !isOwnComment && !postedBefore) {
      await processClarificationAnswer(taskId, clarification, commentInfo.text).catch((err) => {
        logger.error({ taskId, err: err.message }, "Clarification answer processing failed");
      });
      return;
    }
  }

  // Check if this task has a pending approval
  const approval = await getPendingApproval(taskId);
  if (!approval) return;

  // Extract comment text and ID from the history items
  const commentInfo = extractCommentInfo(payload);
  if (!commentInfo || !commentInfo.text) return;

  // Gate: ignore the plan comment itself and any comment with ID <= plan comment ID
  if (approval.plan_comment_id && commentInfo.id) {
    if (commentInfo.id === approval.plan_comment_id) {
      logger.debug({ taskId, commentId: commentInfo.id }, "Ignoring plan comment itself for approval detection");
      return;
    }
  }

  // Gate: ignore comments posted before the plan was posted
  if (approval.plan_posted_at && commentInfo.date) {
    const planPostedMs = new Date(approval.plan_posted_at).getTime();
    if (Number(commentInfo.date) <= planPostedMs) {
      logger.debug({
        taskId,
        commentId: commentInfo.id,
        commentDate: commentInfo.date,
        planPostedAt: approval.plan_posted_at,
      }, "Ignoring comment posted before/at plan posting time");
      return;
    }
  }

  // Load approval keywords from config
  const cfg = await getWorkflowConfig();
  if (!cfg) return;

  const isApproval = matchesApprovalKeyword(commentInfo.text, cfg.approvalKeywords);
  if (!isApproval) {
    // Not an approval — treat as a plan change request.
    // If someone comments on a task with a pending plan, they likely want changes.
    // Re-generate the plan incorporating the feedback.
    logger.info({ taskId, commentText: commentInfo.text.substring(0, 200) },
      "Non-approval comment posted after plan — treating as plan change request");
    await processPlanChangeRequest(taskId, approval, commentInfo.text);
    return;
  }

  logger.info({
    taskId,
    commentId: commentInfo.id,
    planCommentId: approval.plan_comment_id,
  }, "Approval detected via webhook — comment posted after plan");
  await processApproval(taskId, approval, cfg);
}

// ── Clarification Answers ────────────────────────────────────────

/**
 * The ticket author replied to AutoShip's clarifying questions: record the
 * answer, enrich the task description with the Q&A, and re-run the quality
 * workflow with the enriched task.
 */
async function processClarificationAnswer(clickupTaskId, request, answerText) {
  logger.info({ taskId: clickupTaskId, requestId: request.id }, "Clarification answer received — re-evaluating task");

  await recordClarificationAnswer(request.id, answerText);
  try {
    await removeTagFromTask(clickupTaskId, "awaiting-clarification");
  } catch (_) {}

  let questions = [];
  try {
    questions = typeof request.questions === "string" ? JSON.parse(request.questions) : request.questions || [];
  } catch (_) {}

  const task = await getTaskDetails(clickupTaskId);
  const enriched = buildEnrichedDescription(task.markdownDescription || task.description, questions, answerText);

  const dbTaskId = request.db_task_id;
  if (dbTaskId) {
    await pool.query(
      `UPDATE tasks SET modified_description = $1, updated_at = NOW() WHERE id = $2`,
      [enriched, dbTaskId]
    ).catch(() => {});
    await addExecutionLog(dbTaskId, "info", "quality_check", "Clarification answers received — re-running quality workflow");
    // Back to planning for the re-evaluation (state machine tolerant)
    await pool.query(
      `UPDATE tasks SET state = 'planning', updated_at = NOW() WHERE id = $1 AND state IN ('queued', 'received')`,
      [dbTaskId]
    ).catch(() => {});
  }

  try {
    await postTaskComment(clickupTaskId, "✅ Thanks — re-evaluating the task with your answers.");
  } catch (_) {}

  // Re-run the workflow with the enriched description standing in for the original
  const enrichedTask = { ...task, description: enriched, markdownDescription: enriched };
  const workflowResult = await runWorkflow(enrichedTask, { dbTaskId });
  await handlePostClarificationOutcome(dbTaskId, workflowResult);
}

/** Mirror of handleTask's outcome routing for the post-clarification re-run. */
async function handlePostClarificationOutcome(dbTaskId, workflowResult) {
  if (!dbTaskId || !workflowResult) return;

  if (workflowResult.action === "rejected") {
    await failTask(dbTaskId, {
      error: `Rejected by quality check after clarification (score: ${workflowResult.score})`,
      lastStep: "quality_check",
    }).catch(() => {});
    return;
  }

  if (workflowResult.action === "execute_directly") {
    const task = await getTaskById(dbTaskId);
    if (task) execute(task).catch((err) => logger.error({ dbTaskId, err: err.message }, "Post-clarification execution failed"));
    return;
  }

  // awaiting_clarification (another round) and approved_pending_plan need no
  // action here — their own flows take over. For skipped/no_action/error,
  // honor the execution mode like handleTask does.
  if (["awaiting_clarification", "approved_pending_plan"].includes(workflowResult.action)) return;

  if (config.get("executionMode") === "auto") {
    const task = await getTaskById(dbTaskId);
    if (task) execute(task).catch((err) => logger.error({ dbTaskId, err: err.message }, "Post-clarification auto-execution failed"));
  }
}

// ── Polling-based Approval Detection ─────────────────────────────

/**
 * Start polling for approval comments on a ClickUp task.
 * Falls back to this when webhooks don't cover taskCommentPosted events.
 *
 * @param {string} clickupTaskId
 * @param {string[]} approvalKeywords
 * @param {object} [options]
 * @param {string} [options.planCommentId] - The comment ID of the posted plan (for gating)
 */
export function startApprovalPolling(clickupTaskId, approvalKeywords, { planCommentId } = {}) {
  // Don't start duplicate pollers
  if (activePollers.has(clickupTaskId)) {
    logger.debug({ taskId: clickupTaskId }, "Approval poller already active");
    return;
  }

  let attempts = 0;
  // Use the plan posting time as the baseline — only consider comments after this
  const state = { lastSeenCommentDate: Date.now(), planCommentId };

  const intervalId = setInterval(async () => {
    attempts++;

    if (attempts > MAX_POLL_ATTEMPTS) {
      logger.warn({ taskId: clickupTaskId, attempts }, "Approval polling max attempts reached, stopping");
      stopApprovalPolling(clickupTaskId);
      return;
    }

    try {
      // Check if approval still pending in DB
      const approval = await getPendingApproval(clickupTaskId);
      if (!approval) {
        logger.info({ taskId: clickupTaskId }, "Approval no longer pending, stopping poller");
        stopApprovalPolling(clickupTaskId);
        return;
      }

      // Fetch recent comments
      const comments = await getTaskComments(clickupTaskId);
      if (!comments || comments.length === 0) return;

      // Determine the baseline time: use plan_posted_at from DB if available
      const planPostedMs = approval.plan_posted_at
        ? new Date(approval.plan_posted_at).getTime()
        : state.lastSeenCommentDate;
      const storedPlanCommentId = approval.plan_comment_id || state.planCommentId;

      // Check comments newer than the plan posting time
      for (const comment of comments) {
        const commentDate = Number(comment.date);

        // Skip comments posted before or at the plan posting time
        if (commentDate <= planPostedMs) continue;

        // Skip the plan comment itself
        if (storedPlanCommentId && comment.id === storedPlanCommentId) continue;

        const text = extractCommentTextFromComment(comment);
        if (!text) continue;

        if (matchesApprovalKeyword(text, approvalKeywords)) {
          logger.info({
            taskId: clickupTaskId,
            commentId: comment.id,
            commentDate,
            planCommentId: storedPlanCommentId,
          }, "Approval detected via polling — comment posted after plan");
          stopApprovalPolling(clickupTaskId);

          const cfg = await getWorkflowConfig();
          if (cfg) {
            await processApproval(clickupTaskId, approval, cfg);
          }
          return;
        }

        // Non-approval comment after plan — treat as change request
        // Only process if this comment hasn't been handled yet (track via lastSeenCommentDate)
        if (commentDate > state.lastSeenCommentDate) {
          logger.info({ taskId: clickupTaskId, commentId: comment.id, commentText: text.substring(0, 200) },
            "Non-approval comment detected via polling — treating as plan change request");
          await processPlanChangeRequest(clickupTaskId, approval, text);
          // Don't stop polling — continue waiting for approval of the revised plan
          return;
        }
      }

      // Update last seen timestamp (only from comments after plan)
      const postPlanComments = comments.filter((c) => Number(c.date) > planPostedMs);
      if (postPlanComments.length > 0) {
        const latestDate = Math.max(...postPlanComments.map((c) => Number(c.date)));
        if (latestDate > state.lastSeenCommentDate) {
          state.lastSeenCommentDate = latestDate;
        }
      }
    } catch (err) {
      logger.error(
        { taskId: clickupTaskId, attempt: attempts, err: err.message },
        "Approval polling iteration failed"
      );
    }
  }, POLL_INTERVAL_MS);

  activePollers.set(clickupTaskId, { intervalId, attempts: 0, planCommentId });
  logger.info(
    { taskId: clickupTaskId, intervalMs: POLL_INTERVAL_MS, maxAttempts: MAX_POLL_ATTEMPTS, planCommentId },
    "Approval polling started"
  );
}

/**
 * Stop polling for a specific task.
 */
export function stopApprovalPolling(clickupTaskId) {
  const poller = activePollers.get(clickupTaskId);
  if (poller) {
    clearInterval(poller.intervalId);
    activePollers.delete(clickupTaskId);
    logger.info({ taskId: clickupTaskId }, "Approval polling stopped");
  }
}

/**
 * Get all active pollers (for dashboard visibility).
 */
export function getActivePollers() {
  const result = [];
  for (const [taskId, { attempts }] of activePollers) {
    result.push({ taskId, attempts, maxAttempts: MAX_POLL_ATTEMPTS });
  }
  return result;
}

// ── Process Approval (shared by webhook and polling) ─────────────

async function processApproval(clickupTaskId, approval, cfg) {
  // Mark approval as consumed — use rowCount to guard against double-trigger race conditions
  try {
    const { rowCount } = await pool.query(
      `UPDATE workflow_approvals SET state = 'approved', approved_at = NOW(), updated_at = NOW()
       WHERE clickup_task_id = $1 AND state = 'pending_approval'`,
      [clickupTaskId]
    );
    if (rowCount === 0) {
      logger.info({ taskId: clickupTaskId }, "Approval already consumed (race condition guard), skipping");
      return;
    }
  } catch (err) {
    logger.error({ taskId: clickupTaskId, err: err.message }, "Failed to mark approval as consumed");
    return;
  }

  // Remove the "Awaiting Plan Approval" tag
  try {
    await removeTagFromTask(clickupTaskId, "Awaiting Plan Approval");
    logger.info({ taskId: clickupTaskId }, "Removed 'Awaiting Plan Approval' tag from ClickUp task");
  } catch (err) {
    logger.warn({ taskId: clickupTaskId, err: err.message }, "Could not remove approval tag (non-fatal)");
  }

  // Trigger the autoship pipeline by approving the existing DB task and executing directly.
  // The task already exists in 'planning' state from the approve flow — we transition it
  // to 'approved' and call execute(), bypassing handleTask() which would hit the duplicate guard.
  logger.info({ taskId: clickupTaskId }, "Triggering autoship pipeline after plan approval");
  try {
    // Find the existing task row for this ClickUp task
    const { rows } = await pool.query(
      `SELECT id FROM tasks
       WHERE clickup_task_id = $1 AND state NOT IN ('success', 'failed', 'deleted')
       ORDER BY id DESC LIMIT 1`,
      [clickupTaskId]
    );

    if (!rows[0]) {
      logger.error({ taskId: clickupTaskId }, "No active task found in DB for approved plan — cannot execute");
      return;
    }

    const dbTaskId = rows[0].id;

    // Attach the approved coding plan as custom instructions so Claude uses it
    if (approval.coding_plan) {
      await pool.query(
        `UPDATE tasks SET custom_instructions = $1, updated_at = NOW() WHERE id = $2`,
        [approval.coding_plan, dbTaskId]
      );
    }

    // Transition: planning → approved → execute
    // Guard against double-trigger race conditions: if the task is already
    // approved/running (e.g. from a near-simultaneous webhook + poll), skip
    // gracefully instead of posting a scary error comment.
    let task;
    try {
      task = await approveTask(dbTaskId);
    } catch (approveErr) {
      // Check if the task is already in a post-approval state (approved, running, success)
      const { rows: stateCheck } = await pool.query("SELECT state FROM tasks WHERE id = $1", [dbTaskId]);
      const currentState = stateCheck[0]?.state;
      if (["approved", "running", "success"].includes(currentState)) {
        logger.info(
          { taskId: clickupTaskId, dbTaskId, currentState },
          "Task already past 'planning' state (likely duplicate trigger) — skipping"
        );
        return;
      }
      // Genuinely unexpected error — re-throw to hit the outer catch
      throw approveErr;
    }

    logger.info({ taskId: clickupTaskId, dbTaskId, state: task.state }, "Task approved after plan approval, starting execution");

    // Log approval in session logs so dashboard shows it live
    await addExecutionLog(dbTaskId, "info", "approved", "Plan approved — 'Awaiting Plan Approval' tag removed, starting implementation");

    // Post acknowledgement comment
    try {
      await postTaskComment(
        clickupTaskId,
        `✅ **Plan approved** — Autoship pipeline triggered. Implementation in progress.`
      );
    } catch (_) {}

    // Fire-and-forget execution
    execute(task).catch((err) => {
      logger.error({ taskId: clickupTaskId, dbTaskId, err: err.message }, "Execution after plan approval failed");
    });

  } catch (err) {
    logger.error({ taskId: clickupTaskId, err: err.message }, "Autoship pipeline trigger failed after approval");

    // Update approval record with error
    try {
      await pool.query(
        `UPDATE workflow_approvals SET state = 'failed', error_message = $1, updated_at = NOW()
         WHERE clickup_task_id = $2 AND state = 'approved'`,
        [err.message, clickupTaskId]
      );
    } catch (_) {}

    // Post failure comment
    try {
      await postTaskComment(
        clickupTaskId,
        `❌ **Pipeline failed** after plan approval: ${err.message}\nPlease check logs and retry.`
      );
    } catch (_) {}
  }
}

/**
 * Called when a PR is successfully created for an approved workflow task.
 * Posts the PR link and updates task status.
 *
 * @param {string} clickupTaskId
 * @param {string} prUrl
 */
export async function onPrCreated(clickupTaskId, prUrl) {
  const cfg = await getWorkflowConfig();
  if (!cfg) return;

  // Update approval record
  try {
    await pool.query(
      `UPDATE workflow_approvals SET state = 'pr_created', pr_url = $1, updated_at = NOW()
       WHERE clickup_task_id = $2 AND state = 'approved'`,
      [prUrl, clickupTaskId]
    );
  } catch (err) {
    logger.warn({ taskId: clickupTaskId, err: err.message }, "Failed to update approval with PR URL");
  }

  // Update task status to pr_raised
  if (cfg.prRaisedStatus) {
    try {
      await updateTaskStatus(clickupTaskId, cfg.prRaisedStatus);
    } catch (err) {
      logger.warn({ taskId: clickupTaskId, err: err.message }, "Failed to update task to PR Raised status");
    }
  }

  // Post PR link as comment
  try {
    await postTaskComment(clickupTaskId, `🔗 **PR Created:** ${prUrl}`);
  } catch (err) {
    logger.warn({ taskId: clickupTaskId, err: err.message }, "Failed to post PR link comment");
  }
}

// ── Slack Interactive Approval ────────────────────────────────────

/**
 * Process an approval/rejection/changes-requested from Slack interactive buttons.
 *
 * @param {string} clickupTaskId
 * @param {"approved"|"rejected"|"changes_requested"} action
 * @param {string} [feedback] - Optional feedback text for changes_requested
 */
export async function processSlackApproval(clickupTaskId, action, feedback) {
  const approval = await getPendingApproval(clickupTaskId);
  if (!approval) {
    logger.info({ taskId: clickupTaskId, action }, "No pending approval found for Slack action");
    return;
  }

  const cfg = await getWorkflowConfig();
  if (!cfg) return;

  if (action === "approved") {
    logger.info({ taskId: clickupTaskId }, "Plan approved via Slack");
    await processApproval(clickupTaskId, approval, cfg);
  } else if (action === "rejected") {
    logger.info({ taskId: clickupTaskId }, "Plan rejected via Slack");
    try {
      await pool.query(
        `UPDATE workflow_approvals SET state = 'rejected', updated_at = NOW()
         WHERE clickup_task_id = $1 AND state = 'pending_approval'`,
        [clickupTaskId]
      );
    } catch (err) {
      logger.error({ taskId: clickupTaskId, err: err.message }, "Failed to mark approval as rejected");
    }
    try {
      await postTaskComment(clickupTaskId, `❌ **Plan rejected** via Slack.`);
    } catch (_) {}
    try {
      await removeTagFromTask(clickupTaskId, "Awaiting Plan Approval");
    } catch (_) {}
  } else if (action === "changes_requested") {
    logger.info({ taskId: clickupTaskId, feedback }, "Changes requested via Slack");
    try {
      await pool.query(
        `UPDATE workflow_approvals SET state = 'changes_requested', updated_at = NOW()
         WHERE clickup_task_id = $1 AND state = 'pending_approval'`,
        [clickupTaskId]
      );
    } catch (err) {
      logger.error({ taskId: clickupTaskId, err: err.message }, "Failed to mark approval as changes_requested");
    }
    const feedbackMsg = feedback ? `\n\n**Feedback:** ${feedback}` : "";
    try {
      await postTaskComment(
        clickupTaskId,
        `✏️ **Changes requested** via Slack.${feedbackMsg}\n\nPlease update the task and re-trigger.`
      );
    } catch (_) {}
    try {
      await removeTagFromTask(clickupTaskId, "Awaiting Plan Approval");
    } catch (_) {}
  }
}

// ── Plan Change Request Handler ─────────────────────────────────

/**
 * When a developer posts a non-approval comment after the plan, treat it as
 * a change request. Re-generate the plan incorporating the feedback and post
 * the revised plan for approval.
 */
async function processPlanChangeRequest(clickupTaskId, approval, feedbackText) {
  // Debounce: don't re-generate if we already processed a change request recently
  try {
    const { rows: recent } = await pool.query(
      `SELECT updated_at FROM workflow_approvals
       WHERE clickup_task_id = $1 AND state = 'pending_approval'
       ORDER BY updated_at DESC LIMIT 1`,
      [clickupTaskId]
    );
    if (recent[0]) {
      const lastUpdate = new Date(recent[0].updated_at).getTime();
      const debounceMs = 60_000; // 1 minute debounce
      if (Date.now() - lastUpdate < debounceMs) {
        logger.debug({ taskId: clickupTaskId }, "Plan change request debounced — too recent");
        return;
      }
    }
  } catch (_) {}

  logger.info({ taskId: clickupTaskId, feedback: feedbackText.substring(0, 200) },
    "Processing plan change request — re-generating plan with feedback");

  try {
    // Dynamically import plan generation service
    const { generateCodingPlan } = await import("../services/codingPlanService.js");
    const { getTaskDetails } = await import("../clickup-client.js");
    const { extractAllRepos, ensureRepoCloned } = await import("../execution-engine.js");
    const { detectProjectType, generateContextPrompt } = await import("../project-context.js");

    // Fetch fresh task details
    const task = await getTaskDetails(clickupTaskId);
    if (!task) {
      logger.error({ taskId: clickupTaskId }, "Could not fetch task for plan revision");
      return;
    }

    // Resolve repo context
    const allRepos = extractAllRepos(task);
    let repoContext = null;
    let repoName = null;
    let projectType = null;

    if (allRepos.length > 0) {
      repoName = allRepos.map((r) => r.fullName).join(", ");
      const contextParts = [];
      for (const repo of allRepos) {
        const repoPath = await ensureRepoCloned(repo.fullName);
        const projectInfo = detectProjectType(repoPath);
        if (!projectType) projectType = projectInfo.type;
        contextParts.push(generateContextPrompt(projectInfo, repoPath));
      }
      repoContext = contextParts.join("\n\n---\n\n");
    }

    // Re-generate the plan with the original plan + feedback as context
    const originalPlan = approval.coding_plan || "";
    const revisedPlan = await generateCodingPlan(task, {
      repoContext,
      repoName,
      projectType,
      revisionFeedback: feedbackText,
      previousPlan: originalPlan,
    });

    // Post the revised plan as a new comment
    const { postTaskComment: postComment } = await import("../clickup-client.js");
    const planComment = [
      `**Revised Plan** (incorporating reviewer feedback)`,
      "",
      `> **Feedback received:** ${feedbackText.substring(0, 500)}`,
      "",
      "---",
      "",
      revisedPlan,
    ].join("\n");

    const commentResponse = await postComment(clickupTaskId, planComment);
    const newPlanCommentId = commentResponse?.id || null;

    // Update the approval record with the revised plan
    await pool.query(
      `UPDATE workflow_approvals
       SET coding_plan = $1, plan_comment_id = $2, plan_posted_at = NOW(), updated_at = NOW()
       WHERE clickup_task_id = $3 AND state = 'pending_approval'`,
      [revisedPlan, newPlanCommentId, clickupTaskId]
    );

    logger.info({ taskId: clickupTaskId, newPlanCommentId },
      "Revised plan posted — awaiting approval");

    // Post acknowledgement
    await postComment(clickupTaskId,
      `Plan has been revised based on your feedback. Please review the updated plan above and approve when ready.`
    ).catch(() => {});

  } catch (err) {
    logger.error({ taskId: clickupTaskId, err: err.message },
      "Failed to process plan change request");
    try {
      await postTaskComment(clickupTaskId,
        `Failed to revise the plan based on your feedback: ${err.message}\nPlease update the task description and re-trigger, or approve the current plan.`
      );
    } catch (_) {}
  }
}

// ── Helpers ──────────────────────────────────────────────────────

async function getPendingApproval(clickupTaskId) {
  const { rows } = await pool.query(
    `SELECT * FROM workflow_approvals
     WHERE clickup_task_id = $1 AND state = 'pending_approval'
     ORDER BY created_at DESC LIMIT 1`,
    [clickupTaskId]
  );
  return rows[0] || null;
}

async function getWorkflowConfig() {
  const { rows } = await pool.query("SELECT * FROM admin_workflow_config WHERE id = 1");
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    approvalKeywords: typeof row.approval_keywords === "string"
      ? JSON.parse(row.approval_keywords)
      : row.approval_keywords || [],
    prRaisedStatus: row.pr_raised_status,
  };
}

function matchesApprovalKeyword(text, keywords) {
  const lower = text.toLowerCase().trim();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Extract comment text, ID, and date from a webhook payload.
 */
function extractCommentInfo(payload) {
  const items = payload.history_items || [];
  for (const item of items) {
    if (item.comment) {
      const text = item.comment.text_content || item.comment.comment_text || null;
      const id = item.comment.id || null;
      const date = item.comment.date || item.date || null;
      if (text) return { text, id, date };
    }
  }
  return null;
}

function extractCommentTextFromComment(comment) {
  // From ClickUp API getTaskComments response
  return comment.comment_text || comment.text_content || "";
}
