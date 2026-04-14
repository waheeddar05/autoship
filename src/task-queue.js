// src/task-queue.js
// Central task lifecycle management with PostgreSQL-backed state machine.
// States: received → planning → queued → approved → running → success | failed → retrying

import { pool } from "./db.js";
import { logger } from "./logger.js";
import { config } from "./config-manager.js";
import { metrics } from "./metrics.js";
import { setQueueSize, recordRetry as prometheusRecordRetry } from "./prometheus.js";

// ── Enqueue ─────────────────────────────────────────────────────

/**
 * Enqueue a new task from webhook or poller.
 * Returns { task, duplicate } — duplicate=true if task already has an active record.
 */
export async function enqueueTask(clickupTask, { source = "webhook" } = {}) {
  const mode = config.get("executionMode");
  const initialState = mode === "queue" ? "queued" : "received";

  // Atomic upsert: INSERT ... ON CONFLICT uses the unique partial index
  // idx_tasks_active (clickup_task_id WHERE state NOT IN ('success','failed'))
  // This eliminates the SELECT+INSERT race condition entirely.
  const { rows } = await pool.query(
    `INSERT INTO tasks (
      clickup_task_id, clickup_custom_id, name, description, markdown_description,
      status, priority, tags, assignees, repo_full_name, repo_name,
      state, queued_at, clickup_task_json, triggered_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (clickup_task_id) WHERE state NOT IN ('success', 'failed', 'deleted')
    DO NOTHING
    RETURNING *`,
    [
      clickupTask.id,
      clickupTask.customId,
      clickupTask.name,
      clickupTask.description,
      clickupTask.markdownDescription,
      clickupTask.status,
      clickupTask.priority,
      JSON.stringify(clickupTask.tags || []),
      JSON.stringify(clickupTask.assignees || []),
      null, // repo resolved later by execution engine
      null,
      initialState,
      initialState === "queued" ? new Date().toISOString() : null,
      JSON.stringify(clickupTask),
      new Date().toISOString(),
    ]
  );

  // If RETURNING is empty, the ON CONFLICT fired → duplicate
  if (rows.length === 0) {
    const existing = await getActiveTask(clickupTask.id);
    logger.info({ taskId: clickupTask.id, state: existing?.state }, "Task already active, skipping duplicate");
    return { task: existing, duplicate: true };
  }

  const task = rows[0];
  logger.info({ id: task.id, clickupTaskId: task.clickup_task_id, state: task.state, source }, "Task enqueued");

  metrics._emit("queue:enqueued", { id: task.id, name: task.name, state: task.state });
  _updateQueueSizeMetrics().catch(() => {});
  return { task, duplicate: false };
}

// ── State Transitions ───────────────────────────────────────────

export async function planningTask(taskId) {
  const task = await updateTask(taskId, { state: "planning" }, ["received", "queued"]);
  logger.info({ id: taskId }, "Task moved to planning");
  metrics._emit("queue:planning", { id: task.id, name: task.name });
  return task;
}

export async function approveTask(taskId, { customInstructions } = {}) {
  const updates = { state: "approved", approved_at: new Date().toISOString() };
  if (customInstructions) updates.custom_instructions = customInstructions;

  const task = await updateTask(taskId, updates, ["queued", "received", "planning"]);
  logger.info({ id: taskId }, "Task approved");
  metrics._emit("queue:approved", { id: task.id, name: task.name });
  return task;
}

export async function rejectTask(taskId, { reason } = {}) {
  const task = await updateTask(taskId, {
    state: "failed",
    error_message: reason || "Rejected by user",
    completed_at: new Date().toISOString(),
  }, ["queued", "received", "planning"]);
  logger.info({ id: taskId, reason }, "Task rejected");
  metrics._emit("queue:rejected", { id: task.id, name: task.name });
  return task;
}

