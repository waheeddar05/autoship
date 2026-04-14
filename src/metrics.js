// src/metrics.js
// Collects pipeline metrics, events, and logs for the dashboard.
// Reads historical data from PostgreSQL; keeps in-memory log buffer and SSE events.

import { EventEmitter } from "node:events";

const MAX_LOGS = 500;

class MetricsCollector extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this.startedAt = new Date().toISOString();
  }

  // ── Log capture ──────────────────────────────────────────────

  #logs = [];

  pushLog(level, message, data = {}) {
    const entry = { ts: new Date().toISOString(), level, message, data };
    this.#logs.unshift(entry);
    if (this.#logs.length > MAX_LOGS) this.#logs.length = MAX_LOGS;
    this._emit("log", entry);
  }

  getRecentLogs(limit = 100) {
    return this.#logs.slice(0, limit);
  }

  // ── Legacy task events (still used by execution engine for SSE) ──

  taskStarted(data) { this._emit("task:started", data); }
  taskStep(data) { this._emit("task:step", data); }
  taskCompleted(data) { this._emit("task:completed", data); }
  taskFailed(data) { this._emit("task:failed", data); }
  taskNoChanges(data) { this._emit("task:no_changes", data); }
  prReviewStarted(data) { this._emit("pr:started", data); }
  prReviewCompleted(data) { this._emit("pr:completed", data); }
  prReviewFailed(data) { this._emit("pr:failed", data); }

  // ── Snapshot for dashboard ──────────────────────────────────

  getSnapshot() {
    return {
      uptime: process.uptime(),
      startedAt: this.startedAt,
    };
  }

  // ── Internal ────────────────────────────────────────────────

  _emit(event, data) {
    this.emit("event", { type: event, data, ts: new Date().toISOString() });
  }
}

export const metrics = new MetricsCollector();
