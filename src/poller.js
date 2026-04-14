// src/poller.js
// Polls ClickUp lists for new unprocessed tasks and dispatches them via the task queue.

import { logger } from "./logger.js";
import { getListTasks, getTaskDetails } from "./clickup-client.js";
import { handleTask } from "./claude-orchestrator.js";
import { config } from "./config-manager.js";
import { getActiveTask } from "./task-queue.js";
import { getAssigneeIds } from "./assignee-resolver.js";
import { extractExecutionMode } from "./execution-engine.js";

// ── Polling logic ────────────────────────────────────────────────

async function pollOnce() {
  const listIds = config.getList("clickupListIds");
  const assigneeIds = await getAssigneeIds();
  const primaryAssignee = assigneeIds[0];
  const triggerStatuses = config.getList("triggerStatuses");

  if (listIds.length === 0) {
    // Fallback to env var for backward compatibility
    const envListId = process.env.CLICKUP_LIST_ID;
    if (envListId) listIds.push(envListId);
    else {
      logger.debug("No list IDs configured for polling");
      return;
    }
  }

  for (const listId of listIds) {
    logger.info({ listId, assignee: primaryAssignee }, "Polling for new tasks...");

    try {
      const tasks = await getListTasks(listId, {
        assigneeId: primaryAssignee,
        statuses: triggerStatuses,
      });

      for (const task of tasks) {
        // Skip if already active in the queue
        const existing = await getActiveTask(task.id);
        if (existing) {
          logger.debug({ taskId: task.id }, "Task already in queue, skipping");
          continue;
        }

        // Check execution mode custom field OR trigger tag (same logic as webhook handler)
        const executionMode = extractExecutionMode(task);
        if (executionMode === "autoship") {
          logger.info({ taskId: task.id, executionMode }, "[POLLER] ✅ Execution Mode = autoship — trigger confirmed");
        } else {
          const triggerTag = config.get("triggerTag") || "autoship";
          const taskTags = task.tags.map(t => typeof t === "string" ? t.toLowerCase() : (t.name || "").toLowerCase());
          if (!taskTags.includes(triggerTag.toLowerCase())) {
            logger.debug(
              { taskId: task.id, name: task.name, executionMode: executionMode || "(not set)", tags: taskTags, triggerTag },
              `[POLLER] Skipping task: Execution Mode is "${executionMode || "not set"}" and tags don't include "${triggerTag}"`
            );
            continue;
          }
          logger.info({ taskId: task.id, triggerTag }, "[POLLER] ✅ Trigger tag found");
        }

        // Check assignment against all connected users
        const isAssigned = task.assignees.some(
          (a) => assigneeIds.includes(String(a.id))
        );
        if (!isAssigned) {
          logger.debug({ taskId: task.id }, "Task not assigned to configured user(s), skipping");
          continue;
        }

        logger.info(
          { taskId: task.id, name: task.name, status: task.status },
          "Processing new task from poll"
        );

        try {
          const fullTask = await getTaskDetails(task.id);
          await handleTask(fullTask, { source: "poller" });
        } catch (err) {
          logger.error({ taskId: task.id, err: err.message }, "Task processing failed from poller");
        }
      }
    } catch (err) {
      logger.error({ err: err.message, listId }, "Polling cycle failed");
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────

export async function startPoller() {
  const pollInterval = config.get("pollInterval");
  const listIds = config.getList("clickupListIds");
  const envListId = process.env.CLICKUP_LIST_ID;

  logger.info("═══════════════════════════════════════════════════");
  logger.info("  ClickUp Poller Started");
  logger.info("═══════════════════════════════════════════════════");
  logger.info(`  List IDs:      ${listIds.length > 0 ? listIds.join(", ") : envListId || "none"}`);
  logger.info(`  Poll interval: ${pollInterval / 1000}s`);
  logger.info("═══════════════════════════════════════════════════");

  // Run immediately on start
  await pollOnce();

  // Then schedule at interval
  setInterval(() => pollOnce(), pollInterval);
}