export async function startTask(taskId) {
  const task = await updateTask(taskId, {
    state: "running",
    started_at: new Date().toISOString(),
    error_message: null,
  }, ["received", "approved", "retrying"]);
  logger.info({ id: taskId }, "Task started");
  metrics._emit("queue:running", { id: task.id, name: task.name });
  return task;
}

export async function completeTask(taskId, { prUrl, prNumber, branch, claudeOutput, duration }) {
  const task = await updateTask(taskId, {
    state: "success",
    pr_url: prUrl,
    pr_number: prNumber,
    branch_name: branch,
    claude_output: claudeOutput,
    duration_ms: duration,
    completed_at: new Date().toISOString(),
  }, ["running"]);
  logger.info({ id: taskId, prUrl }, "Task completed successfully");
  metrics._emit("queue:success", { id: task.id, name: task.name, prUrl });
  return task;
}

export async function failTask(taskId, { error, lastStep }) {
  const task = await updateTask(taskId, {
    state: "failed",
    error_message: error,
    last_step: lastStep,
    completed_at: new Date().toISOString(),
  }, ["received", "planning", "approved", "running", "retrying"]);
  logger.info({ id: taskId, error }, "Task failed");
  metrics._emit("queue:failed", { id: task.id, name: task.name, error });
  return task;
}

export async function retryTask(taskId, { modifiedInstructions } = {}) {
  const current = await getTaskById(taskId);
  if (!current) throw new Error(`Task ${taskId} not found`);

  const updates = {
    state: "retrying",
    error_message: null,
    retry_count: (current.retry_count || 0) + 1,
    completed_at: null,
    started_at: null,
  };
  if (modifiedInstructions) updates.custom_instructions = modifiedInstructions;

  const task = await updateTask(taskId, updates, ["failed"]);
  logger.info({ id: taskId, retryCount: task.retry_count }, "Task queued for retry");
  metrics._emit("queue:retrying", { id: task.id, name: task.name });
  prometheusRecordRetry();
  _updateQueueSizeMetrics().catch(() => {});
  return task;
}

/**
 * Request an incremental update on a successful task.
 * Sets state back to approved so the execution engine picks it up.
 */
export async function requestUpdate(taskId, instructions) {
  const task = await updateTask(taskId, {
    state: "approved",
    custom_instructions: instructions,
    approved_at: new Date().toISOString(),
    completed_at: null,
    started_at: null,
    error_message: null,
  }, ["success"]);

  await addTaskMessage(taskId, "user", instructions);

  logger.info({ id: taskId }, "Incremental update requested");
  metrics._emit("queue:update_requested", { id: task.id, name: task.name });
  return task;
}

/**
 * Hard-delete a task (permanently removes from database).
 * Works from ANY state. Related records (messages, logs, debates) are
 * cascade-deleted via foreign key constraints.
 */
export async function deleteTask(taskId) {
  // Fetch task info before deleting (for logging / SSE broadcast)
  const { rows } = await pool.query("SELECT id, name FROM tasks WHERE id = $1", [taskId]);
  if (rows.length === 0) throw new Error(`Task ${taskId} not found`);
  const task = rows[0];

  await pool.query("DELETE FROM tasks WHERE id = $1", [taskId]);
  logger.info({ id: taskId }, "Task hard-deleted");
  metrics._emit("queue:deleted", { id: task.id, name: task.name });
  return task;
}

/**
 * Cancel a running or stuck task.
 * Works from 'running' or 'approved' states (covers stuck tasks that never started).
 */
export async function cancelTask(taskId) {
  const task = await updateTask(taskId, {
    state: "failed",
    error_message: "Cancelled by user",
    completed_at: new Date().toISOString(),
  }, ["running", "approved"]);
  logger.info({ id: taskId }, "Task cancelled");
  metrics._emit("queue:cancelled", { id: task.id, name: task.name });
  return task;
}

/**
 * Request an update on a failed task (for retry with guidance).
 * Sets state to retrying and stores the instructions.
 */
