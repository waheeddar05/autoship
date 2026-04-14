// src/prometheus.js
// Prometheus metrics exporter for AutoShip.
// Exposes metrics at GET /metrics for Prometheus scraping.

import client from "prom-client";

// Collect default Node.js metrics (memory, CPU, event loop, GC)
client.collectDefaultMetrics({ prefix: "autoship_" });

// ── Custom Metrics ──────────────────────────────────────────────

const tasksTotal = new client.Counter({
  name: "autoship_tasks_total",
  help: "Total number of tasks by status",
  labelNames: ["status"],
});

const taskDurationSeconds = new client.Histogram({
  name: "autoship_task_duration_seconds",
  help: "Task step duration in seconds",
  labelNames: ["step"],
  buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600],
});

const tokensUsedTotal = new client.Counter({
  name: "autoship_tokens_used_total",
  help: "Total tokens used by model and step",
  labelNames: ["model", "step"],
});

const costDollarsTotal = new client.Counter({
  name: "autoship_cost_dollars_total",
  help: "Total estimated cost in dollars by model",
  labelNames: ["model"],
});

const retriesTotal = new client.Counter({
  name: "autoship_retries_total",
  help: "Total number of task retries",
});

const activeSessions = new client.Gauge({
  name: "autoship_active_sessions",
  help: "Number of currently active execution sessions",
});

const debateParticipants = new client.Gauge({
  name: "autoship_debate_participants",
  help: "Number of active debate participants",
});

const queueSize = new client.Gauge({
  name: "autoship_queue_size",
  help: "Number of tasks in queue by state",
  labelNames: ["state"],
});

const testRunsTotal = new client.Counter({
  name: "autoship_test_runs_total",
  help: "Total test runs by result",
  labelNames: ["result"],
});

const autoFixAttemptsTotal = new client.Counter({
  name: "autoship_auto_fix_attempts_total",
  help: "Total PR auto-fix attempts by result",
  labelNames: ["result"],
});

const diffPreviewAccuracy = new client.Histogram({
  name: "autoship_diff_preview_accuracy",
  help: "Diff preview accuracy percentage",
  buckets: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
});

// ── Exported recording functions ────────────────────────────────

export function recordTaskComplete(status, durationMs) {
  tasksTotal.inc({ status });
  if (durationMs > 0) {
    taskDurationSeconds.observe({ step: "total" }, durationMs / 1000);
  }
}

export function recordStepDuration(step, durationMs) {
  if (durationMs > 0) {
    taskDurationSeconds.observe({ step }, durationMs / 1000);
  }
}

export function recordTokenUsage(model, step, tokens) {
  if (tokens > 0) {
    tokensUsedTotal.inc({ model: model || "unknown", step: step || "unknown" }, tokens);
  }
}

export function recordCost(model, amount) {
  if (amount > 0) {
    costDollarsTotal.inc({ model: model || "unknown" }, amount);
  }
}

export function recordRetry() {
  retriesTotal.inc();
}

export function setActiveSessions(n) {
  activeSessions.set(n);
}

export function setDebateParticipants(n) {
  debateParticipants.set(n);
}

export function setQueueSize(state, n) {
  queueSize.set({ state }, n);
}

export function recordTestRun(passed) {
  testRunsTotal.inc({ result: passed ? "passed" : "failed" });
}

export function recordAutoFixAttempt(success) {
  autoFixAttemptsTotal.inc({ result: success ? "success" : "failure" });
}

export function recordDiffPreviewAccuracy(accuracy) {
  if (accuracy >= 0) {
    diffPreviewAccuracy.observe(accuracy);
  }
}

// ── Registry access for /metrics endpoint ───────────────────────

export const register = client.register;
