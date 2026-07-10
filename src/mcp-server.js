// src/mcp-server.js
// AutoShip MCP server: drive AutoShip from Claude Code / Claude Desktop
// without opening the dashboard. Runs as a stdio MCP server alongside the
// main app, sharing the same database and configuration.
//
//   claude mcp add autoship -- node /path/to/autoship/src/mcp-server.js
//
// Tools: create_task, get_task_status, approve_plan, list_queue

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pool, initialize as initDb } from "./db.js";
import { config } from "./config-manager.js";
import { getTasksByState, getQueueCounts, getTaskCostSummary, getSteps } from "./task-queue.js";
import { createClickUpTask, generateTaskDraft } from "./task-creator-api.js";
import { processSlackApproval } from "./handlers/approvalHandler.js";
import { logger } from "./logger.js";

// MCP uses stdout for the protocol — pino must not write there
logger.level = "silent";

function textResult(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

const server = new McpServer({ name: "autoship", version: "2.0.0" });

server.tool(
  "list_queue",
  "List AutoShip tasks by state (all, received, planning, queued, approved, running, success, failed) with queue counts.",
  {
    state: z.string().optional().describe("Task state filter, default 'all'"),
    limit: z.number().optional().describe("Max tasks to return, default 20"),
  },
  async ({ state = "all", limit = 20 }) => {
    const tasks = await getTasksByState(state, { limit: Math.min(limit, 100), offset: 0 });
    const counts = await getQueueCounts();
    return textResult({
      counts,
      tasks: tasks.map((t) => ({
        id: t.id,
        clickupTaskId: t.clickup_task_id,
        name: t.name,
        state: t.state,
        repo: t.repo_full_name,
        prUrl: t.pr_url,
        error: t.error_message,
        receivedAt: t.received_at,
      })),
    });
  }
);

server.tool(
  "get_task_status",
  "Get full status for one AutoShip task: state, steps with durations, costs, PR, and error details.",
  {
    taskId: z.number().optional().describe("AutoShip DB task id"),
    clickupTaskId: z.string().optional().describe("Source task id (ClickUp id or gh-owner-repo-N)"),
  },
  async ({ taskId, clickupTaskId }) => {
    if (!taskId && !clickupTaskId) throw new Error("Provide taskId or clickupTaskId");
    const { rows } = await pool.query(
      taskId
        ? `SELECT * FROM tasks WHERE id = $1`
        : `SELECT * FROM tasks WHERE clickup_task_id = $1 ORDER BY id DESC LIMIT 1`,
      [taskId || clickupTaskId]
    );
    const task = rows[0];
    if (!task) return textResult({ found: false });

    const [steps, costs] = await Promise.all([
      getSteps(task.id).catch(() => []),
      getTaskCostSummary(task.id).catch(() => []),
    ]);

    return textResult({
      found: true,
      id: task.id,
      clickupTaskId: task.clickup_task_id,
      name: task.name,
      state: task.state,
      repo: task.repo_full_name,
      branch: task.branch_name,
      prUrl: task.pr_url,
      complexity: { score: task.complexity_score, level: task.complexity_level },
      selfReview: { score: task.self_review_score, passed: task.self_review_passed },
      failureStage: task.failure_stage,
      error: task.error_message,
      steps,
      costs,
    });
  }
);

server.tool(
  "create_task",
  "Create an AutoShip task. Generates a structured task from your prompt (title, description, acceptance criteria), creates it in ClickUp, and optionally triggers implementation immediately.",
  {
    prompt: z.string().describe("What to build, in plain language"),
    repo: z.string().optional().describe("Target repository (owner/repo or bare name)"),
    listId: z.string().optional().describe("ClickUp list id (defaults to the configured Slack intake list)"),
    run: z.boolean().optional().describe("Trigger implementation immediately (default false; requires repo)"),
  },
  async ({ prompt, repo, listId, run = false }) => {
    const targetList = listId || config.get("slackIntakeListId");
    if (!targetList) throw new Error("No listId provided and slackIntakeListId is not configured");

    const modelSpec = process.env.SLACK_INTAKE_MODEL || "anthropic:claude-sonnet-4-6";
    const draft = await generateTaskDraft({ prompt, repoFullName: repo, modelSpec });

    const result = await createClickUpTask({
      listId: targetList,
      title: draft.title,
      description: draft.description,
      tags: draft.tags,
      priority: draft.priority,
      repoFullName: repo,
      triggerImplementation: run && !!repo,
      source: "mcp",
    });

    return textResult({
      created: true,
      taskId: result.taskId,
      url: result.url,
      title: draft.title,
      implementationTriggered: result.implementationTriggered,
    });
  }
);

server.tool(
  "approve_plan",
  "Approve the pending coding plan for a task so AutoShip starts implementation (same effect as replying 'approved' on the ticket).",
  {
    clickupTaskId: z.string().describe("Source task id whose plan is awaiting approval"),
  },
  async ({ clickupTaskId }) => {
    await processSlackApproval(clickupTaskId, "approved");
    return textResult({ approved: true, clickupTaskId });
  }
);

async function main() {
  try {
    await initDb();
    await config.initFromDb(pool);
  } catch (err) {
    // Tools that need the DB will fail per-call with a clearer error
    process.stderr.write(`autoship-mcp: DB init failed: ${err.message}\n`);
  }
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`autoship-mcp: fatal: ${err.message}\n`);
  process.exit(1);
});