export async function requestUpdateOnFailed(taskId, instructions) {
  const current = await getTaskById(taskId);
  if (!current) throw new Error(`Task ${taskId} not found`);

  const task = await updateTask(taskId, {
    state: "retrying",
    error_message: null,
    custom_instructions: instructions,
    retry_count: (current.retry_count || 0) + 1,
    completed_at: null,
    started_at: null,
  }, ["failed"]);

  await addTaskMessage(taskId, "user", instructions);

  logger.info({ id: taskId }, "Update requested on failed task");
  metrics._emit("queue:update_on_failed", { id: task.id, name: task.name });
  return task;
}

// ── Step Tracking with Timestamps ────────────────────────────────

/**
 * Start a named step — records started_at in the task_steps JSONB array.
 */
export async function startStep(taskId, stepName) {
  const { rows } = await pool.query("SELECT task_steps FROM tasks WHERE id = $1", [taskId]);
  if (!rows[0]) return;

  const steps = rows[0].task_steps || [];
  // Check if step already exists
  const existing = steps.find(s => s.name === stepName);
  if (existing) {
    existing.started_at = new Date().toISOString();
    existing.completed_at = null;
    existing.duration_ms = null;
  } else {
    steps.push({ name: stepName, started_at: new Date().toISOString(), completed_at: null, duration_ms: null });
  }

  await pool.query(
    "UPDATE tasks SET task_steps = $1, last_step = $2, updated_at = NOW() WHERE id = $3",
    [JSON.stringify(steps), stepName, taskId]
  );
  metrics._emit("queue:step", { id: taskId, step: stepName, action: "started" });
}

/**
 * Complete a named step — records completed_at and calculates duration_ms.
 */
export async function completeStep(taskId, stepName) {
  const { rows } = await pool.query("SELECT task_steps FROM tasks WHERE id = $1", [taskId]);
  if (!rows[0]) return;

  const steps = rows[0].task_steps || [];
  const step = steps.find(s => s.name === stepName);
  if (!step) return;

  step.completed_at = new Date().toISOString();
  if (step.started_at) {
    step.duration_ms = new Date(step.completed_at).getTime() - new Date(step.started_at).getTime();
  }

  await pool.query(
    "UPDATE tasks SET task_steps = $1, updated_at = NOW() WHERE id = $2",
    [JSON.stringify(steps), taskId]
  );
  metrics._emit("queue:step", { id: taskId, step: stepName, action: "completed", duration_ms: step.duration_ms });
}

/**
 * Get the step tracking array for a task.
 */
export async function getSteps(taskId) {
  const { rows } = await pool.query("SELECT task_steps FROM tasks WHERE id = $1", [taskId]);
  return rows[0]?.task_steps || [];
}

// ── Update step (for pipeline progress tracking — legacy compat) ────

export async function updateTaskStep(taskId, step) {
  await pool.query(
    "UPDATE tasks SET last_step = $1, updated_at = NOW() WHERE id = $2",
    [step, taskId]
  );
  metrics._emit("queue:step", { id: taskId, step });
}

export async function updateTaskRepo(taskId, { repoFullName, repoName, branchName }) {
  await pool.query(
    "UPDATE tasks SET repo_full_name = $1, repo_name = $2, branch_name = $3, updated_at = NOW() WHERE id = $4",
    [repoFullName, repoName, branchName, taskId]
  );
}

// ── Queries ─────────────────────────────────────────────────────

export async function getTaskById(id) {
  const { rows } = await pool.query("SELECT * FROM tasks WHERE id = $1", [id]);
  return rows[0] || null;
}

export async function getTaskByClickupId(clickupTaskId) {
  const { rows } = await pool.query(
    "SELECT * FROM tasks WHERE clickup_task_id = $1 ORDER BY id DESC LIMIT 1",
    [clickupTaskId]
  );
  return rows[0] || null;
}

