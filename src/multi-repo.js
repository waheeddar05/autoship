// src/multi-repo.js
// Feature 4: Multi-Repo Orchestration
// Detects multi-repo tasks and orchestrates sub-tasks across repos.

import { pool } from "./db.js";
import { logger } from "./logger.js";
import { config } from "./config-manager.js";
import { notifySlack } from "./slack-notifier.js";
import { postTaskComment } from "./clickup-client.js";

/**
 * Parse a task description and custom fields to detect multi-repo tasks.
 */
export function parseMultiRepoTask(taskDescription, customFields) {
  const result = { isMultiRepo: false, repos: [] };

  if (!config.get("multiRepoEnabled")) return result;

  const maxRepos = config.get("multiRepoMaxRepos") || 3;

  // Check custom fields for multiple repo values
  if (customFields && Array.isArray(customFields)) {
    const repoFields = customFields.filter(
      (f) => f.name && /repo|repository/i.test(f.name.replace(/[\s_-]/g, ""))
    );

    for (const field of repoFields) {
      if (field.type === "labels" && field.value && field.value.length > 1) {
        const options = field.type_config?.options || [];
        for (const valId of field.value) {
          const opt = options.find((o) => o.id === valId);
          if (opt) {
            result.repos.push({
              name: opt.label || opt.name,
              url: null,
              role: result.repos.length === 0 ? "primary" : "secondary",
            });
          }
        }
      }
    }
  }

  // Parse description for multi-repo references
  if (result.repos.length < 2 && taskDescription) {
    const desc = taskDescription.toLowerCase();

    // Look for "frontend and backend" patterns
    const patterns = [
      /(?:frontend|front-end)\s+(?:and|&)\s+(?:backend|back-end)/i,
      /(?:backend|back-end)\s+(?:and|&)\s+(?:frontend|front-end)/i,
      /multiple\s+repos?/i,
      /across\s+repos?/i,
    ];

    const isMultiRepo = patterns.some((p) => p.test(desc));

    // Look for explicit repo references like org/repo-name
    const repoPattern = /(?:^|\s)([\w-]+\/[\w.-]+)(?:\s|$|,)/g;
    let match;
    const foundRepos = new Set();
    while ((match = repoPattern.exec(taskDescription)) !== null) {
      foundRepos.add(match[1]);
    }

    if (foundRepos.size > 1) {
      result.repos = [...foundRepos].slice(0, maxRepos).map((name, i) => ({
        name,
        url: `https://github.com/${name}`,
        role: i === 0 ? "primary" : "secondary",
      }));
    }

    if (isMultiRepo && result.repos.length < 2) {
      // Flag as multi-repo even without explicit repo names — orchestrator will handle
      result.isMultiRepo = true;
      return result;
    }
  }

  result.isMultiRepo = result.repos.length >= 2;
  return result;
}

/**
 * Orchestrate a multi-repo task: create parent record and sub-tasks.
 */
export async function orchestrateMultiRepo(taskId, repos, taskDetails) {
  const parallel = config.get("multiRepoParallel");

  logger.info({ taskId, repos: repos.map((r) => r.name), parallel }, "Starting multi-repo orchestration");

  // Mark the parent task
  await pool.query(
    "UPDATE tasks SET updated_at = NOW() WHERE id = $1",
    [taskId]
  );

  const subTaskIds = [];
  const prLinks = [];

  for (const repo of repos) {
    try {
      // Create sub-task linked to parent
      const { rows } = await pool.query(
        `INSERT INTO tasks (
          clickup_task_id, name, description, repo_full_name, repo_name,
          state, multi_repo_parent_id, received_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING *`,
        [
          taskDetails.clickup_task_id + `-${repo.name}`,
          `${taskDetails.name} [${repo.name}]`,
          taskDetails.description,
          repo.url ? repo.url.replace("https://github.com/", "") : repo.name,
          repo.name.includes("/") ? repo.name.split("/")[1] : repo.name,
          "received",
          taskId,
        ]
      );

      subTaskIds.push(rows[0].id);
      logger.info({ parentId: taskId, subTaskId: rows[0].id, repo: repo.name }, "Multi-repo sub-task created");
    } catch (err) {
      logger.error({ taskId, repo: repo.name, err: err.message }, "Failed to create sub-task");
    }
  }

  // Execute sub-tasks
  const { execute } = await import("./execution-engine.js");
  const { getTaskById } = await import("./task-queue.js");

  if (parallel) {
    // Execute all in parallel
    await Promise.allSettled(
      subTaskIds.map(async (id) => {
        const task = await getTaskById(id);
        if (task) {
          const result = await execute(task);
          if (result?.prUrl) prLinks.push({ repo: task.repo_name, prUrl: result.prUrl });
        }
      })
    );
  } else {
    // Execute sequentially
    for (const id of subTaskIds) {
      try {
        const task = await getTaskById(id);
        if (task) {
          const result = await execute(task);
          if (result?.prUrl) prLinks.push({ repo: task.repo_name, prUrl: result.prUrl });
        }
      } catch (err) {
        logger.error({ subTaskId: id, err: err.message }, "Sub-task execution failed");
      }
    }
  }

  // Post consolidated PR links to ClickUp
  if (prLinks.length > 0) {
    const prComment = [
      "🔗 **Multi-Repo PRs Created**",
      "",
      ...prLinks.map((p) => `- **${p.repo}**: ${p.prUrl}`),
    ].join("\n");

    await postTaskComment(taskDetails.clickup_task_id, prComment).catch(() => {});
  }

  // Single Slack notification with all PRs
  await notifySlack("task_completed", {
    taskName: `[Multi-Repo] ${taskDetails.name}`,
    prUrl: prLinks.map((p) => p.prUrl).join(", "),
    taskDbId: taskId,
  });

  return { subTaskIds, prLinks };
}

/**
 * Get sub-tasks for a parent multi-repo task.
 */
export async function getSubTasks(parentId) {
  const { rows } = await pool.query(
    "SELECT * FROM tasks WHERE multi_repo_parent_id = $1 ORDER BY id",
    [parentId]
  );
  return rows;
}

/**
 * Check if a task is a multi-repo parent.
 */
export async function isMultiRepoParent(taskId) {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int as count FROM tasks WHERE multi_repo_parent_id = $1",
    [taskId]
  );
  return rows[0].count > 0;
}
