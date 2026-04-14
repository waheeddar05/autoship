// src/services/taskDecompositionService.js
// Automatic task decomposition: breaks complex tasks into ordered subtasks.
// Each subtask is executed sequentially with verification between steps.

import { providerRegistry } from "../providers/provider-registry.js";
import { logger } from "../logger.js";
import { pool } from "../db.js";

const DECOMPOSE_MODEL = process.env.DECOMPOSE_MODEL || "anthropic:claude-sonnet-4-6";
const DECOMPOSE_TIMEOUT = 60_000;

/**
 * Analyze a task and decide if it should be decomposed into subtasks.
 * Uses complexity score and AI analysis to determine decomposition.
 *
 * @param {object} params
 * @param {string} params.taskDescription - Full task description
 * @param {string} params.taskName - Task title
 * @param {number} params.complexityScore - Score from complexity.js (0-100)
 * @param {string} [params.repoContext] - Repository context
 * @param {string} [params.codingPlan] - Existing coding plan if available
 * @returns {{ shouldDecompose: boolean, subtasks: Array, reasoning: string }}
 */
export async function analyzeForDecomposition({
  taskDescription,
  taskName,
  complexityScore,
  repoContext,
  codingPlan,
}) {
  // Simple tasks don't need decomposition
  if (complexityScore < 35) {
    return {
      shouldDecompose: false,
      subtasks: [],
      reasoning: "Task complexity is low enough for single-pass execution.",
    };
  }

  const systemPrompt = `You are a senior engineer deciding whether a development task should be broken into smaller, independently verifiable subtasks.

WHEN TO DECOMPOSE:
- Task touches multiple independent systems (e.g., DB + API + UI)
- Task requires sequential steps where later steps depend on earlier ones (e.g., migration before service code)
- Task has clear logical boundaries (e.g., "add endpoint" + "add tests" + "update docs")

WHEN NOT TO DECOMPOSE:
- Task is a single cohesive change (even if complex)
- Subtasks would be too small to be meaningful (< 5 min each)
- Task is primarily a refactor within one module

If decomposition is appropriate, break the task into 2-6 subtasks ordered by dependency.

Return ONLY a valid JSON object:
{
  "shouldDecompose": <boolean>,
  "reasoning": "<why or why not>",
  "subtasks": [
    {
      "order": 1,
      "name": "<short subtask name>",
      "description": "<what to implement>",
      "type": "migration|service|api|ui|test|config|docs",
      "estimatedComplexity": "simple|medium|complex",
      "dependsOn": [],
      "verificationSteps": ["<how to verify this subtask is done correctly>"]
    }
  ]
}`;

  const userContent = buildDecomposePrompt(taskName, taskDescription, codingPlan, repoContext);

  try {
    const response = await providerRegistry.chat(DECOMPOSE_MODEL, [
      { role: "user", content: userContent },
    ], {
      systemPrompt,
      temperature: 0.2,
      maxTokens: 3000,
      timeout: DECOMPOSE_TIMEOUT,
    });

    const content = typeof response === "string" ? response : response.content || response.text || "";
    const result = parseDecomposeResponse(content);

    logger.info({
      taskName,
      shouldDecompose: result.shouldDecompose,
      subtaskCount: result.subtasks.length,
    }, "Task decomposition analysis complete");

    return result;
  } catch (err) {
    logger.error({ taskName, err: err.message }, "Task decomposition AI call failed");
    return {
      shouldDecompose: false,
      subtasks: [],
      reasoning: `Decomposition analysis failed: ${err.message}`,
    };
  }
}

/**
 * Store subtasks in the database, linked to a parent task.
 *
 * @param {number} parentTaskId - The parent task's DB id
 * @param {Array} subtasks - From analyzeForDecomposition
 * @returns {Array<object>} Created subtask records
 */
export async function storeSubtasks(parentTaskId, subtasks) {
  const created = [];
  for (const subtask of subtasks) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO task_subtasks (parent_task_id, "order", name, description, type, estimated_complexity, depends_on, verification_steps, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
         RETURNING *`,
        [
          parentTaskId,
          subtask.order,
          subtask.name,
          subtask.description,
          subtask.type,
          subtask.estimatedComplexity,
          JSON.stringify(subtask.dependsOn || []),
          JSON.stringify(subtask.verificationSteps || []),
        ]
      );
      created.push(rows[0]);
    } catch (err) {
      logger.warn({ parentTaskId, subtask: subtask.name, err: err.message }, "Failed to store subtask");
    }
  }

  logger.info({ parentTaskId, stored: created.length }, "Subtasks stored");
  return created;
}

/**
 * Get the next pending subtask for a parent task.
 * Returns null if all subtasks are complete or none exist.
 */
export async function getNextSubtask(parentTaskId) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM task_subtasks
       WHERE parent_task_id = $1 AND state = 'pending'
       ORDER BY "order" ASC
       LIMIT 1`,
      [parentTaskId]
    );
    return rows[0] || null;
  } catch (err) {
    logger.warn({ parentTaskId, err: err.message }, "Failed to get next subtask");
    return null;
  }
}