export async function getActiveTask(clickupTaskId) {
  // FIX: also exclude 'deleted' state so soft-deleted tasks don't block re-enqueue
  const { rows } = await pool.query(
    "SELECT * FROM tasks WHERE clickup_task_id = $1 AND state NOT IN ('success', 'failed', 'deleted') LIMIT 1",
    [clickupTaskId]
  );
  return rows[0] || null;
}

export async function getTasksByState(state, { limit = 50, offset = 0 } = {}) {
  if (state === "all") {
    const { rows } = await pool.query(
      "SELECT * FROM tasks ORDER BY updated_at DESC LIMIT $1 OFFSET $2",
      [limit, offset]
    );
    return rows;
  }

  const { rows } = await pool.query(
    "SELECT * FROM tasks WHERE state = $1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3",
    [state, limit, offset]
  );
  return rows;
}

export async function getQueueCounts() {
  const { rows } = await pool.query(
    `SELECT state, COUNT(*)::int as count FROM tasks GROUP BY state`
  );
  const counts = {};
  for (const r of rows) counts[r.state] = r.count;
  return counts;
}

export async function getRecentTasks(limit = 50, offset = 0) {
  const { rows } = await pool.query(
    "SELECT * FROM tasks ORDER BY COALESCE(completed_at, updated_at) DESC LIMIT $1 OFFSET $2",
    [limit, offset]
  );
  return rows;
}

/**
 * Get tasks that are ready to execute (received in auto mode, or approved/retrying).
 */
export async function getExecutableTasks() {
  const mode = config.get("executionMode");
  const states = mode === "auto"
    ? ["received", "approved", "retrying"]
    : ["approved", "retrying"];

  const { rows } = await pool.query(
    `SELECT * FROM tasks WHERE state = ANY($1) ORDER BY received_at ASC`,
    [states]
  );
  return rows;
}

// ── Chat / Messages ─────────────────────────────────────────────

export async function addTaskMessage(taskId, role, content) {
  const { rows } = await pool.query(
    `INSERT INTO task_messages (task_id, role, content) VALUES ($1, $2, $3) RETURNING *`,
    [taskId, role, content]
  );
  metrics._emit("queue:message", { taskId, role });
  return rows[0];
}

export async function getTaskMessages(taskId) {
  const { rows } = await pool.query(
    "SELECT * FROM task_messages WHERE task_id = $1 ORDER BY created_at ASC",
    [taskId]
  );
  return rows;
}

// ── Execution Logs ──────────────────────────────────────────────

export async function addExecutionLog(taskId, level, step, message, data = null) {
  await pool.query(
    `INSERT INTO execution_logs (task_id, level, step, message, data) VALUES ($1, $2, $3, $4, $5)`,
    [taskId, level, step, message, data ? JSON.stringify(data) : null]
  );
  // Broadcast via SSE so the dashboard receives live log updates without refreshing
  metrics._emit("execution_log", { taskId, level, step, message, data });
}

export async function getExecutionLogs(taskId) {
  const { rows } = await pool.query(
    "SELECT * FROM execution_logs WHERE task_id = $1 ORDER BY created_at ASC",
    [taskId]
  );
  return rows;
}

// ── PR Reviews ──────────────────────────────────────────────────

export async function createPrReview({ taskId, prNumber, repoFullName, branch, reviewComments }) {
  const { rows } = await pool.query(
    `INSERT INTO pr_reviews (task_id, pr_number, repo_full_name, branch, review_comments)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [taskId, prNumber, repoFullName, branch, JSON.stringify(reviewComments)]
  );
  return rows[0];
}

export async function updatePrReview(id, updates) {
  const setClauses = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${key} = $${idx}`);
    values.push(value);
    idx++;
  }
  values.push(id);

  const { rows } = await pool.query(
    `UPDATE pr_reviews SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );
  return rows[0];
}

export async function getPendingPrReviews() {
  const { rows } = await pool.query(
    "SELECT * FROM pr_reviews WHERE state = 'received' ORDER BY created_at ASC"
  );
  return rows;
}

// ── Debate Sessions ─────────────────────────────────────────

export async function createDebateSession(taskId, { leaderModel, participants, debateStyle, maxRounds }) {
  const { rows } = await pool.query(
    `INSERT INTO debate_sessions (task_id, leader_model, participants, debate_style, max_rounds)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [taskId, leaderModel, JSON.stringify(participants), debateStyle, maxRounds]
  );

  // Link debate session to task
  await pool.query(
    "UPDATE tasks SET debate_session_id = $1, updated_at = NOW() WHERE id = $2",
    [rows[0].id, taskId]
  );

  logger.info({ debateId: rows[0].id, taskId, leaderModel, style: debateStyle }, "Debate session created");
  return rows[0];
}

