// src/test-trigger.js
// Directly test the pipeline against a real ClickUp task (bypasses poller/webhook).
// Usage: node src/test-trigger.js <clickup-task-id>

import "dotenv/config";
import { getTaskDetails } from "./clickup-client.js";
import { handleTask } from "./claude-orchestrator.js";
import { logger } from "./logger.js";

const taskId = process.argv[2];

if (!taskId) {
  console.error("Usage: node src/test-trigger.js <clickup-task-id>");
  console.error("Get a task ID from ClickUp URL: https://app.clickup.com/t/<task-id>");
  process.exit(1);
}

async function main() {
  logger.info({ taskId }, "Fetching task details...");
  const task = await getTaskDetails(taskId);

  logger.info({ taskId: task.id, name: task.name, status: task.status }, "Task loaded");
  logger.info({ customFields: task.customFields.map((f) => `${f.name}: ${f.value}`) }, "Custom fields");

  const repoField = task.customFields.find(
    (f) => f.name && f.name.toLowerCase().replace(/[\s_-]/g, "") === "repo"
  );

  if (!repoField?.value) {
    logger.error("No 'repo' custom field found on this task. Set it in ClickUp first.");
    process.exit(1);
  }

  logger.info({ repo: repoField.value }, "Repo field found, starting pipeline...");
  const result = await handleTask(task);
  logger.info(result, "Pipeline complete!");
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, "Test trigger failed");
  process.exit(1);
});