/**
 * Mark a subtask as completed.
 */
export async function completeSubtask(subtaskId, { output, verificationResult } = {}) {
  try {
    await pool.query(
      `UPDATE task_subtasks SET state = 'completed', output = $2, verification_result = $3, completed_at = NOW()
       WHERE id = $1`,
      [subtaskId, output || null, verificationResult || null]
    );
    logger.info({ subtaskId }, "Subtask completed");
  } catch (err) {
    logger.warn({ subtaskId, err: err.message }, "Failed to complete subtask");
  }
}

/**
 * Mark a subtask as failed.
 */
export async function failSubtask(subtaskId, errorMessage) {
  try {
    await pool.query(
      `UPDATE task_subtasks SET state = 'failed', error_message = $2, completed_at = NOW()
       WHERE id = $1`,
      [subtaskId, errorMessage]
    );
  } catch (err) {
    logger.warn({ subtaskId, err: err.message }, "Failed to mark subtask as failed");
  }
}

/**
 * Get all subtasks for a parent task with their current status.
 */
export async function getSubtaskProgress(parentTaskId) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM task_subtasks
       WHERE parent_task_id = $1
       ORDER BY "order" ASC`,
      [parentTaskId]
    );

    const total = rows.length;
    const completed = rows.filter(r => r.state === "completed").length;
    const failed = rows.filter(r => r.state === "failed").length;
    const pending = rows.filter(r => r.state === "pending").length;

    return {
      subtasks: rows,
      total,
      completed,
      failed,
      pending,
      allComplete: completed === total && total > 0,
      progress: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  } catch (err) {
    logger.warn({ parentTaskId, err: err.message }, "Failed to get subtask progress");
    return { subtasks: [], total: 0, completed: 0, failed: 0, pending: 0, allComplete: false, progress: 0 };
  }
}

/**
 * Build a prompt for a specific subtask that includes context from completed subtasks.
 */
export async function buildSubtaskPrompt(parentTaskId, subtask, taskDescription) {
  const { rows: completedSubtasks } = await pool.query(
    `SELECT name, description, output FROM task_subtasks
     WHERE parent_task_id = $1 AND state = 'completed'
     ORDER BY "order" ASC`,
    [parentTaskId]
  ).catch(() => ({ rows: [] }));

  const parts = [];
  parts.push(`## Parent Task\n${taskDescription}\n`);

  if (completedSubtasks.length > 0) {
    parts.push("## Previously Completed Steps");
    for (const cs of completedSubtasks) {
      parts.push(`### ✅ ${cs.name}`);
      parts.push(cs.description);
      if (cs.output) {
        parts.push(`Summary: ${cs.output.substring(0, 500)}`);
      }
      parts.push("");
    }
  }

  parts.push(`## Current Step: ${subtask.name}`);
  parts.push(subtask.description);

  if (subtask.verification_steps) {
    const steps = typeof subtask.verification_steps === "string"
      ? JSON.parse(subtask.verification_steps)
      : subtask.verification_steps;
    if (steps.length > 0) {
      parts.push("\n## Verification");
      parts.push("After implementation, verify:");
      for (const step of steps) {
        parts.push(`- ${step}`);
      }
    }
  }

  return parts.join("\n");
}

// ── Internal helpers ────────────────────────────────────────────

function buildDecomposePrompt(taskName, taskDescription, codingPlan, repoContext) {
  const parts = [];
  parts.push(`## Task: ${taskName}`);
  parts.push(taskDescription || "(No description)");

  if (codingPlan) {
    parts.push("\n## Existing Coding Plan");
    parts.push(codingPlan);
  }

  if (repoContext) {
    parts.push("\n## Repository Context");
    parts.push(repoContext.substring(0, 3000));
  }

  return parts.join("\n");
}

function parseDecomposeResponse(content) {
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      shouldDecompose: !!parsed.shouldDecompose,
      reasoning: String(parsed.reasoning || ""),
      subtasks: Array.isArray(parsed.subtasks) ? parsed.subtasks.map((st, idx) => ({
        order: st.order || idx + 1,
        name: String(st.name || `Subtask ${idx + 1}`),
        description: String(st.description || ""),
        type: String(st.type || "service"),
        estimatedComplexity: st.estimatedComplexity || "medium",
        dependsOn: Array.isArray(st.dependsOn) ? st.dependsOn : [],
        verificationSteps: Array.isArray(st.verificationSteps) ? st.verificationSteps : [],
      })) : [],
    };
  } catch {
    logger.warn({ raw: content.substring(0, 500) }, "Failed to parse decomposition JSON");
    return {
      shouldDecompose: false,
      subtasks: [],
      reasoning: "Could not parse decomposition response.",
    };
  }
}