export async function updateDebateSession(id, updates) {
  updates.updated_at = new Date().toISOString();

  const setClauses = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${key} = $${idx}`);
    values.push(key === "transcript" || key === "participants" ? JSON.stringify(value) : value);
    idx++;
  }
  values.push(id);

  const { rows } = await pool.query(
    `UPDATE debate_sessions SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );

  if (!rows[0]) throw new Error(`Debate session ${id} not found`);
  return rows[0];
}

export async function getDebateSession(id) {
  const { rows } = await pool.query("SELECT * FROM debate_sessions WHERE id = $1", [id]);
  return rows[0] || null;
}

export async function getDebateSessionByTaskId(taskId) {
  const { rows } = await pool.query(
    "SELECT * FROM debate_sessions WHERE task_id = $1 ORDER BY id DESC LIMIT 1",
    [taskId]
  );
  return rows[0] || null;
}

// ── Internal Helpers ────────────────────────────────────────────

async function updateTask(taskId, updates, validFromStates = []) {
  if (validFromStates.length > 0) {
    const { rows: check } = await pool.query("SELECT state FROM tasks WHERE id = $1", [taskId]);
    if (!check[0]) throw new Error(`Task ${taskId} not found`);
    if (!validFromStates.includes(check[0].state)) {
      throw new Error(`Task ${taskId} is in state '${check[0].state}', cannot transition (valid: ${validFromStates.join(",")})`);
    }
  }

  updates.updated_at = new Date().toISOString();

  const setClauses = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${key} = $${idx}`);
    values.push(value);
    idx++;
  }
  values.push(taskId);

  const { rows } = await pool.query(
    `UPDATE tasks SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );

  if (!rows[0]) throw new Error(`Task ${taskId} not found`);
  return rows[0];
}

// ── Cost Tracking ───────────────────────────────────────────────

/**
 * Record a cost entry for a task step.
 */
export async function addTaskCost(taskId, { stepName, modelUsed, promptTokens = 0, completionTokens = 0, totalTokens = 0, estimatedCost = 0 }) {
  await pool.query(
    `INSERT INTO task_costs (task_id, step_name, model_used, prompt_tokens, completion_tokens, total_tokens, estimated_cost)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [taskId, stepName, modelUsed, promptTokens, completionTokens, totalTokens, estimatedCost]
  );
  metrics._emit("cost:recorded", { taskId, stepName, modelUsed, totalTokens, estimatedCost });
}

/**
 * Get cost summary for a task.
 */
export async function getTaskCostSummary(taskId) {
  const { rows } = await pool.query(
    `SELECT step_name, model_used, 
            SUM(prompt_tokens)::int as prompt_tokens,
            SUM(completion_tokens)::int as completion_tokens,
            SUM(total_tokens)::int as total_tokens,
            SUM(estimated_cost)::float as estimated_cost
     FROM task_costs WHERE task_id = $1
     GROUP BY step_name, model_used
     ORDER BY MIN(created_at)`,
    [taskId]
  );
  const totals = await pool.query(
    `SELECT SUM(prompt_tokens)::int as total_prompt, SUM(completion_tokens)::int as total_completion,
            SUM(total_tokens)::int as total_tokens, SUM(estimated_cost)::float as total_cost
     FROM task_costs WHERE task_id = $1`,
    [taskId]
  );
  return { steps: rows, totals: totals.rows[0] || {} };
}

/**
 * Get average costs across all tasks.
 */
export async function getAverageCosts() {
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT task_id)::int as task_count,
            COALESCE(AVG(task_total), 0)::float as avg_cost_per_task,
            COALESCE(SUM(task_total), 0)::float as total_cost
     FROM (
       SELECT task_id, SUM(estimated_cost) as task_total
       FROM task_costs GROUP BY task_id
     ) sub`
  );
  return rows[0] || { task_count: 0, avg_cost_per_task: 0, total_cost: 0 };
}

