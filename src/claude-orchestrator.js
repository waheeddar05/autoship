// src/claude-orchestrator.js
// Thin delegation layer — routes tasks and PR reviews to the execution engine.
// Kept as the public API to avoid breaking existing imports in server.js / poller.js.

import { logger } from "./logger.js";
import { config } from "./config-manager.js";
import { enqueueTask, createPrReview, planningTask, addExecutionLog, failTask } from "./task-queue.js";
import { execute, executePrReview, getActiveSessions } from "./execution-engine.js";
import { runWorkflow } from "./orchestrators/workflowOrchestrator.js";

// ── Task handling ────────────────────────────────────────────────

/**
 * Receive a ClickUp task (from webhook or poller) and either:
 *  - Auto mode: enqueue + execute immediately
 *  - Queue mode: enqueue only (dashboard approval required)
 *
 * @param {object} clickupTask  Normalized task from getTaskDetails()
 * @param {object} opts         { source: 'webhook'|'poller' }
 * @returns {{ task, duplicate, executed? }}
 */
export async function handleTask(clickupTask, { source = "webhook" } = {}) {
  // If this task is from a workflow approval, skip the quality check workflow
  // (approval flow already ran and was approved)
  const skipWorkflow = source === "workflow_approval";

  // ── Step 0: Enqueue task IMMEDIATELY so it's visible in dashboard/session logs ──
  // This ensures the task appears in "All Tasks" and session logs start right away,
  // before any quality check, debate, or plan generation happens.
  const normalized = {
    id: clickupTask.id,
    customId: clickupTask.customId,
    name: clickupTask.name,
    description: clickupTask.description,
    markdownDescription: clickupTask.markdownDescription,
    status: clickupTask.status,
    priority: clickupTask.priority,
    tags: clickupTask.tags,
    assignees: clickupTask.assignees,
    // Preserve the full task JSON for later field extraction
    ...clickupTask,
  };

  const { task: enqueuedTask, duplicate } = await enqueueTask(normalized, { source });
  if (duplicate) {
    logger.info({ taskId: clickupTask.id }, "Task already active, skipping");
    return { task: enqueuedTask, duplicate: true };
  }

  await addExecutionLog(enqueuedTask.id, "info", "triggered", `Task triggered via ${source}`);

  // ── Step 1: Run quality check workflow if applicable ──
  if (!skipWorkflow) {
    try {
      // Transition to planning state so dashboard shows "planning in progress"
      try {
        await planningTask(enqueuedTask.id);
        await addExecutionLog(enqueuedTask.id, "info", "quality_check", "Starting quality check and planning workflow...");
      } catch (err) {
        logger.warn({ taskId: enqueuedTask.id, err: err.message }, "Could not transition to planning state");
      }

      const workflowResult = await runWorkflow(clickupTask, { dbTaskId: enqueuedTask.id });
      if (workflowResult.action === "rejected") {
        logger.info(
          { taskId: clickupTask.id, score: workflowResult.score },
          "Task rejected by quality check workflow"
        );
        // Mark the enqueued task as failed with rejection reason
        await failTask(enqueuedTask.id, {
          error: `Rejected by quality check (score: ${workflowResult.score})`,
          lastStep: "quality_check",
        }).catch(() => {});
        return { task: enqueuedTask, duplicate: false, executed: false, workflow: workflowResult };
      }
      if (workflowResult.action === "approved_pending_plan") {
        // Task is already enqueued and in planning state — just log it
        await addExecutionLog(enqueuedTask.id, "info", "planning", "Plan generated, awaiting approval before implementation");
        logger.info(
          { taskId: clickupTask.id, dbId: enqueuedTask.id, score: workflowResult.score },
          "Task approved by quality check, in planning state awaiting plan approval"
        );
        return { task: enqueuedTask, duplicate: false, executed: false, workflow: workflowResult };
      }
      if (workflowResult.action === "execute_directly") {
        // Plan was skipped for simple task — execute immediately
        await addExecutionLog(enqueuedTask.id, "info", "planning", "Plan skipped (simple task) — executing directly");
        logger.info(
          { taskId: clickupTask.id, dbId: enqueuedTask.id, score: workflowResult.score },
          "Task plan skipped, executing directly"
        );
        execute(enqueuedTask).catch((err) => {
          logger.error({ taskId: enqueuedTask.id, err: err.message }, "Direct execution failed (plan-skipped task)");
        });
        return { task: enqueuedTask, duplicate: false, executed: true, workflow: workflowResult };
      }
      // action: "skipped", "no_action", "error" — continue with normal flow
    } catch (err) {
      logger.error({ taskId: clickupTask.id, err: err.message }, "Workflow orchestrator error (continuing normal flow)");
    }
  }

  const mode = config.get("executionMode");

  if (mode === "auto") {
    // Execute immediately — fire-and-forget so we don't block the webhook response
    execute(enqueuedTask).catch((err) => {
      logger.error({ taskId: enqueuedTask.id, err: err.message }, "Auto-execution failed");
    });
    return { task: enqueuedTask, duplicate: false, executed: true };
  }

  // Queue mode: task is now in 'queued' state, waiting for dashboard approval
  logger.info({ taskId: enqueuedTask.id, state: enqueuedTask.state }, "Task queued for manual approval");
  return { task: enqueuedTask, duplicate: false, executed: false };
}

// ── PR Review handling ───────────────────────────────────────────

/**
 * Receive a GitHub PR review event.
 * If PR auto-fix is enabled, either execute immediately or queue for approval.
 */
export async function handlePrReview({ prNumber, prTitle, prUrl, branch, baseBranch, repoFullName, repoName, reviewComments }) {
  // Check if PR auto-fix is enabled
  if (!config.get("prAutoFixEnabled")) {
    logger.info({ prNumber }, "PR auto-fix disabled, skipping");
    return;
  }

  // Filter by reviewer if configured
  const reviewerFilter = config.getList("prAutoFixReviewerFilter");
  if (reviewerFilter.length > 0) {
    const filteredComments = reviewComments.filter((c) =>
      reviewerFilter.includes(c.user)
    );
    if (filteredComments.length === 0) {
      logger.info({ prNumber, filter: reviewerFilter }, "No comments from configured reviewers, skipping");
      return;
    }
    reviewComments = filteredComments;
  }

  // Store in database
  const prReviewRecord = await createPrReview({
    taskId: null, // Could be linked later via PR branch → task lookup
    prNumber,
    repoFullName,
    branch,
    reviewComments,
  });

  // Check if approval is required
  if (config.get("prAutoFixRequireApproval")) {
    logger.info({ prNumber, reviewId: prReviewRecord.id }, "PR review fix queued for approval");
    return { queued: true, reviewId: prReviewRecord.id };
  }

  // Execute immediately
  executePrReview({
    prReviewRecord,
    prNumber,
    prTitle,
    prUrl,
    branch,
    baseBranch,
    repoFullName,
    repoName,
    reviewComments,
  }).catch((err) => {
    logger.error({ prNumber, err: err.message }, "PR review fix failed");
  });

  return { queued: false, reviewId: prReviewRecord.id };
}

// Re-export for convenience
export { getActiveSessions };