// ── Slack Thread TS ─────────────────────────────────────────────

export async function setSlackThreadTs(taskId, threadTs) {
  await pool.query(
    "UPDATE tasks SET slack_thread_ts = $1, updated_at = NOW() WHERE id = $2",
    [threadTs, taskId]
  );
}

export async function getSlackThreadTs(taskId) {
  const { rows } = await pool.query("SELECT slack_thread_ts FROM tasks WHERE id = $1", [taskId]);
  return rows[0]?.slack_thread_ts || null;
}

// ── Multi-Repo Sub-Tasks (Feature 4) ───────────────────────────

export async function createSubTask(parentId, repoOverride) {
  const parent = await getTaskById(parentId);
  if (!parent) throw new Error(`Parent task ${parentId} not found`);

  const { rows } = await pool.query(
    `INSERT INTO tasks (
      clickup_task_id, name, description, markdown_description,
      repo_full_name, repo_name, state, multi_repo_parent_id, received_at
    ) VALUES ($1, $2, $3, $4, $5, $6, 'received', $7, NOW()) RETURNING *`,
    [
      parent.clickup_task_id + `-${repoOverride.name}`,
      `${parent.name} [${repoOverride.name}]`,
      parent.description,
      parent.markdown_description,
      repoOverride.fullName || repoOverride.name,
      repoOverride.name.includes("/") ? repoOverride.name.split("/")[1] : repoOverride.name,
      parentId,
    ]
  );

  logger.info({ parentId, subTaskId: rows[0].id, repo: repoOverride.name }, "Sub-task created");
  return rows[0];
}

export async function getSubTasks(parentId) {
  const { rows } = await pool.query(
    "SELECT * FROM tasks WHERE multi_repo_parent_id = $1 ORDER BY id",
    [parentId]
  );
  return rows;
}

export async function isMultiRepoParent(taskId) {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int as count FROM tasks WHERE multi_repo_parent_id = $1",
    [taskId]
  );
  return rows[0].count > 0;
}

// ── Startup Recovery ────────────────────────────────────────────

/**
 * Recover tasks stuck in 'running' or 'planning' state after a server restart.
 * These tasks had no process executing them anymore, so we reset them to a
 * retryable state. Called once during server startup.
 */
export async function recoverStaleTasks() {
  const { rows } = await pool.query(
    `UPDATE tasks
     SET state = 'failed',
         error_message = 'Server restarted while task was in progress — ready for retry',
         completed_at = NOW(),
         updated_at = NOW()
     WHERE state IN ('running', 'planning')
     RETURNING id, name, state`
  );

  if (rows.length > 0) {
    for (const t of rows) {
      logger.warn({ id: t.id, name: t.name }, "Recovered stale task after restart");
      metrics._emit("queue:recovered", { id: t.id, name: t.name });
    }
    logger.info({ count: rows.length }, `Recovered ${rows.length} stale task(s) from interrupted state`);
  }

  return rows;
}

// ── Prometheus Queue Size Helper ────────────────────────────────

async function _updateQueueSizeMetrics() {
  try {
    const counts = await getQueueCounts();
    for (const [state, count] of Object.entries(counts)) {
      setQueueSize(state, count);
    }
  } catch {}
}
