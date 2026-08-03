// src/execution-engine.js
// Execution engine: runs the full pipeline for tasks and PR reviews.
// Extracted from claude-orchestrator.js with database-backed state management.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";
import { postTaskComment, updateTaskStatus, removeTagFromTask } from "./task-source-router.js";
import { config } from "./config-manager.js";
import { metrics } from "./metrics.js";
import { notifySlack, sendSlackText } from "./slack-notifier.js";
import {
  startTask, completeTask, failTask, updateTaskStep, updateTaskRepo,
  addExecutionLog, addTaskMessage, updatePrReview,
  startStep, completeStep, addTaskCost, getTaskById, retryTask,
} from "./task-queue.js";
import { onPrCreated } from "./handlers/approvalHandler.js";
import {
  formatBranchName, formatPrTitle, formatCommitMessage,
  buildPrBody, buildPrompt, buildIncrementalPrompt, buildPrReviewPrompt,
  injectDebatePlan, generateRunId, extractActionSummary,
} from "./format-helpers.js";
import { getDebateSession, getDebateSessionByTaskId, setSlackThreadTs } from "./task-queue.js";
import { recordTaskComplete, recordStepDuration, recordTokenUsage, recordCost, recordRetry, setActiveSessions as setPrometheusActiveSessions, setQueueSize } from "./prometheus.js";
import { detectProjectType, generateContextPrompt } from "./project-context.js";
import { indexRepository, getRelevantContext } from "./codebase-index.js";
import { getHistoricalInsights, recordPROutcome, recordAutoFixAttempt } from "./learning.js";
import { generateFixFromReview } from "./services/prAutoFixService.js";
import { runTests } from "./services/testRunnerService.js";
import { recordTestRun, recordAutoFixAttempt as recordAutoFixMetric, recordDiffPreviewAccuracy as recordDiffAccuracyMetric } from "./prometheus.js";
import { comparePredictedVsActual } from "./services/diffPreviewService.js";
import { scoreComplexity, getTimeoutForComplexity } from "./complexity.js";
import { resolveToken, getOrgAdminToken } from "./integrations/resolveToken.js";
import { checkCostAnomaly } from "./services/costAnomalyService.js";
import { buildCodebaseGraph, formatGraphContext } from "./services/codebaseGraphService.js";
import { findSimilarPRs, formatSimilarPRsContext } from "./services/prHistoryMiningService.js";
import { getRepoLessons } from "./services/learningPipelineService.js";
import { registerPromptVariant, generateVariantHash } from "./services/promptEvolutionService.js";
import { getNextSubtask, getSubtaskProgress, completeSubtask, failSubtask, buildSubtaskPrompt, resetSubtasks } from "./services/taskDecompositionService.js";
import { createMultiPrPlan, completePrPlanEntry, failPrPlanEntry, getNextPrToExecute } from "./services/multiPrOrchestrationService.js";
import { reviewGeneratedCode, formatReviewFindings } from "./services/selfReviewService.js";
import { analyzeFailure } from "./services/failureAnalysisService.js";
import { captureScreenshots, formatScreenshotsMarkdown, isFrontendProject } from "./services/visualVerificationService.js";

const REPOS_BASE_DIR = process.env.REPOS_BASE_DIR || "/app/repos";
const GITHUB_ORG = process.env.GITHUB_ORG || "your-github-org";

/**
 * Safely checkout a branch by stashing any local changes first.
 * Prevents "Your local changes would be overwritten by checkout" errors.
 */
async function safeCheckout(branch, repoPath) {
  await runCommand("git", ["stash", "--include-untracked"], repoPath).catch(() => {});
  await runCommand("git", ["checkout", branch], repoPath);
  // Drop the stash — these are leftover artifacts from previous runs, not user work
  await runCommand("git", ["stash", "drop"], repoPath).catch(() => {});
}

/**
 * Build the git clone URL. Uses HTTPS + token on server,
 * falls back to SSH for local development.
 * @param {string} repoFullName - e.g. "org/repo"
 * @param {string} [githubToken] - Optional per-user token. Falls back to GITHUB_TOKEN env var.
 */
export function getCloneUrl(repoFullName, githubToken) {
  const token = githubToken || process.env.GITHUB_TOKEN;
  if (token) {
    return `https://x-access-token:${token}@github.com/${repoFullName}.git`;
  }
  return `git@github.com:${repoFullName}.git`;
}

/**
 * Ensure a repo is cloned locally. Clones if missing, fetches if present.
 * When a githubToken is provided, the remote URL is updated to use it.
 * @param {string} repoFullName - e.g. "org/repo"
 * @param {string} [githubToken] - Optional per-user token for auth.
 * @returns {Promise<string>} Local repo path.
 */
export async function ensureRepoCloned(repoFullName, githubToken) {
  const repoName = repoFullName.includes("/") ? repoFullName.split("/")[1] : repoFullName;
  const repoPath = path.join(REPOS_BASE_DIR, repoName);

  if (!existsSync(repoPath)) {
    logger.info({ repoPath, repo: repoFullName }, "Cloning repo for context...");
    const cloneUrl = getCloneUrl(repoFullName, githubToken);
    await runCommand("git", ["clone", cloneUrl, repoName], REPOS_BASE_DIR, { timeout: 120_000 });
  } else {
    // If a per-user token was resolved, update the remote URL so push uses it
    if (githubToken) {
      const newUrl = getCloneUrl(repoFullName, githubToken);
      await runCommand("git", ["remote", "set-url", "origin", newUrl], repoPath).catch((err) => {
        logger.warn({ repoPath, err: err.message }, "Failed to set remote URL with user token (non-fatal)");
      });
    }
    await runCommand("git", ["fetch", "origin"], repoPath).catch((err) => {
      logger.warn({ repoPath, err: err.message }, "Git fetch failed (non-fatal)");
    });
  }

  // Setup git-ai hooks for AI code metrics tracking (best-effort)
  await setupGitAiHooks(repoPath);

  return repoPath;
}

/**
 * Setup git-ai hooks and note pushing for AI code metrics tracking.
 * git-ai silently tags each commit with which AI tool helped write it.
 * Notes are pushed alongside code so the CI metrics workflow can classify commits.
 * @param {string} repoPath - Local repo path
 */
async function setupGitAiHooks(repoPath) {
  try {
    // Check if git-ai is available
    await runCommand("git-ai", ["--version"], repoPath, { timeout: 5_000 });

    // Install hooks (idempotent — safe to run multiple times)
    await runCommand("git-ai", ["install"], repoPath, { timeout: 10_000 });

    // Enable automatic note pushing so CI can read AI attribution
    // This configures: git config remote.origin.push "+refs/notes/ai:refs/notes/ai"
    await runCommand("git", ["config", "remote.origin.push", "+refs/notes/ai:refs/notes/ai"], repoPath, { timeout: 5_000 }).catch(() => {
      // Some git versions don't support multi-value push refspec via config; try notes.rewriteRef instead
      return runCommand("git", ["config", "notes.rewriteRef", "refs/notes/ai"], repoPath, { timeout: 5_000 });
    });

    // Fetch existing AI notes from remote (best-effort)
    await runCommand("git", ["fetch", "origin", "refs/notes/ai:refs/notes/ai"], repoPath, { timeout: 15_000 }).catch(() => {});

    logger.info({ repoPath }, "git-ai hooks installed and note pushing configured");
  } catch (err) {
    // git-ai not installed or failed — completely non-fatal
    logger.debug({ repoPath, err: err.message }, "git-ai setup skipped (not installed or failed)");
  }
}

/**
 * Resolve the git author (name + email) for a task based on its assignees.
 * Looks up the first assignee's ClickUp user ID → AutoShip user → name + email.
 * Returns env vars for GIT_AUTHOR_NAME/EMAIL so commits show "User authored and AutoShip committed".
 * @param {object} taskRecord - Task row from the database (with assignees JSONB).
 * @returns {Promise<{ GIT_AUTHOR_NAME: string, GIT_AUTHOR_EMAIL: string } | null>}
 */
async function resolveGitAuthor(taskRecord) {
  const assignees = taskRecord.assignees || [];
  if (assignees.length === 0) return null;

  try {
    const { pool: dbPool } = await import("./db.js");
    for (const assignee of assignees) {
      const clickupUserId = String(assignee.id);
      const { rows } = await dbPool.query(
        "SELECT name, email FROM users WHERE clickup_user_id = $1",
        [clickupUserId]
      );
      if (rows.length > 0 && rows[0].email) {
        return {
          GIT_AUTHOR_NAME: rows[0].name || rows[0].email.split("@")[0],
          GIT_AUTHOR_EMAIL: rows[0].email,
        };
      }
    }

    // Fallback: use ClickUp assignee username if no DB match
    const first = assignees[0];
    if (first.username) {
      return {
        GIT_AUTHOR_NAME: first.username,
        GIT_AUTHOR_EMAIL: `${first.username}@users.noreply.clickup.com`,
      };
    }
  } catch (err) {
    logger.debug({ err: err.message }, "Git author resolution failed (non-fatal)");
  }

  return null;
}

// Track active sessions for concurrency control
const activeSessions = new Map();

// ── Per-user GitHub token resolution ─────────────────────────────

/**
 * Resolve the GitHub token for a task based on its ClickUp assignees.
 * Looks up the first assignee's clickup_user_id → AutoShip user → user's GitHub token.
 * Falls back to org admin token, then to GITHUB_TOKEN env var.
 * @param {object} taskRecord - Task row from the database (with assignees JSONB).
 * @returns {Promise<{ token: string|null, source: string }>}
 */
async function resolveGitHubTokenForTask(taskRecord) {
  const assignees = taskRecord.assignees || [];
  if (assignees.length === 0) {
    logger.debug({ taskId: taskRecord.id }, "No assignees on task, using env token");
    return { token: null, source: "env" };
  }

  // Try each assignee until we find one with a connected GitHub account
  const { pool: dbPool } = await import("./db.js");
  for (const assignee of assignees) {
    const clickupUserId = String(assignee.id);
    const { rows } = await dbPool.query(
      "SELECT id FROM users WHERE clickup_user_id = $1",
      [clickupUserId]
    );

    if (rows.length > 0) {
      const autoshipUserId = rows[0].id;
      try {
        const { token, source } = await resolveToken(autoshipUserId, "github");
        logger.info(
          { taskId: taskRecord.id, clickupUserId, autoshipUserId, source },
          `Resolved GitHub token for task assignee (source: ${source})`
        );
        return { token, source };
      } catch (_) {
        // User exists but has no GitHub integration — try next assignee or fall through
        logger.debug(
          { taskId: taskRecord.id, clickupUserId, autoshipUserId },
          "Assignee found but no GitHub integration, trying next"
        );
      }
    }
  }

  // No assignee matched — try org admin token
  try {
    const orgToken = await getOrgAdminToken("github");
    logger.info({ taskId: taskRecord.id }, "Using org admin GitHub token (no assignee match)");
    return { token: orgToken, source: "org_fallback" };
  } catch (_) {
    // No org token either — fall back to env var
    logger.info({ taskId: taskRecord.id }, "No per-user or org GitHub token, using GITHUB_TOKEN env var");
    return { token: null, source: "env" };
  }
}

// ── Repo field extraction (from ClickUp custom fields) ──────────

/**
 * Extract the "Execution Mode" custom field value from a task.
 * Returns the lowercase value (e.g. "autoship") or null if not set.
 */
export function extractExecutionMode(taskJson) {
  if (!taskJson?.customFields) return null;
  const fieldNames = ["executionmode", "execution_mode", "execution mode"];

  let field = null;
  for (const target of fieldNames) {
    field = taskJson.customFields.find(
      (f) => f.name && f.name.toLowerCase().replace(/[\s_-]/g, "") === target.replace(/[\s_-]/g, "")
    );
    if (field) break;
  }

  if (!field) return null;

  // Drop-down type
  if (field.type === "drop_down") {
    const orderindex = field.value;
    if (orderindex === null || orderindex === undefined) return null;
    const options = field.type_config?.options || [];
    const selected = options.find((o) => o.orderindex === orderindex);
    return selected ? selected.name.toLowerCase().trim() : null;
  }

  // Labels type
  if (field.type === "labels") {
    const values = field.value || [];
    if (values.length === 0) return null;
    const options = field.type_config?.options || [];
    const selected = options.find((o) => o.id === values[0]);
    return selected ? (selected.label || selected.name).toLowerCase().trim() : null;
  }

  // Text type
  if (field.value && typeof field.value === "string") {
    return field.value.toLowerCase().trim();
  }

  return null;
}

export function extractRepoField(taskJson) {
  if (!taskJson || !taskJson.customFields) return null;
  const fieldNames = ["repo", "repository", "githubrepo", "reponame"];

  let repoField = null;
  for (const target of fieldNames) {
    repoField = taskJson.customFields.find(
      (f) => f.name && f.name.toLowerCase().replace(/[\s_-]/g, "") === target
    );
    if (repoField) break;
  }

  if (!repoField) return null;

  if (repoField.type === "drop_down") {
    const orderindex = repoField.value;
    if (orderindex === null || orderindex === undefined) return null;
    const options = repoField.type_config?.options || [];
    const selected = options.find((o) => o.orderindex === orderindex);
    if (!selected) return null;
    return parseRepoValue(selected.name);
  }

  // Labels / multiselect — return first selected, but store all for multi-repo
  if (repoField.type === "labels") {
    const values = repoField.value || [];
    if (values.length === 0) return null;
    const options = repoField.type_config?.options || [];
    const selected = options.find((o) => o.id === values[0]);
    return selected ? parseRepoValue(selected.label || selected.name) : null;
  }

  if (!repoField.value || typeof repoField.value !== "string") return null;
  return parseRepoValue(repoField.value);
}

/**
 * Extract ALL repos from a multiselect "Repo" custom field.
 * Returns array of parsed repo objects, or single-element array from other field types.
 */
export function extractAllRepos(taskJson) {
  if (!taskJson?.customFields) return [];
  const fieldNames = ["repo", "repository", "githubrepo", "reponame"];

  let repoField = null;
  for (const target of fieldNames) {
    repoField = taskJson.customFields.find(
      (f) => f.name && f.name.toLowerCase().replace(/[\s_-]/g, "") === target
    );
    if (repoField) break;
  }

  if (!repoField) return [];

  // Labels / multiselect — return ALL selected
  if (repoField.type === "labels") {
    const values = repoField.value || [];
    if (values.length === 0) return [];
    const options = repoField.type_config?.options || [];
    return values
      .map((v) => {
        const opt = options.find((o) => o.id === v);
        return opt ? parseRepoValue(opt.label || opt.name) : null;
      })
      .filter(Boolean);
  }

  // Single value types — wrap in array
  const single = extractRepoField(taskJson);
  return single ? [single] : [];
}

function parseRepoValue(raw) {
  if (!raw) return null;
  let value = String(raw).trim();
  if (!value) return null;

  value = value
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

  if (value.includes("/")) {
    const [org, name] = value.split("/");
    return { org, name, fullName: `${org}/${name}` };
  }

  const org = config.get("githubOrg") || GITHUB_ORG;
  return { org, name: value, fullName: `${org}/${value}` };
}

// ── Shell command runner ────────────────────────────────────────

function runCommand(cmd, args, cwd, { timeout = 60_000, env: extraEnv } = {}) {
  return new Promise((resolve, reject) => {
    logger.debug({ cmd, args: args.join(" "), cwd }, "Running command");
    const proc = spawn(cmd, args, {
      cwd,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
      timeout,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`"${cmd} ${args.join(" ")}" failed (code ${code}): ${stderr.slice(0, 500)}`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on("error", (err) => reject(err));
  });
}

// ── Claude Code subprocess ──────────────────────────────────────

/**
 * Map Claude Code tool names to human-readable activity labels.
 * Paths are shown relative to the repo root — the absolute container path
 * is noise for anyone reading the session log.
 */
const TOOL_ACTIVITY_MAP = {
  Read: (input, cwd) => `📖 Reading ${relPath(input?.file_path, cwd)}`,
  Write: (input, cwd) => `📝 Writing ${relPath(input?.file_path, cwd)}`,
  Edit: (input, cwd) => `✏️ Editing ${relPath(input?.file_path, cwd)}`,
  MultiEdit: (input, cwd) => `✏️ Editing ${relPath(input?.file_path, cwd)} (multiple edits)`,
  Bash: (input) => `🖥️ Running \`${(input?.command || "").replace(/\s+/g, " ").substring(0, 80)}\``,
  Glob: (input) => `🔍 Searching files: ${input?.pattern || ""}`,
  Grep: (input) => `🔍 Searching for: ${(input?.pattern || "").substring(0, 60)}`,
  TodoWrite: (input) => {
    const todos = Array.isArray(input?.todos) ? input.todos : [];
    if (todos.length === 0) return `📋 Updating task list`;
    const done = todos.filter((t) => t.status === "completed").length;
    const current = todos.find((t) => t.status === "in_progress");
    const currentNote = current ? ` — now: ${String(current.content || "").substring(0, 80)}` : "";
    return `📋 Progress: ${done}/${todos.length} steps done${currentNote}`;
  },
  Agent: (input) => `🤖 Spawning sub-agent: ${(input?.prompt || "").substring(0, 60)}`,
};

function relPath(filePath, cwd) {
  if (!filePath) return "file";
  if (cwd) {
    // Match on the directory boundary so a sibling repo sharing a name
    // prefix (web vs web-admin) isn't mangled into "-admin/…".
    const prefix = cwd.endsWith("/") ? cwd : cwd + "/";
    if (filePath.startsWith(prefix)) return filePath.slice(prefix.length) || filePath;
  }
  return filePath;
}

/**
 * Condense an assistant text block into a single narration line — Claude
 * explaining in its own words what it's doing and why. These make the
 * session log read like Claude Code's output instead of a raw tool trace.
 */
function narrationLine(text) {
  if (!text) return null;
  const line = String(text).split("\n").map((l) => l.trim()).find((l) => l.length > 2);
  if (!line) return null;
  const clean = line.replace(/^#{1,6}\s+/, "").replace(/\*\*/g, "");
  return clean.length > 180 ? clean.slice(0, 177) + "…" : clean;
}

// Live Claude Code child processes keyed by task DB id, so cancelExecution
// can actually terminate the run instead of just forgetting the session.
const activeProcesses = new Map(); // taskId → Set<ChildProcess>

function registerProcess(taskId, proc) {
  if (taskId == null) return;
  let set = activeProcesses.get(taskId);
  if (!set) {
    set = new Set();
    activeProcesses.set(taskId, set);
  }
  set.add(proc);
}

function unregisterProcess(taskId, proc) {
  if (taskId == null) return;
  const set = activeProcesses.get(taskId);
  if (!set) return;
  set.delete(proc);
  if (set.size === 0) activeProcesses.delete(taskId);
}

// Approximate per-token pricing (USD) for live budget enforcement only —
// authoritative cost still comes from Claude Code's total_cost_usd
const MODEL_PRICING = [
  { match: /opus/i, input: 15e-6, output: 75e-6 },
  { match: /sonnet/i, input: 3e-6, output: 15e-6 },
  { match: /haiku/i, input: 0.8e-6, output: 4e-6 },
];

function estimateModelCost(model, inputTokens, outputTokens) {
  const p = MODEL_PRICING.find((x) => x.match.test(model || "")) || MODEL_PRICING[1];
  return inputTokens * p.input + outputTokens * p.output;
}

function runClaudeCode(prompt, cwd, { modelOverride, onActivity, taskId, budgetUsd } = {}) {
  return new Promise((resolve, reject) => {
    const claudePath = process.env.CLAUDE_CODE_PATH || "claude";
    // executionModel is the canonical config for which model to use for implementation.
    // NEVER fall back to claudeModel — that is a legacy/dashboard display key and may
    // hold a different model (e.g. Sonnet when the user explicitly configured Opus for execution).
    const model = modelOverride || config.get("executionModel") || "claude-opus-4-6";
    const timeout = config.get("claudeTimeout");
    const skipPerms = config.get("skipPermissions");

    // Use stream-json for real-time activity tracking when a callback is provided
    const useStreaming = typeof onActivity === "function";
    const args = ["--print", "--output-format", useStreaming ? "stream-json" : "json", "--model", model];
    // stream-json requires --verbose flag
    if (useStreaming) args.push("--verbose");
    if (skipPerms) args.push("--dangerously-skip-permissions");

    // Build clean env for Claude Code subprocess
    // Ensure ANTHROPIC_API_KEY is available for headless server auth
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_SESSION;
    // Headless/CI environment — suppress all interactive prompts and non-essential traffic
    cleanEnv.CI = "true";
    cleanEnv.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY = "1";
    cleanEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    cleanEnv.DISABLE_AUTOUPDATER = "1";
    cleanEnv.DISABLE_TELEMETRY = "1";
    cleanEnv.CLAUDE_CODE_HIDE_ACCOUNT_INFO = "1";

    logger.info({ claudePath, model, cwd, promptLength: prompt.length, timeout, streaming: useStreaming, hasApiKey: !!cleanEnv.ANTHROPIC_API_KEY }, "Spawning Claude Code");

    const proc = spawn(claudePath, args, { cwd, shell: false, env: cleanEnv, timeout });
    registerProcess(taskId, proc);

    proc.stdin.write(prompt);
    proc.stdin.end();

    let output = "";          // accumulated only in non-streaming (json) mode
    let stderr = "";
    let lastActivity = Date.now();

    // For stream-json: track the final result and usage across streamed lines.
    // We intentionally do NOT accumulate the full verbose output — it can be
    // multiple megabytes of NDJSON and causes severe memory pressure / OOM.
    // Instead we only keep: streamResult (final text), streamUsage (cost/token
    // data), and streamOutputBytes (for heartbeat logging / empty-output check).
    let streamResult = null;
    let streamUsage = null;
    let streamOutputBytes = 0;
    let lineBuffer = "";
    let lastNarration = "";

    // Live budget enforcement (streaming mode only): accumulate tokens from
    // per-message usage and kill the run when estimated spend crosses budget
    let liveInputTokens = 0;
    let liveOutputTokens = 0;
    let liveEstimatedCost = 0;

    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - lastActivity) / 1000);
      const size = useStreaming ? streamOutputBytes : output.length;
      logger.info({ outputLength: size, secondsSinceLastOutput: elapsed }, "Claude Code still running...");
    }, 60_000);

    proc.stdout.on("data", (data) => {
      const chunk = data.toString();
      lastActivity = Date.now();

      if (!useStreaming) {
        // Non-streaming: accumulate full output for JSON parsing later
        output += chunk;
      } else {
        // Streaming: only track byte count, don't accumulate the raw output
        streamOutputBytes += chunk.length;
      }

      if (useStreaming) {
        // Parse NDJSON lines for real-time tool activity.
        // lineBuffer holds only the current incomplete line — not the full output.
        lineBuffer += chunk;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop(); // Keep incomplete last line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            // Live budget: track spend as each assistant message streams in
            if (budgetUsd > 0 && event.type === "assistant" && event.message?.usage && !proc.budgetExceeded) {
              const u = event.message.usage;
              liveInputTokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
              liveOutputTokens += u.output_tokens || 0;
              liveEstimatedCost = estimateModelCost(model, liveInputTokens, liveOutputTokens);
              if (liveEstimatedCost > budgetUsd) {
                proc.budgetExceeded = true;
                proc.budgetDetail = { estimated: liveEstimatedCost, budget: budgetUsd, inputTokens: liveInputTokens, outputTokens: liveOutputTokens };
                logger.warn({ taskId, ...proc.budgetDetail }, "Live budget exceeded — terminating Claude Code run");
                try { onActivity(`💸 Budget exceeded (~$${liveEstimatedCost.toFixed(2)} > $${budgetUsd.toFixed(2)}) — stopping run`); } catch (_) {}
                try { proc.kill("SIGTERM"); } catch (_) {}
              }
            }

            // Extract real-time activity: Claude's own narration (text blocks)
            // plus tool use events. Narration explains the functional intent
            // ("Adding validation to the login handler…"); tool lines show the
            // mechanical action. Together they make the session log readable.
            if (event.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text") {
                  const line = narrationLine(block.text);
                  if (line && line !== lastNarration) {
                    lastNarration = line;
                    try { onActivity(`💬 ${line}`); } catch (_) {}
                  }
                } else if (block.type === "tool_use") {
                  const activityFn = TOOL_ACTIVITY_MAP[block.name];
                  if (activityFn) {
                    try { onActivity(activityFn(block.input, cwd)); } catch (_) {}
                  }
                }
              }
            }

            // Capture the final result
            if (event.type === "result") {
              streamResult = event.result || "";
              streamUsage = {
                inputTokens: event.usage?.input_tokens || 0,
                outputTokens: event.usage?.output_tokens || 0,
                cacheReadTokens: event.usage?.cache_read_input_tokens || 0,
                cacheCreationTokens: event.usage?.cache_creation_input_tokens || 0,
                totalCostUsd: event.total_cost_usd || 0,
                durationMs: event.duration_ms || 0,
                durationApiMs: event.duration_api_ms || 0,
                numTurns: event.num_turns || 0,
                modelUsage: event.modelUsage || {},
              };
            }
          } catch (_) {
            // Skip unparseable lines
          }
        }
      } else {
        process.stdout.write(data);
      }
    });

    proc.stderr.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;
      lastActivity = Date.now();
      for (const line of chunk.split("\n").filter(Boolean)) {
        logger.warn({ source: "claude-stderr" }, line);
      }
    });

    proc.on("close", (code, signal) => {
      clearInterval(heartbeat);
      unregisterProcess(taskId, proc);
      const totalBytes = useStreaming ? streamOutputBytes : output.length;
      logger.info({ code, signal, outputLength: totalBytes }, "Claude Code process exited");

      if (proc.budgetExceeded) {
        const d = proc.budgetDetail || {};
        reject(new Error(
          `Budget exceeded: run stopped at ~$${(d.estimated || 0).toFixed(2)} (budget $${(d.budget || 0).toFixed(2)}, ` +
          `${((d.inputTokens || 0) + (d.outputTokens || 0)).toLocaleString()} tokens). Retry the task to approve continuing with a fresh budget.`
        ));
      } else if (proc.cancelled) {
        reject(new Error("Execution cancelled by user"));
      } else if (code !== 0) {
        const timeoutHint = (code === 143 || signal === "SIGTERM")
          ? ` (likely timed out after ${timeout / 60_000}m)`
          : "";
        reject(new Error(`Claude Code exited with code ${code}${timeoutHint}: ${stderr.slice(0, 800)}`));
      } else if (useStreaming ? streamOutputBytes === 0 : !output.trim()) {
        reject(new Error(`Claude Code exited successfully but produced no output. stderr: ${stderr.slice(0, 800)}`));
      } else if (useStreaming) {
        // For stream-json, use the parsed result (NOT the raw accumulated output)
        if (!streamResult) {
          logger.warn({ streamOutputBytes }, "Claude Code stream ended without a result event — using empty string");
        }
        resolve({ output: streamResult || "", usage: streamUsage });
      } else {
        // Parse JSON output format to extract result text + usage/cost data
        let resultText = output;
        let usage = null;
        try {
          const parsed = JSON.parse(output);
          resultText = parsed.result || output;
          usage = {
            inputTokens: parsed.usage?.input_tokens || 0,
            outputTokens: parsed.usage?.output_tokens || 0,
            cacheReadTokens: parsed.usage?.cache_read_input_tokens || 0,
            cacheCreationTokens: parsed.usage?.cache_creation_input_tokens || 0,
            totalCostUsd: parsed.total_cost_usd || 0,
            durationMs: parsed.duration_ms || 0,
            durationApiMs: parsed.duration_api_ms || 0,
            numTurns: parsed.num_turns || 0,
            modelUsage: parsed.modelUsage || {},
          };
        } catch (_) {
          // If JSON parsing fails, fall back to raw output (text mode)
          logger.debug("Claude Code output was not valid JSON, using raw text");
        }
        resolve({ output: resultText, usage });
      }
    });

    proc.on("error", (err) => {
      clearInterval(heartbeat);
      unregisterProcess(taskId, proc);
      reject(new Error(`Failed to spawn Claude Code: ${err.message}`));
    });
  });
}

/**
 * Execute a decomposed task as sequential Claude passes — one per subtask,
 * all on the same branch/working tree so changes accumulate into one PR.
 * Each pass gets the full assembled context prompt plus a focused subtask
 * block with summaries of previously completed steps.
 *
 * Returns a { output, usage } shape compatible with runClaudeCode.
 */
async function runDecomposedSubtasks({ taskId, basePrompt, repoPath, modelOverride, onActivity, repoLabel = "", budgetUsd = 0 }) {
  const outputs = [];
  const aggregateUsage = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    totalCostUsd: 0, durationMs: 0, durationApiMs: 0, numTurns: 0, modelUsage: {},
  };
  let executed = 0;

  // Task record for the parent description used in subtask prompts
  const taskRow = await getTaskById(taskId);
  const parentDescription = taskRow?.description || taskRow?.name || "";

  for (;;) {
    const subtask = await getNextSubtask(taskId);
    if (!subtask) break;

    const progress = await getSubtaskProgress(taskId);
    await addExecutionLog(taskId, "info", "running_claude",
      `${repoLabel}Subtask ${progress.completed + 1}/${progress.total}: ${subtask.name}`);

    // Budget is shared across the whole run: each subtask gets what's left
    let remainingBudget = 0;
    if (budgetUsd > 0) {
      remainingBudget = budgetUsd - aggregateUsage.totalCostUsd;
      if (remainingBudget <= 0) {
        throw new Error(
          `Budget exceeded: $${aggregateUsage.totalCostUsd.toFixed(2)} spent across ${executed} subtask(s) ` +
          `(budget $${budgetUsd.toFixed(2)}). Retry the task to approve continuing with a fresh budget.`
        );
      }
    }

    const subtaskBlock = await buildSubtaskPrompt(taskId, subtask, parentDescription);
    const prompt = [
      basePrompt,
      "\n\n---\n",
      "# FOCUS: Execute ONLY the current step below",
      "This task is being implemented in ordered steps. Earlier steps are already done",
      "(their changes are in the working tree). Implement ONLY the current step —",
      "do not redo completed steps or jump ahead.\n",
      subtaskBlock,
    ].join("\n");

    try {
      const result = await runClaudeCode(prompt, repoPath, { modelOverride, onActivity, taskId, budgetUsd: remainingBudget });
      const output = result.output || "";
      outputs.push(`## ${subtask.name}\n${output}`);
      executed++;

      if (result.usage) {
        aggregateUsage.inputTokens += result.usage.inputTokens || 0;
        aggregateUsage.outputTokens += result.usage.outputTokens || 0;
        aggregateUsage.cacheReadTokens += result.usage.cacheReadTokens || 0;
        aggregateUsage.cacheCreationTokens += result.usage.cacheCreationTokens || 0;
        aggregateUsage.totalCostUsd += result.usage.totalCostUsd || 0;
        aggregateUsage.durationMs += result.usage.durationMs || 0;
        aggregateUsage.durationApiMs += result.usage.durationApiMs || 0;
        aggregateUsage.numTurns += result.usage.numTurns || 0;
      }

      await completeSubtask(subtask.id, { output: output.slice(0, 2000) });
    } catch (err) {
      await failSubtask(subtask.id, err.message);
      await addExecutionLog(taskId, "error", "running_claude",
        `${repoLabel}Subtask "${subtask.name}" failed: ${err.message}`);
      throw new Error(`Subtask "${subtask.name}" failed: ${err.message}`);
    }
  }

  logger.info({ taskId, executed }, "Decomposed execution complete");
  return {
    output: outputs.join("\n\n"),
    usage: executed > 0 ? aggregateUsage : null,
  };
}

// ── Main Task Execution Pipeline ────────────────────────────────

/**
 * Execute a task record from the database.
 * Supports both fresh execution and incremental updates.
 */
export async function execute(taskRecord) {
  const maxSessions = config.get("maxConcurrentSessions");
  const baseBranch = config.get("baseBranch");
  const pipelineStart = Date.now();
  const taskId = taskRecord.id;
  const isIncremental = !!taskRecord.pr_url; // Has existing PR = incremental update

  logger.info(
    {
      taskId, clickupId: taskRecord.clickup_task_id,
      name: taskRecord.name, isIncremental,
      repo: taskRecord.repo_full_name, branch: taskRecord.branch_name,
      activeSessions: activeSessions.size, maxSessions,
    },
    `[PIPELINE] 🏁 Starting execution for "${taskRecord.name}" (db:${taskId}, clickup:${taskRecord.clickup_task_id}) — ${isIncremental ? "INCREMENTAL" : "FRESH"}`
  );

  // Concurrency check
  if (activeSessions.size >= maxSessions) {
    logger.warn(
      { taskId, active: activeSessions.size, maxSessions },
      `[PIPELINE] ⏳ Max concurrent sessions (${maxSessions}) reached — waiting 30s...`
    );
    await new Promise((r) => setTimeout(r, 30_000));
    if (activeSessions.size >= maxSessions) {
      throw new Error(`Max concurrent sessions (${maxSessions}) still reached after waiting`);
    }
  }

  // Mark as running
  await startTask(taskId);
  const sessionId = `${taskId}-${Date.now()}`;
  activeSessions.set(sessionId, { taskId, startedAt: new Date() });

  // Build shared Slack context for enriched notifications (assignees, triggered-by, ClickUp link)
  const assignees = taskRecord.assignees || [];
  const clickupUrl = taskRecord.clickup_task_json?.url || (taskRecord.clickup_task_id ? `https://app.clickup.com/t/${taskRecord.clickup_task_id}` : null);
  const triggeredByUser = assignees.length > 0 ? (assignees[0].username || assignees[0].name || `User ${assignees[0].id}`) : "System";
  const slackCtx = { assignees, triggeredBy: triggeredByUser, clickupUrl };

  // Emit metrics + Slack
  metrics.taskStarted({
    taskId: taskRecord.clickup_task_id,
    taskName: taskRecord.name,
    repo: taskRecord.repo_full_name || "resolving...",
    branch: taskRecord.branch_name || "resolving...",
  });

  try {
    // Notify Slack — post the anchor card that starts this task's thread.
    // Every later lifecycle event threads under it as a compact reply.
    await notifySlack("task_triggered", { taskName: taskRecord.name, taskId: taskRecord.clickup_task_id, taskDbId: taskId, repo: taskRecord.repo_full_name || "", ...slackCtx });

    // Step 0: Resolve repo + GitHub token
    await startStep(taskId, "planning");
    await updateTaskStep(taskId, "resolving_repo");
    await addExecutionLog(taskId, "info", "resolving_repo", "Resolving repository from ClickUp custom fields");

    // Resolve per-user GitHub token from task assignees
    let resolvedGitHubToken = null;
    let gitTokenSource = "env";
    try {
      const result = await resolveGitHubTokenForTask(taskRecord);
      resolvedGitHubToken = result.token;
      gitTokenSource = result.source;
      if (result.token) {
        await addExecutionLog(taskId, "info", "resolving_repo", `GitHub token resolved (source: ${result.source})`);
      }
    } catch (err) {
      logger.warn({ taskId, err: err.message }, "GitHub token resolution failed, using env fallback");
    }

    // Build env override for gh CLI commands when using per-user token
    const ghEnv = resolvedGitHubToken ? { GITHUB_TOKEN: resolvedGitHubToken } : undefined;

    // Resolve git author from task assignees (for "User authored and AutoShip committed" display)
    let gitAuthorEnv = {};
    try {
      const author = await resolveGitAuthor(taskRecord);
      if (author) {
        gitAuthorEnv = author;
        await addExecutionLog(taskId, "info", "resolving_repo", `Git author: ${author.GIT_AUTHOR_NAME} <${author.GIT_AUTHOR_EMAIL}>`);
      }
    } catch (_) {}

    const taskJson = taskRecord.clickup_task_json || {};

    let allRepos;
    if (isIncremental && taskRecord.repo_full_name) {
      // Reuse existing repo info for incremental updates (may be comma-separated)
      allRepos = taskRecord.repo_full_name.split(",").map((fullName) => {
        fullName = fullName.trim();
        const [org, name] = fullName.includes("/") ? fullName.split("/") : [config.get("githubOrg") || GITHUB_ORG, fullName];
        return { org, name, fullName };
      });
    } else {
      allRepos = extractAllRepos(taskJson);

      if (allRepos.length === 0) {
        const msg = `No "repo" custom field found on task "${taskRecord.name}". Please set the repo field and reassign.`;
        await addExecutionLog(taskId, "error", "resolving_repo", msg);
        await postTaskComment(taskRecord.clickup_task_id, `⚠️ ${msg}`).catch(() => {});
        throw new Error(msg);
      }
    }

    // Multi-repo gating: when disabled, only the first repo is executed;
    // when enabled, cap the repo count at multiRepoMaxRepos
    if (allRepos.length > 1) {
      if (!config.get("multiRepoEnabled")) {
        await addExecutionLog(taskId, "warn", "resolving_repo",
          `Task references ${allRepos.length} repos but multi-repo orchestration is disabled — executing only ${allRepos[0].fullName}`);
        allRepos = allRepos.slice(0, 1);
      } else {
        const maxRepos = config.get("multiRepoMaxRepos") || 3;
        if (allRepos.length > maxRepos) {
          await addExecutionLog(taskId, "warn", "resolving_repo",
            `Task references ${allRepos.length} repos — capping at multiRepoMaxRepos (${maxRepos})`);
          allRepos = allRepos.slice(0, maxRepos);
        }
      }
    }

    const allRepoNames = allRepos.map((r) => r.fullName).join(", ");
    if (allRepos.length > 1) {
      logger.info({ taskId, repos: allRepoNames }, "Multi-repo task — will execute against all repos");
      await addExecutionLog(taskId, "info", "resolving_repo", `Multiple repos: ${allRepoNames}`);
    }

    // For fresh runs, always generate a unique runId so each execution gets its own branch/PR.
    const runId = generateRunId();
    const branchName = isIncremental && taskRecord.branch_name
      ? taskRecord.branch_name
      : formatBranchName(taskRecord, runId);

    // Use primary repo for task-level DB record, store all repo names
    const primaryRepo = allRepos[0];
    await updateTaskRepo(taskId, {
      repoFullName: allRepoNames,
      repoName: primaryRepo.name,
      branchName,
    });

    logger.info({ taskId, repos: allRepoNames, branchName, isIncremental }, "Starting pipeline");
    await addExecutionLog(taskId, "info", "resolving_repo", `Repos: ${allRepoNames}, Branch: ${branchName}`);

    // Step 1: Update ClickUp status
    if (!isIncremental) {
      await updateTaskStep(taskId, "updating_clickup");
      try {
        await updateTaskStatus(taskRecord.clickup_task_id, "DEVELOPMENT");
      } catch (e) {
        logger.warn({ err: e.message }, "Could not update task status (non-fatal)");
      }
    }

    // Step 2: Clone/fetch ALL repos and setup branches
    await updateTaskStep(taskId, "git_setup");

    // Prepare all repo paths and branches
    const repoPaths = {};
    for (const repo of allRepos) {
      const rPath = path.join(REPOS_BASE_DIR, repo.name);
      repoPaths[repo.fullName] = rPath;
      await addExecutionLog(taskId, "info", "git_setup", `Setting up git for ${repo.fullName} at ${rPath}`);
      await ensureRepoCloned(repo.fullName, resolvedGitHubToken);

      // Auto-clean any leftover local changes from previous runs to prevent pull conflicts
      await runCommand("git", ["stash", "--include-untracked"], rPath).catch(() => {});
      await runCommand("git", ["stash", "drop"], rPath).catch(() => {});

      if (isIncremental) {
        await runCommand("git", ["checkout", branchName], rPath);
        await runCommand("git", ["pull", "origin", branchName], rPath).catch(() => {});
        await addExecutionLog(taskId, "info", "git_setup", `[${repo.fullName}] Checked out existing branch: ${branchName}`);
      } else {
        await runCommand("git", ["checkout", baseBranch], rPath);
        await runCommand("git", ["pull", "origin", baseBranch], rPath);
        try { await runCommand("git", ["branch", "-D", branchName], rPath); } catch (_) {}
        await runCommand("git", ["checkout", "-b", branchName], rPath);
        await addExecutionLog(taskId, "info", "git_setup", `[${repo.fullName}] Created branch: ${branchName} from ${baseBranch}`);
      }
    }

    // Step 4: Post "started" comment (fresh only)
    if (!isIncremental) {
      await postTaskComment(
        taskRecord.clickup_task_id,
        `Started working on this task.\n\n**Repos**: ${allRepos.map((r) => `\`${r.fullName}\``).join(", ")}\n**Branch**: \`${branchName}\``
      ).catch(() => {});
    }

    // Complete planning step, start implementation
    await completeStep(taskId, "planning");
    notifySlack("planning_completed", { taskName: taskRecord.name, taskDbId: taskId, repo: allRepoNames, duration: Date.now() - pipelineStart, ...slackCtx });

    // ── Feature 16: Complexity Scoring (uses primary repo) ─────
    const primaryRepoPath = repoPaths[primaryRepo.fullName];
    let complexityResult = null;
    let repoIndex = null;
    try {
      // Feature 7: Codebase Indexing
      if (config.get("codebaseIndexEnabled")) {
        repoIndex = indexRepository(primaryRepoPath);
      }

      // Get debate session for complexity scoring
      let debateSessionForComplexity = null;
      if (taskRecord.debate_session_id) {
        debateSessionForComplexity = await getDebateSession(taskRecord.debate_session_id);
      }

      complexityResult = scoreComplexity(
        taskRecord.description || taskRecord.name,
        repoIndex,
        debateSessionForComplexity
      );

      // Store complexity on task
      const { pool: dbPool } = await import("./db.js");
      await dbPool.query(
        "UPDATE tasks SET complexity_score = $1, complexity_level = $2, updated_at = NOW() WHERE id = $3",
        [complexityResult.score, complexityResult.level, taskId]
      );

      await addExecutionLog(taskId, "info", "complexity", `Complexity: ${complexityResult.level} (${complexityResult.score}/100), est. ${complexityResult.estimatedFiles} files`);
    } catch (err) {
      logger.warn({ taskId, err: err.message }, "Complexity scoring failed (non-fatal)");
    }

    // Notify Slack with complexity (compact thread update — the anchor card
    // was already posted at the start of the run)
    if (complexityResult) {
      notifySlack("complexity_scored", {
        taskName: taskRecord.name,
        taskDbId: taskId,
        level: complexityResult.level,
        score: complexityResult.score,
        estimatedFiles: complexityResult.estimatedFiles,
        ...slackCtx,
      });
    }

    // Step 5: Run Claude Code for EACH repo (with debate plan injection if available)
    await startStep(taskId, "implementation");
    await updateTaskStep(taskId, "running_claude");
    notifySlack("implementation_started", { taskName: taskRecord.name, taskDbId: taskId, repo: allRepoNames, ...slackCtx });

    // Resolve execution model: debate leader override > executionModel config > claudeModel config
    // For incremental updates, always use the current config model (the user may have
    // changed the model selection mode since the original debate ran).
    let executionModelOverride = null;
    let debatePlan = null;

    if (taskRecord.debate_session_id) {
      const debateSession = await getDebateSession(taskRecord.debate_session_id);
      if (debateSession) {
        debatePlan = debateSession.final_plan;
        if (!isIncremental && config.get("executionModelMode") === "leader_selects" && debateSession.execution_model) {
          executionModelOverride = debateSession.execution_model;
          await addExecutionLog(taskId, "info", "running_claude", `Leader selected model: ${executionModelOverride}`);
        }
      }
    }

    // For non-debate tasks: if the task has an approved coding plan stored as
    // custom_instructions (set by approvalHandler when the plan is approved),
    // use it as the mandatory plan — same framing as debate plans.
    // This ensures ALL tasks (simple, medium, complex) follow their approved plan.
    if (!debatePlan && taskRecord.custom_instructions && !isIncremental) {
      // Check if this plan came from workflow approval (not arbitrary instructions)
      try {
        const { pool: dbPool } = await import("./db.js");
        const { rows: approvalRows } = await dbPool.query(
          `SELECT coding_plan FROM workflow_approvals
           WHERE clickup_task_id = $1 AND state IN ('approved', 'pr_created')
           ORDER BY approved_at DESC LIMIT 1`,
          [taskRecord.clickup_task_id]
        );
        if (approvalRows[0]?.coding_plan) {
          debatePlan = approvalRows[0].coding_plan;
          await addExecutionLog(taskId, "info", "running_claude", "Using approved coding plan as mandatory implementation guide");
        }
      } catch (err) {
        logger.warn({ taskId, err: err.message }, "Could not check for approved plan (non-fatal)");
      }
    }

    // executionModel is the canonical config — never fall back to claudeModel (may differ)
    const claudeModel = executionModelOverride || config.get("executionModel") || "claude-opus-4-6";
    if (isIncremental) {
      await addExecutionLog(taskId, "info", "running_claude", `Using execution model: ${claudeModel} (incremental — config override)`);
    }

    // ── Per-repo execution loop ─────────────────────────────────
    // Run Claude Code, commit, push, and create PR for EACH repo.
    const allPrUrls = [];
    const allPrNumbers = [];
    let lastClaudeOutput = "";

    // Per-repo change stats ({ repo, files, insertions, deletions }) collected
    // after each commit — feed the "What changed" summary on completion.
    const repoChangeSummaries = [];

    // Multi-repo orchestration: track changes made in previous repos so the
    // next repo's Claude session understands what was already done and can
    // align its changes accordingly (e.g. backend API changes → matching frontend).
    const previousRepoChanges = [];

    // Multi-PR ledger: persist a dependency-ordered plan (each repo's PR
    // depends on the previous one, matching sequential execution with
    // cross-repo context) so progress survives restarts and is queryable.
    let prPlanEntries = [];
    if (!isIncremental && allRepos.length > 1) {
      prPlanEntries = await createMultiPrPlan(taskId, allRepos.map((r, i) => ({
        name: `PR for ${r.fullName}`,
        repo: r.fullName,
        type: "service",
        dependsOn: i > 0 ? [i - 1] : [],
        order: i,
      })));
    }

    for (const currentRepo of allRepos) {
      const repoPath = repoPaths[currentRepo.fullName];
      const repoLabel = allRepos.length > 1 ? `[${currentRepo.fullName}] ` : "";

      logger.info(
        { taskId, model: claudeModel, hasPlan: !!debatePlan, repoPath, branchName, repo: currentRepo.fullName },
        `[PIPELINE] 🤖 Spawning Claude Code — model: ${claudeModel}, repo: ${currentRepo.fullName}, branch: ${branchName}`
      );
      await addExecutionLog(taskId, "info", "running_claude", `${repoLabel}Spawning Claude Code (model: ${claudeModel})${debatePlan ? " with debate plan" : ""}...`);

      // When we have a mandatory plan (debate or approved), don't also include it as
      // "Additional Instructions" via custom_instructions — that would duplicate it.
      const taskForPrompt = debatePlan && taskRecord.custom_instructions
        ? { ...taskRecord, custom_instructions: null }
        : taskRecord;

      let prompt = isIncremental && taskRecord.custom_instructions
        ? buildIncrementalPrompt(taskRecord, taskRecord.custom_instructions)
        : buildPrompt(taskForPrompt);

      // Inject the approved/debate plan into the execution prompt.
      // Configurable: planInjectionSkipThreshold controls whether simple/medium tasks skip injection.
      // Configurable: planFramingMode controls how strictly Claude follows the plan.
      if (debatePlan) {
        const taskLevel = complexityResult?.level || "medium";
        const injectionSkip = config.get("planInjectionSkipThreshold") || "none";
        const complexityOrder = ["simple", "medium", "complex", "critical"];
        const taskIdx = complexityOrder.indexOf(taskLevel);
        const skipIdx = complexityOrder.indexOf(injectionSkip);
        const shouldSkipInjection = injectionSkip !== "none" && taskIdx >= 0 && skipIdx >= 0 && taskIdx <= skipIdx;

        if (shouldSkipInjection) {
          await addExecutionLog(taskId, "info", "running_claude",
            `${repoLabel}Plan injection skipped — task complexity (${taskLevel}) at or below threshold (${injectionSkip}). Claude will implement from task description only.`);
        } else {
          const planMode = config.get("debatePlanInPrompt") || "full";
          // Determine framing strictness
          let framingMode = config.get("planFramingMode") || "mandatory";
          if (framingMode === "adaptive") {
            // Adaptive: use "guide" for simple/medium, "mandatory" for complex/critical
            framingMode = (taskLevel === "simple" || taskLevel === "medium") ? "guide" : "mandatory";
          }
          prompt = injectDebatePlan(prompt, debatePlan, planMode, { framingMode });
          await addExecutionLog(taskId, "info", "running_claude",
            `${repoLabel}Plan injected (${debatePlan.length} chars, mode: ${planMode}, framing: ${framingMode})`);
        }
      } else {
        await addExecutionLog(taskId, "warn", "running_claude",
          `${repoLabel}No approved plan available — Claude will implement from task description only`);
      }

      // ── Feature 3: Project Context ──────────────────────────────
      if (config.get("projectContextEnabled") && !isIncremental) {
        try {
          const projectInfo = detectProjectType(repoPath);
          if (projectInfo.type !== "unknown") {
            const contextBlock = generateContextPrompt(projectInfo, repoPath);
            prompt = contextBlock + "\n\n---\n\n" + prompt;
            await addExecutionLog(taskId, "info", "project_context", `${repoLabel}Project type: ${projectInfo.type} (${projectInfo.buildTool || "N/A"})`);
          }
        } catch (err) {
          logger.warn({ taskId, repo: currentRepo.fullName, err: err.message }, "Project context detection failed (non-fatal)");
        }
      }

      // ── Feature 7: Codebase Context Injection ───────────────────
      if (config.get("codebaseIndexEnabled")) {
        try {
          const thisRepoIndex = indexRepository(repoPath);
          if (thisRepoIndex) {
            const maxTokens = config.get("codebaseIndexMaxTokens") || 4000;
            const relevantContext = getRelevantContext(thisRepoIndex, taskRecord.description || taskRecord.name, maxTokens);
            if (relevantContext) {
              prompt = relevantContext + "\n\n---\n\n" + prompt;
              await addExecutionLog(taskId, "info", "codebase_index", `${repoLabel}Injected relevant codebase context`);
            }
          }
        } catch (err) {
          logger.warn({ taskId, repo: currentRepo.fullName, err: err.message }, "Codebase context injection failed (non-fatal)");
        }
      }

      // ── Feature 10: Historical Insights ─────────────────────────
      if (!isIncremental && currentRepo.name) {
        try {
          const insights = await getHistoricalInsights(currentRepo.name, taskRecord.description || "");
          if (insights.commonIssues.length > 0 || insights.tips.length > 0) {
            const insightBlock = [
              `## Historical Insights (from past PRs for ${currentRepo.fullName})`,
              ...(insights.commonIssues.length > 0 ? [`Common review issues: ${insights.commonIssues.join(", ")}`] : []),
              ...(insights.avgRevisionsNeeded > 0 ? [`Average revisions needed: ${insights.avgRevisionsNeeded}`] : []),
              ...(insights.tips.length > 0 ? insights.tips.map(t => `- ${t}`) : []),
            ].join("\n");
            prompt = insightBlock + "\n\n---\n\n" + prompt;
            await addExecutionLog(taskId, "info", "learning", `${repoLabel}Historical insights: ${insights.commonIssues.length} common issues, success rate ${insights.successRate}%`);
          }
        } catch (err) {
          logger.warn({ taskId, repo: currentRepo.fullName, err: err.message }, "Historical insights failed (non-fatal)");
        }
      }

      // ── Codebase dependency graph: entry points, modules, patterns ──
      if (config.get("codebaseGraphEnabled") && !isIncremental) {
        try {
          const projectInfo = detectProjectType(repoPath);
          const graph = await buildCodebaseGraph(repoPath, projectInfo.type);
          const graphBlock = formatGraphContext(graph);
          if (graphBlock) {
            prompt = graphBlock + "\n\n---\n\n" + prompt;
            await addExecutionLog(taskId, "info", "codebase_graph", `${repoLabel}Injected dependency graph (${graph.modules?.length || 0} modules)`);
          }
        } catch (err) {
          logger.warn({ taskId, repo: currentRepo.fullName, err: err.message }, "Codebase graph injection failed (non-fatal)");
        }
      }

      // ── Similar past PRs in this repo ────────────────────────────
      if (config.get("prHistoryMiningEnabled") && !isIncremental && currentRepo.fullName) {
        try {
          const similarPRs = await findSimilarPRs({
            repoFullName: currentRepo.fullName,
            taskDescription: taskRecord.description || "",
            taskName: taskRecord.name,
          });
          const similarBlock = formatSimilarPRsContext(similarPRs);
          if (similarBlock) {
            prompt = similarBlock + "\n\n---\n\n" + prompt;
            await addExecutionLog(taskId, "info", "pr_history", `${repoLabel}Injected ${similarPRs.length} similar past PR(s)`);
          }
        } catch (err) {
          logger.warn({ taskId, repo: currentRepo.fullName, err: err.message }, "PR history mining failed (non-fatal)");
        }
      }

      // ── Lessons learned from past PR reviews in this repo ───────
      if (config.get("repoLessonsEnabled") && !isIncremental && currentRepo.fullName) {
        try {
          const lessonsBlock = await getRepoLessons(currentRepo.fullName);
          if (lessonsBlock) {
            prompt = lessonsBlock + "\n\n---\n\n" + prompt;
            await addExecutionLog(taskId, "info", "repo_lessons", `${repoLabel}Injected repo lessons from past reviews`);
          }
        } catch (err) {
          logger.warn({ taskId, repo: currentRepo.fullName, err: err.message }, "Repo lessons injection failed (non-fatal)");
        }
      }

      // ── Multi-repo orchestration: inject cross-repo context ─────
      // When working on repo 2+, tell Claude what changes were already made in
      // previous repos so it can align its work (e.g. matching API contracts,
      // shared types, endpoint paths, request/response shapes).
      if (previousRepoChanges.length > 0) {
        const crossRepoBlock = [
          `\n## Cross-Repository Context (IMPORTANT)`,
          `This task spans multiple repositories. The following changes have ALREADY been made in other repos.`,
          `Your changes in this repo (${currentRepo.fullName}) MUST be aligned with these changes.`,
          `Pay special attention to: API endpoints, request/response shapes, shared types, configuration keys, and any contracts between services.\n`,
          ...previousRepoChanges.map((c) => [
            `### Changes in ${c.repo}`,
            '```diff',
            c.diff.substring(0, 3000) + (c.diff.length > 3000 ? "\n... (truncated)" : ""),
            '```',
            `**Summary**: ${c.summary.substring(0, 500)}`,
          ].join("\n")),
        ].join("\n\n");

        // Insert before ## Rules
        const rulesIdx = prompt.indexOf("## Rules");
        if (rulesIdx !== -1) {
          prompt = prompt.substring(0, rulesIdx) + crossRepoBlock + "\n\n" + prompt.substring(rulesIdx);
        } else {
          prompt += crossRepoBlock;
        }
        await addExecutionLog(taskId, "info", "running_claude",
          `${repoLabel}Injected cross-repo context from ${previousRepoChanges.length} previous repo(s)`);
      }

      // Adjust timeout based on complexity
      const baseTimeout = config.get("claudeTimeout");
      if (complexityResult) {
        const adjustedTimeout = getTimeoutForComplexity(complexityResult.level, baseTimeout);
        if (adjustedTimeout !== baseTimeout) {
          await addExecutionLog(taskId, "info", "running_claude", `${repoLabel}Timeout adjusted for ${complexityResult.level} complexity: ${adjustedTimeout / 60000}m`);
        }
      }

      // ── Real-time activity streaming: log tool use events as they happen ──
      const activityCallback = (activity) => {
        addExecutionLog(taskId, "info", "claude_activity", `${repoLabel}${activity}`).catch(() => {});
      };

      // Prompt evolution: register the prompt *configuration* used for this
      // task as a variant. Hashing the full prompt would make every task its
      // own variant; hashing the config descriptor lets merge rates compare
      // across settings (model, plan framing, which context injections ran).
      if (config.get("promptEvolutionEnabled") && !isIncremental) {
        try {
          const descriptor = JSON.stringify({
            executionModel: executionModelOverride || config.get("executionModel"),
            planInPrompt: config.get("debatePlanInPrompt") || "full",
            planFramingMode: config.get("planFramingMode") || "mandatory",
            planInjectionSkip: config.get("planInjectionSkipThreshold") || "none",
            projectContext: !!config.get("projectContextEnabled"),
            codebaseIndex: !!config.get("codebaseIndexEnabled"),
            codebaseGraph: !!config.get("codebaseGraphEnabled"),
            prHistoryMining: !!config.get("prHistoryMiningEnabled"),
            repoLessons: !!config.get("repoLessonsEnabled"),
          });
          const variantHash = generateVariantHash(descriptor);
          registerPromptVariant({
            taskId,
            promptType: "execution",
            variantId: variantHash,
            variantHash,
            repoFullName: currentRepo.fullName,
            promptContent: descriptor,
          }).catch(() => {});
        } catch (_) { /* non-fatal */ }
      }

      const claudeStart = Date.now();

      // Decomposed tasks (single-repo only): run one Claude pass per subtask
      // on the same branch — changes accumulate into a single commit/PR.
      // Multi-repo tasks keep single-pass per repo (subtasks are task-level).
      let claudeResult;
      let useSubtasks = false;
      if (!isIncremental && allRepos.length === 1 && taskRecord.decomposed) {
        const subtaskState = await getSubtaskProgress(taskId);
        if (subtaskState.total > 0) {
          // Retry after a failed/partial attempt: the working tree was rebuilt,
          // so previously completed subtasks must run again
          if (subtaskState.pending === 0 || subtaskState.completed > 0 || subtaskState.failed > 0) {
            await resetSubtasks(taskId);
          }
          useSubtasks = true;
        }
      }
      // Per-run spend budget (0 = unlimited). A retry after a budget failure
      // is the user's approval to continue — it gets a fresh budget.
      const liveBudgetUsd = Number(config.get("liveBudgetUsd")) || 0;

      if (useSubtasks) {
        claudeResult = await runDecomposedSubtasks({
          taskId,
          basePrompt: prompt,
          repoPath,
          modelOverride: executionModelOverride,
          onActivity: activityCallback,
          repoLabel,
          budgetUsd: liveBudgetUsd,
        });
      } else {
        claudeResult = await runClaudeCode(prompt, repoPath, {
          modelOverride: executionModelOverride,
          onActivity: activityCallback,
          taskId,
          budgetUsd: liveBudgetUsd,
        });
      }
      const claudeOutput = claudeResult.output || claudeResult;
      const claudeUsage = claudeResult.usage || null;
      const claudeDuration = Date.now() - claudeStart;
      lastClaudeOutput = claudeOutput;
      logger.info(
        { taskId, repo: currentRepo.fullName, outputLength: claudeOutput.length, durationMs: claudeDuration, durationMin: (claudeDuration / 60000).toFixed(1) },
        `[PIPELINE] ✅ Claude Code finished — ${claudeOutput.length} chars in ${(claudeDuration / 60000).toFixed(1)}m`
      );
      await addExecutionLog(taskId, "info", "running_claude", `${repoLabel}Claude Code finished (${claudeOutput.length} chars, ${(claudeDuration / 60000).toFixed(1)}m)`);

      // Record token usage and cost from Claude Code's structured JSON output
      if (config.get("costTrackingEnabled")) {
        try {
          let promptTokens = 0;
          let completionTokens = 0;
          let totalTokens = 0;
          let estimatedCost = 0;

          if (claudeUsage) {
            // Structured usage from --output-format json
            promptTokens = claudeUsage.inputTokens + (claudeUsage.cacheReadTokens || 0) + (claudeUsage.cacheCreationTokens || 0);
            completionTokens = claudeUsage.outputTokens;
            totalTokens = promptTokens + completionTokens;
            estimatedCost = claudeUsage.totalCostUsd || 0;
          } else {
            // Fallback: regex-parse from text output (legacy)
            const tokenMatch = claudeOutput.match(/(?:Total tokens|Tokens used)[:\s]*(\d[\d,]*)/i);
            const inputMatch = claudeOutput.match(/(?:Input|Prompt) tokens[:\s]*(\d[\d,]*)/i);
            const outputMatch = claudeOutput.match(/(?:Output|Completion) tokens[:\s]*(\d[\d,]*)/i);
            const costMatch = claudeOutput.match(/(?:Cost|Total cost)[:\s]*\$?([\d.]+)/i);
            promptTokens = inputMatch ? parseInt(inputMatch[1].replace(/,/g, "")) : 0;
            completionTokens = outputMatch ? parseInt(outputMatch[1].replace(/,/g, "")) : 0;
            totalTokens = tokenMatch ? parseInt(tokenMatch[1].replace(/,/g, "")) : (promptTokens + completionTokens);
            estimatedCost = costMatch ? parseFloat(costMatch[1]) : 0;
          }

          if (totalTokens > 0 || estimatedCost > 0) {
            const modelUsed = executionModelOverride || config.get("executionModel") || "claude-opus-4-6";
            await addTaskCost(taskId, {
              stepName: `implementation${allRepos.length > 1 ? `_${currentRepo.name}` : ""}`,
              modelUsed, promptTokens, completionTokens, totalTokens, estimatedCost,
            });
            recordTokenUsage(modelUsed, "implementation", totalTokens);
            recordCost(modelUsed, estimatedCost);
          }
        } catch (_) { /* non-fatal */ }
      }

      // Step 6: Stage, commit, push
      await updateTaskStep(taskId, "committing");
      const diffStat = await runCommand("git", ["diff", "--stat", "HEAD"], repoPath);

      // Check for meaningful changes — filter out autoship artifacts that don't
      // represent real implementation work (e.g. .autoship/, .gitignore additions
      // for .autoship). This prevents marking a task as "success" when Claude
      // didn't actually implement anything.
      const AUTOSHIP_ARTIFACT_PATTERNS = [/^\s*\.autoship/, /^\s*\.gitignore/];
      let hasMeaningfulChanges = false;
      if (diffStat) {
        const changedFiles = await runCommand("git", ["diff", "--name-only", "HEAD"], repoPath);
        const fileList = (changedFiles || "").trim().split("\n").filter(Boolean);
        hasMeaningfulChanges = fileList.some(
          (f) => !AUTOSHIP_ARTIFACT_PATTERNS.some((pattern) => pattern.test(f))
        );
        if (!hasMeaningfulChanges) {
          await addExecutionLog(taskId, "warn", "committing",
            `${repoLabel}Only autoship artifacts changed (${fileList.join(", ")}) — treating as no meaningful changes`);
        }
      }

      if (!diffStat || !hasMeaningfulChanges) {
        await addExecutionLog(taskId, "warn", "committing", `${repoLabel}No changes produced by Claude Code`);
        metrics.taskNoChanges({ taskId: taskRecord.clickup_task_id, taskName: taskRecord.name, repo: currentRepo.fullName, duration: Date.now() - pipelineStart });
        if (allRepos.length === 1) {
          // Single repo with no changes — early exit
          const duration = Date.now() - pipelineStart;
          await postTaskComment(taskRecord.clickup_task_id, `⚠️ No code changes were produced for this task.`).catch(() => {});
          await safeCheckout(baseBranch, repoPath);
          await completeTask(taskId, { prUrl: taskRecord.pr_url, prNumber: taskRecord.pr_number, branch: branchName, claudeOutput, duration });
          notifySlack("task_no_changes", { taskName: taskRecord.name, taskDbId: taskId, repo: currentRepo.fullName, ...slackCtx });
          return { success: true, noChanges: true };
        }
        // Multi-repo: skip this repo but continue to next
        // Discard the autoship-only artifacts so they don't leak into a PR
        await runCommand("git", ["checkout", "."], repoPath);
        await safeCheckout(baseBranch, repoPath);
        continue;
      }

      await runCommand("git", ["add", "-A"], repoPath);
      const commitMsg = isIncremental
        ? `update: ${(taskRecord.custom_instructions || "incremental update").substring(0, 72)}`
        : formatCommitMessage(taskRecord) + `\n\nClickUp: ${taskJson.url || ""}`;
      await runCommand("git", ["commit", "-m", commitMsg], repoPath, { env: gitAuthorEnv });

      // ── Structured change summary: log exactly what was changed ─────
      try {
        const diffStatCommit = await runCommand("git", ["diff", "--stat", "HEAD~1..HEAD"], repoPath);
        const changedFilesList = await runCommand("git", ["diff", "--name-status", "HEAD~1..HEAD"], repoPath);
        const insertions = (diffStatCommit.match(/(\d+) insertion/) || [])[1] || "0";
        const deletions = (diffStatCommit.match(/(\d+) deletion/) || [])[1] || "0";
        const fileEntries = (changedFilesList || "").trim().split("\n").filter(Boolean);

        // Build a structured bullet-point summary
        const changeBullets = fileEntries.map((entry) => {
          const [status, ...pathParts] = entry.split("\t");
          const filePath = pathParts.join("\t");
          const statusLabel = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed" }[status] || status;
          return `• ${statusLabel}: ${filePath}`;
        }).join("\n");

        const summaryMsg = [
          `${repoLabel}📋 **Change Summary** — ${fileEntries.length} file(s), +${insertions} -${deletions}`,
          changeBullets,
        ].join("\n");

        await addExecutionLog(taskId, "info", "change_summary", summaryMsg);
      } catch (_) { /* non-fatal */ }

      // ── Multi-repo orchestration: capture changes for next repo ─────
      if (allRepos.length > 1) {
        try {
          const commitDiff = await runCommand("git", ["diff", "HEAD~1..HEAD", "--no-color"], repoPath);
          const summaryLines = (claudeOutput || "").trim().split("\n").slice(-15).join("\n");
          previousRepoChanges.push({
            repo: currentRepo.fullName,
            diff: commitDiff || "(no diff captured)",
            summary: summaryLines || "(no summary)",
          });
        } catch (_) { /* non-fatal — next repo just won't have context */ }
      }

      // ── Feature: Build Verification — compile check after code gen ──
      if (config.get("buildVerificationEnabled") && !isIncremental) {
        await startStep(taskId, "build_verification");
        await updateTaskStep(taskId, "verifying_build");
        await addExecutionLog(taskId, "info", "build_verification", `${repoLabel}Running build verification...`);

        const projectInfo = detectProjectType(repoPath);
        let buildCmd = null;

        if (projectInfo.buildTool === "gradle") {
          const wrapper = existsSync(path.join(repoPath, "gradlew")) ? "./gradlew" : "gradle";
          buildCmd = { cmd: wrapper, args: ["build", "-x", "test"], label: "gradle build -x test" };
        } else if (projectInfo.buildTool === "maven") {
          buildCmd = { cmd: "mvn", args: ["compile", "-B"], label: "mvn compile" };
        } else if (projectInfo.buildTool === "npm" || projectInfo.buildTool === "yarn") {
          const runner = projectInfo.buildTool === "yarn" ? "yarn" : "npm";
          buildCmd = { cmd: runner, args: ["run", "build"], label: `${runner} run build` };
        }

        if (buildCmd) {
          const maxBuildRetries = config.get("buildVerificationMaxRetries") || 3;
          let buildPassed = false;
          let buildRetryCount = 0;
          let buildOutput = "";

          for (let attempt = 0; attempt <= maxBuildRetries; attempt++) {
            try {
              buildOutput = await runCommand(buildCmd.cmd, buildCmd.args, repoPath, { timeout: 300_000, shell: true });
              buildPassed = true;
              break;
            } catch (buildErr) {
              buildOutput = buildErr.message || String(buildErr);
              if (attempt < maxBuildRetries) {
                buildRetryCount++;
                await addExecutionLog(taskId, "warn", "build_verification",
                  `${repoLabel}Build failed (attempt ${buildRetryCount}/${maxBuildRetries}), feeding errors to AI for fix...`);

                const fixPrompt = [
                  `The project build failed. Here is the build output:`,
                  "```",
                  buildOutput.substring(0, 4000),
                  "```",
                  "",
                  `Fix the code so that the build (${buildCmd.label}) succeeds. Do not change test files.`,
                ].join("\n");

                try {
                  await runClaudeCode(fixPrompt, repoPath, { taskId });
                  await runCommand("git", ["add", "-A"], repoPath);
                  await runCommand("git", ["commit", "-m", `fix: address build errors (attempt ${buildRetryCount})`], repoPath, { env: gitAuthorEnv });
                } catch (fixErr) {
                  await addExecutionLog(taskId, "error", "build_verification",
                    `${repoLabel}AI build fix attempt ${buildRetryCount} failed: ${fixErr.message}`);
                  break;
                }
              }
            }
          }

          if (buildPassed) {
            await addExecutionLog(taskId, "info", "build_verification",
              `${repoLabel}Build passed${buildRetryCount > 0 ? ` (after ${buildRetryCount} fix attempt(s))` : ""}`);
          } else {
            await addExecutionLog(taskId, "warn", "build_verification",
              `${repoLabel}Build still failing after ${buildRetryCount} fix attempt(s) — continuing anyway`);
          }
        } else {
          await addExecutionLog(taskId, "info", "build_verification",
            `${repoLabel}No build tool detected — skipping build verification`);
        }

        await completeStep(taskId, "build_verification");
      }

      // ── Feature: Test Runner — run tests after code gen, before push ──
      let testResultsSummary = "";
      let testsFailingLabel = false;
      if (config.get("testRunnerEnabled") && !isIncremental) {
        await startStep(taskId, "testing");
        await updateTaskStep(taskId, "running_tests");
        await addExecutionLog(taskId, "info", "running_tests", `${repoLabel}Running test suite...`);

        const maxTestRetries = config.get("testRunnerMaxRetries") || 2;
        let testResult = await runTests(repoPath);
        let testRetryCount = 0;

        // Record to DB
        try {
          const { pool: dbPool } = await import("./db.js");
          await dbPool.query(
            `INSERT INTO test_run_results (task_id, repo_full_name, passed, test_output, test_summary, retry_count, duration_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [taskId, currentRepo.fullName, testResult.passed, (testResult.output || "").substring(0, 10000), testResult.summary, 0, testResult.duration]
          );
        } catch (_) {}
        recordTestRun(testResult.passed);

        // Retry loop: if tests fail, feed failures back to AI
        while (!testResult.passed && testRetryCount < maxTestRetries) {
          testRetryCount++;
          await addExecutionLog(taskId, "warn", "running_tests",
            `${repoLabel}Tests failed (attempt ${testRetryCount}/${maxTestRetries}), feeding failures to AI for fix...`);

          const fixPrompt = [
            `The test suite for this project failed. Here is the test output:`,
            "```",
            (testResult.output || testResult.summary || "Tests failed").substring(0, 4000),
            "```",
            "",
            "Fix the code so that all tests pass. Do not modify the tests themselves unless they are clearly wrong.",
          ].join("\n");

          try {
            await runClaudeCode(fixPrompt, repoPath, { taskId });
            await runCommand("git", ["add", "-A"], repoPath);
            await runCommand("git", ["commit", "-m", `fix: address test failures (attempt ${testRetryCount})`], repoPath, { env: gitAuthorEnv });
          } catch (fixErr) {
            await addExecutionLog(taskId, "error", "running_tests", `${repoLabel}AI test fix attempt ${testRetryCount} failed: ${fixErr.message}`);
            break;
          }

          testResult = await runTests(repoPath);
          recordTestRun(testResult.passed);

          try {
            const { pool: dbPool } = await import("./db.js");
            await dbPool.query(
              `INSERT INTO test_run_results (task_id, repo_full_name, passed, test_output, test_summary, retry_count, duration_ms)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [taskId, currentRepo.fullName, testResult.passed, (testResult.output || "").substring(0, 10000), testResult.summary, testRetryCount, testResult.duration]
            );
          } catch (_) {}
        }

        if (testResult.passed) {
          testResultsSummary = `✅ Tests passed${testRetryCount > 0 ? ` (after ${testRetryCount} fix attempt(s))` : ""}: ${testResult.summary}`;
        } else {
          testResultsSummary = `⚠️ Tests failing after ${testRetryCount} fix attempt(s): ${testResult.summary}`;
          testsFailingLabel = true;
        }

        await addExecutionLog(taskId, testResult.passed ? "info" : "warn", "running_tests",
          `${repoLabel}${testResultsSummary}`);

        // Store summary on task
        try {
          const { pool: dbPool } = await import("./db.js");
          await dbPool.query("UPDATE tasks SET test_results_summary = $1 WHERE id = $2", [testResultsSummary, taskId]);
        } catch (_) {}

        await completeStep(taskId, "testing");
      }

      await updateTaskStep(taskId, "pushing");
      await addExecutionLog(taskId, "info", "pushing", `${repoLabel}Pushing to origin/${branchName}`);
      await runCommand("git", ["push", "--force-with-lease", "origin", branchName], repoPath, { timeout: 120_000 });

      // Push AI attribution notes for code metrics tracking (best-effort)
      await runCommand("git", ["push", "origin", "refs/notes/ai"], repoPath, { timeout: 15_000 }).catch(() => {});

      // ── Feature: Diff Preview Accuracy — compare predicted vs actual ──
      if (config.get("diffPreviewEnabled")) {
        try {
          const { pool: dbPool } = await import("./db.js");
          const { rows: approvals } = await dbPool.query(
            `SELECT predicted_files FROM workflow_approvals WHERE clickup_task_id = $1 AND predicted_files IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
            [taskRecord.clickup_task_id]
          );
          if (approvals[0]?.predicted_files && Array.isArray(approvals[0].predicted_files) && approvals[0].predicted_files.length > 0) {
            const actualFilesOutput = await runCommand("git", ["diff", "--name-only", `origin/${baseBranch}...HEAD`], repoPath);
            const actualFiles = actualFilesOutput.split("\n").filter(Boolean);
            const accuracyResult = await comparePredictedVsActual({
              taskId, predictedFiles: approvals[0].predicted_files, actualFiles,
            });
            if (accuracyResult) {
              recordDiffAccuracyMetric(accuracyResult.accuracy);
              await addExecutionLog(taskId, "info", "diff_preview", `${repoLabel}Diff preview accuracy: ${accuracyResult.accuracy}% (${accuracyResult.correctlyPredicted}/${accuracyResult.totalActual} files)`);
            }
          }
        } catch (err) {
          logger.warn({ taskId, err: err.message }, "Diff preview accuracy comparison failed (non-fatal)");
        }
      }

      // ── Visual verification: screenshot frontend changes for the PR ──
      let visualMarkdown = "";
      if (config.get("visualVerificationEnabled") && !isIncremental) {
        try {
          const projectInfo = detectProjectType(repoPath);
          if (isFrontendProject(projectInfo)) {
            await addExecutionLog(taskId, "info", "visual_verification", `${repoLabel}Booting dev server for screenshots...`);
            const result = await captureScreenshots({ repoPath, projectInfo, taskId });
            if (result?.screenshots?.length) {
              // .autoship/ is gitignored — force-add so raw URLs resolve on the branch
              await runCommand("git", ["add", "-f", ".autoship/screenshots"], repoPath);
              await runCommand("git", ["commit", "-m", "chore: visual verification screenshots"], repoPath, { env: gitAuthorEnv });
              await runCommand("git", ["push", "origin", branchName], repoPath, { timeout: 60_000 });
              visualMarkdown = formatScreenshotsMarkdown(result.screenshots, currentRepo.fullName, branchName);
              await addExecutionLog(taskId, "info", "visual_verification",
                `${repoLabel}Captured ${result.screenshots.length} screenshot(s) for the PR`);
            } else {
              await addExecutionLog(taskId, "info", "visual_verification", `${repoLabel}No screenshots captured (server/playwright unavailable)`);
            }
          }
        } catch (err) {
          logger.warn({ taskId, err: err.message }, "Visual verification failed (non-fatal)");
        }
      }

      // Step 7: Create PR (fresh only) or add comment (incremental)
      let prUrl = taskRecord.pr_url;
      let prNumber = taskRecord.pr_number;

      if (!isIncremental) {
        await updateTaskStep(taskId, "creating_pr");
        await addExecutionLog(taskId, "info", "creating_pr", `${repoLabel}Creating pull request...`);

        const prTitle = formatPrTitle(taskRecord);
        let prBody = buildPrBody(taskRecord, claudeOutput, branchName);

        // Append test results to PR body
        if (testResultsSummary) {
          prBody += `\n\n## Test Results\n${testResultsSummary}`;
        }

        // Append visual verification screenshots
        if (visualMarkdown) {
          prBody += `\n\n${visualMarkdown}`;
        }

        // Confidence-based draft PRs: a NON-BLOCKING self-review scores the
        // final diff. It never fails the task — a low score just opens the PR
        // as a draft with the findings in the body so reviewers see them.
        let openAsDraft = false;
        if (config.get("selfReviewEnabled")) {
          try {
            const finalDiff = await runCommand("git", ["diff", `origin/${baseBranch}...HEAD`], repoPath, { timeout: 30_000 });
            const review = await reviewGeneratedCode({
              diff: finalDiff,
              taskDescription: taskRecord.description || taskRecord.name,
              codingPlan: debatePlan,
              taskId,
            });

            if (review.score >= 0) {
              const threshold = config.get("selfReviewDraftThreshold") || 70;
              openAsDraft = review.score < threshold;

              const { pool: dbPool } = await import("./db.js");
              await dbPool.query(
                `UPDATE tasks SET self_review_score = $1, self_review_passed = $2, self_review_iterations = 1, updated_at = NOW() WHERE id = $3`,
                [review.score, review.passed, taskId]
              ).catch(() => {});

              if (openAsDraft) {
                const findings = formatReviewFindings(review);
                if (findings) prBody += `\n\n${findings}`;
                await addExecutionLog(taskId, "warn", "creating_pr",
                  `${repoLabel}Self-review score ${review.score}/100 below threshold (${threshold}) — opening PR as draft`);
              } else {
                await addExecutionLog(taskId, "info", "creating_pr",
                  `${repoLabel}Self-review score ${review.score}/100 — PR ready for review`);
              }
            }
          } catch (err) {
            logger.warn({ taskId, err: err.message }, "Self-review failed (non-fatal) — creating PR normally");
          }
        }

        const prCreateArgs = [
          "pr", "create",
          "--title", prTitle,
          "--body", prBody,
          "--base", baseBranch,
          "--head", branchName,
          "--repo", currentRepo.fullName,
        ];
        if (openAsDraft) prCreateArgs.push("--draft");

        const reviewers = config.get("prReviewers");
        if (reviewers) {
          const reviewerList = reviewers.split(",").map((r) => r.trim()).filter(Boolean);
          if (reviewerList.length > 0) {
            prCreateArgs.push("--reviewer", reviewerList.join(","));
          }
        }

        prUrl = (await runCommand("gh", prCreateArgs, repoPath, { timeout: 30_000, env: ghEnv })).trim();
        const prMatch = prUrl.match(/\/pull\/(\d+)/);
        prNumber = prMatch ? parseInt(prMatch[1], 10) : null;

        allPrUrls.push(prUrl);
        allPrNumbers.push(prNumber);

        // Mark this repo's entry complete in the multi-PR ledger
        const planEntry = prPlanEntries[allRepos.indexOf(currentRepo)];
        if (planEntry) {
          completePrPlanEntry(planEntry.id, { prUrl, prNumber, branchName }).catch(() => {});
        }

        await addExecutionLog(taskId, "info", "creating_pr", `${repoLabel}PR created: ${prUrl}`);
        notifySlack("pr_created", { taskName: taskRecord.name, prUrl, prNumber, repo: currentRepo.fullName, taskDbId: taskId, ...slackCtx });

        // Add tests-failing label if tests did not pass
        if (testsFailingLabel && prNumber) {
          try {
            await runCommand("gh", ["pr", "edit", String(prNumber), "--add-label", "tests-failing", "--repo", currentRepo.fullName], repoPath, { timeout: 15_000, env: ghEnv });
            await addExecutionLog(taskId, "warn", "creating_pr", `${repoLabel}Added "tests-failing" label to PR`);
          } catch (labelErr) {
            logger.warn({ prNumber, err: labelErr.message }, "Failed to add tests-failing label (non-fatal)");
          }
        }

        ensureGitHubWebhook(currentRepo.fullName, repoPath).catch((err) => {
          logger.warn({ repo: currentRepo.fullName, err: err.message }, "Failed to ensure GitHub webhook (non-fatal)");
        });
      } else {
        if (prUrl) {
          const summary = claudeOutput.trim().split("\n").slice(-10).join("\n").substring(0, 500);
          try {
            await runCommand(
              "gh",
              ["pr", "comment", String(prNumber || prUrl.split("/").pop()), "--body",
                `Pushed incremental update.\n\n**Changes**:\n${summary}`,
                "--repo", currentRepo.fullName],
              repoPath,
              { timeout: 15_000, env: ghEnv }
            );
          } catch (_) {}
        }
      }

      // Capture this repo's change stats over the FULL branch diff — the
      // implementation commit plus any build-fix/test-fix/screenshot commits —
      // so the completion summary matches the PR it links to.
      try {
        const branchStat = await runCommand("git", ["diff", "--shortstat", `origin/${baseBranch}...HEAD`], repoPath);
        const filesChanged = Number((branchStat.match(/(\d+) files? changed/) || [])[1] || 0);
        if (filesChanged > 0) {
          repoChangeSummaries.push({
            repo: currentRepo.fullName,
            files: filesChanged,
            insertions: Number((branchStat.match(/(\d+) insertions?/) || [])[1] || 0),
            deletions: Number((branchStat.match(/(\d+) deletions?/) || [])[1] || 0),
          });
        }
      } catch (_) { /* non-fatal */ }

      // Switch back to base branch for this repo
      await safeCheckout(baseBranch, repoPath);
    }
    // ── End per-repo loop ───────────────────────────────────────

    // Guard: if ALL repos produced no changes, fail the task instead of
    // silently marking it as success with no PRs.
    if (allPrUrls.length === 0 && !isIncremental) {
      const duration = Date.now() - pipelineStart;
      await addExecutionLog(taskId, "error", "committing",
        `No meaningful code changes were produced in any repository. Claude ran but did not modify any source files.`);
      await postTaskComment(
        taskRecord.clickup_task_id,
        `⚠️ **No code changes were produced** across any of the target repositories (${allRepos.map(r => r.fullName).join(", ")}).\n\nClaude ran but did not implement any changes. This may indicate the plan's file paths don't match the actual repo structure, or the task is too complex for the current execution model. Consider retrying with a different model or refining the plan.`
      ).catch(() => {});
      await failTask(taskId, {
        error: `No meaningful code changes produced in any repository`,
        lastStep: "committing",
      });
      return { success: false, noChanges: true };
    }

    await completeStep(taskId, "implementation");
    await startStep(taskId, "pull_request");
    await completeStep(taskId, "pull_request");

    // Aggregate PR info
    const prUrl = allPrUrls[0] || taskRecord.pr_url;
    const prNumber = allPrNumbers[0] || taskRecord.pr_number;

    // Step 8: Post PR link(s) to ClickUp (fresh only)
    if (!isIncremental) {
      await updateTaskStep(taskId, "notifying_clickup");
      const prLinks = allPrUrls.length > 1
        ? allPrUrls.map((url, i) => `**PR ${i + 1}**: ${url}`).join("\n")
        : `**PR**: ${prUrl}`;
      await postTaskComment(
        taskRecord.clickup_task_id,
        `Implementation complete, PR(s) raised for review.\n\n${prLinks}\n**Branch**: \`${branchName}\` → \`${baseBranch}\``
      ).catch(() => {});

      try {
        await updateTaskStatus(taskRecord.clickup_task_id, "CODE-REVIEW");
      } catch (e) {
        logger.warn({ err: e.message }, "Could not update task status to code review (non-fatal)");
      }

      // Remove "Awaiting Plan Approval" tag (safety net — approvalHandler should
      // have already removed it, but if that failed silently the tag persists)
      try {
        await removeTagFromTask(taskRecord.clickup_task_id, "Awaiting Plan Approval");
      } catch (_) { /* tag may already be removed — ignore */ }
    }

    // Step 9: (base branch checkout already done per-repo in loop above)

    // Step 10: Mark complete
    await startStep(taskId, "completion");
    const duration = Date.now() - pipelineStart;
    await completeTask(taskId, { prUrl, prNumber, branch: branchName, claudeOutput: lastClaudeOutput, duration });
    await completeStep(taskId, "completion");
    const prSummary = allPrUrls.length > 1 ? allPrUrls.join(", ") : prUrl;
    await addTaskMessage(taskId, "system", `${isIncremental ? "Incremental update" : "Implementation"} complete. PR(s): ${prSummary}`);

    // Summary of actions — Claude's own account of the functional changes,
    // written to the session log and posted to the Slack thread alongside
    // the file/line stats so readers see what changed, not just that it did.
    const actionSummary = extractActionSummary(lastClaudeOutput);
    if (actionSummary) {
      await addExecutionLog(taskId, "info", "action_summary", `📦 Summary of changes:\n${actionSummary}`).catch(() => {});
    }
    const changeStats = repoChangeSummaries.length > 0 ? {
      files: repoChangeSummaries.reduce((n, r) => n + r.files, 0),
      insertions: repoChangeSummaries.reduce((n, r) => n + r.insertions, 0),
      deletions: repoChangeSummaries.reduce((n, r) => n + r.deletions, 0),
      repos: repoChangeSummaries,
    } : null;

    notifySlack("task_completed", {
      taskName: taskRecord.name,
      prUrls: allPrUrls.length > 0 ? allPrUrls : (prUrl ? [prUrl] : []),
      duration,
      taskDbId: taskId,
      summary: actionSummary,
      changeStats,
      ...slackCtx,
    });

    metrics.taskCompleted({
      taskId: taskRecord.clickup_task_id,
      taskName: taskRecord.name,
      repo: allRepoNames,
      branch: branchName,
      prUrl: prSummary,
      duration,
    });

    // Prometheus metrics
    recordTaskComplete("success", duration);
    setPrometheusActiveSessions(activeSessions.size);

    // Feature 10: Record PR outcome for each PR
    for (const url of allPrUrls) {
      if (url) {
        recordPROutcome(taskId, url, { merged: false, changesRequested: false, revisionCount: 0 }).catch(() => {});
      }
    }

    // Cost anomaly detection: compare this task's total spend against
    // absolute limits and the rolling fleet average (alerts via Slack)
    if (config.get("costTrackingEnabled")) {
      checkCostAnomaly(taskId, taskRecord.name, allRepoNames?.[0]).catch(() => {});
    }

    // Notify workflow approval handler if this task came from workflow
    onPrCreated(taskRecord.clickup_task_id, prUrl).catch((err) => {
      logger.warn({ taskId, err: err.message }, "Workflow PR notification failed (non-fatal)");
    });

    const totalDuration = Date.now() - pipelineStart;
    logger.info(
      {
        taskId, clickupId: taskRecord.clickup_task_id,
        name: taskRecord.name, prUrl: prSummary, branchName,
        repos: allRepoNames,
        durationMs: totalDuration, durationMin: (totalDuration / 60000).toFixed(1),
      },
      `[PIPELINE] 🎉 SUCCESS — "${taskRecord.name}" completed in ${(totalDuration / 60000).toFixed(1)}m → ${prSummary}`
    );
    return { success: true, prUrl: prSummary, branchName };

  } catch (error) {
    const duration = Date.now() - pipelineStart;
    let lastStepName = "unknown";
    try {
      const taskNow = await getTaskById(taskId);
      lastStepName = taskNow?.last_step || "unknown";
    } catch (_) {}

    logger.error(
      {
        taskId, clickupId: taskRecord.clickup_task_id,
        name: taskRecord.name, failedAt: lastStepName,
        durationMs: duration, durationMin: (duration / 60000).toFixed(1),
        err: error.message, stack: error.stack,
      },
      `[PIPELINE] ❌ FAILED — "${taskRecord.name}" failed at step "${lastStepName}" after ${(duration / 60000).toFixed(1)}m: ${error.message}`
    );

    await failTask(taskId, { error: error.message, lastStep: lastStepName });
    await addExecutionLog(taskId, "error", "pipeline", `Pipeline failed at ${lastStepName}: ${error.message}`);

    // Budget breaches get an explicit approve-to-continue notification:
    // retrying the task from the dashboard grants a fresh budget
    if (error.message.startsWith("Budget exceeded")) {
      sendSlackText(
        `💸 *Budget Exceeded*\nTask: ${taskRecord.name}\n${error.message}\nRetry the task from the dashboard to approve continuing.`
      ).catch(() => {});
      postTaskComment(
        taskRecord.clickup_task_id,
        `💸 **Budget exceeded** — ${error.message}`
      ).catch(() => {});
    }

    // Multi-PR ledger: mark the entry that was in flight as failed so the
    // plan status doesn't show it as pending forever
    try {
      const inFlight = await getNextPrToExecute(taskId);
      if (inFlight) await failPrPlanEntry(inFlight.id, error.message);
    } catch (_) {}

    // Store failure stage
    try {
      const { pool } = await import("./db.js");
      await pool.query("UPDATE tasks SET failure_stage = $1 WHERE id = $2", [lastStepName, taskId]);
    } catch (_) {}

    // Failure post-mortem: classify the root cause (fire-and-forget)
    analyzeFailure({
      taskId,
      taskName: taskRecord.name,
      repoFullName: taskRecord.repo_full_name,
      failureStage: lastStepName,
      errorMessage: error.message,
    }).catch(() => {});

    metrics.taskFailed({
      taskId: taskRecord.clickup_task_id,
      taskName: taskRecord.name,
      repo: taskRecord.repo_full_name || "",
      branch: taskRecord.branch_name || "",
      error: error.message,
      duration,
    });

    // Prometheus metrics
    recordTaskComplete("failed", duration);
    setPrometheusActiveSessions(activeSessions.size);

    await postTaskComment(
      taskRecord.clickup_task_id,
      `❌ Implementation failed.\n\n**Error**: ${error.message}\n**Repo**: \`${taskRecord.repo_full_name || ""}\``
    ).catch(() => {});

    notifySlack("task_failed", { taskName: taskRecord.name, error: error.message, failureStage: lastStepName, repo: taskRecord.repo_full_name || "", taskDbId: taskId, ...slackCtx });

    // Auto-retry if configured
    const maxRetries = config.get("maxRetryAttempts") || 0;
    const retryCount = taskRecord.retry_count || 0;
    if (maxRetries > 0 && retryCount < maxRetries && config.get("autoRetry")) {
      try {
        recordRetry();
        logger.info({ taskId, retryCount: retryCount + 1, maxRetries }, "Auto-retrying failed task");
        notifySlack("retry_attempt", {
          taskName: taskRecord.name, taskDbId: taskId,
          retryCount: retryCount + 1, maxRetries, failureStage: lastStepName,
          ...slackCtx,
        });
        const retriedTask = await retryTask(taskId, {});
        execute(retriedTask).catch((retryErr) => {
          logger.error({ taskId, err: retryErr.message }, "Auto-retry execution failed");
        });
      } catch (retryErr) {
        logger.error({ taskId, err: retryErr.message }, "Failed to initiate auto-retry");
      }
    }

    // Cleanup git state — stash first to prevent "local changes would be overwritten" errors
    try {
      const repoPath = path.join(REPOS_BASE_DIR, taskRecord.repo_name || "");
      if (taskRecord.repo_name && existsSync(repoPath)) {
        await safeCheckout(config.get("baseBranch"), repoPath);
      }
    } catch (_) {}

    throw error;

  } finally {
    activeSessions.delete(sessionId);
  }
}

// ── PR Review Execution ─────────────────────────────────────────

/**
 * Handle PR review comments: use AI to generate fix instructions,
 * run Claude Code to apply fixes, commit, push, post summary, and re-request review.
 */
export async function executePrReview({ prReviewRecord, prNumber, prTitle, prUrl, branch, baseBranch, repoFullName, repoName, reviewComments }) {
  const repoPath = path.join(REPOS_BASE_DIR, repoName);
  const sessionId = `pr-review-${prNumber}-${Date.now()}`;
  const pipelineStart = Date.now();

  logger.info(
    {
      prNumber, prTitle, prUrl, branch, repoFullName,
      commentCount: reviewComments.length,
      reviewers: [...new Set(reviewComments.map(c => c.user))],
      files: [...new Set(reviewComments.filter(c => c.path).map(c => c.path))],
    },
    `[PR-REVIEW] 🔧 Starting auto-fix for PR #${prNumber} "${prTitle}" — ${reviewComments.length} comments on ${repoFullName}`
  );

  metrics.prReviewStarted({ prNumber, repo: repoFullName });
  notifySlack("pr_review_started", { prNumber, repo: repoFullName });

  const maxSessions = config.get("maxConcurrentSessions");
  if (activeSessions.size >= maxSessions) {
    await new Promise((r) => setTimeout(r, 30_000));
    if (activeSessions.size >= maxSessions) {
      throw new Error(`Max concurrent sessions (${maxSessions}) still reached after waiting`);
    }
  }

  activeSessions.set(sessionId, { prNumber, startedAt: new Date() });

  // Look up linked task for context
  let linkedTaskId = prReviewRecord?.task_id || null;
  let taskContext = null;
  if (!linkedTaskId) {
    try {
      const { pool: dbPool } = await import("./db.js");
      const { rows } = await dbPool.query(
        "SELECT id, description, markdown_description FROM tasks WHERE branch_name = $1 ORDER BY id DESC LIMIT 1",
        [branch]
      );
      if (rows[0]) {
        linkedTaskId = rows[0].id;
        taskContext = rows[0].markdown_description || rows[0].description;
      }
    } catch (_) {}
  }

  try {
    if (!existsSync(repoPath)) {
      throw new Error(`Repo not found at ${repoPath}. Cannot handle PR review without local clone.`);
    }

    await runCommand("git", ["fetch", "origin"], repoPath);
    await safeCheckout(branch, repoPath);
    await runCommand("git", ["pull", "origin", branch], repoPath);

    // Get current diff for context
    let currentDiff = "";
    try {
      currentDiff = await runCommand(
        "git", ["diff", `origin/${baseBranch || config.get("baseBranch")}...HEAD`],
        repoPath, { timeout: 30_000 }
      );
    } catch (_) {}

    // Step 1: Generate AI-powered fix instructions from review comments
    let fixResult;
    try {
      fixResult = await generateFixFromReview({
        prTitle, branch, reviewComments, currentDiff, taskContext, taskId: linkedTaskId,
      });
      logger.info({ prNumber, fixLength: fixResult.fixInstructions.length }, "[PR-REVIEW] AI fix instructions generated");
    } catch (err) {
      logger.warn({ prNumber, err: err.message }, "[PR-REVIEW] AI fix generation failed, falling back to direct prompt");
    }

    // Step 2: Build prompt for Claude Code — use AI fix instructions if available
    let prompt;
    if (fixResult) {
      prompt = [
        `You are fixing code in response to PR review comments on PR #${prNumber} "${prTitle}".`,
        "",
        "## AI-Generated Fix Instructions",
        fixResult.fixInstructions,
        "",
        "## Original Review Comments",
        ...reviewComments.map((c) => `- ${c.path ? `[${c.path}:${c.line || "?"}]` : "[General]"} (${c.user}): ${c.body}`),
        "",
        "Apply ALL the fixes described above. Make sure every review comment is addressed.",
      ].join("\n");
    } else {
      // Fallback to existing prompt builder
      let allComments = [];
      try {
        const commentsJson = await runCommand(
          "gh", ["api", `repos/${repoFullName}/pulls/${prNumber}/comments`, "--jq", ".[].body"],
          repoPath, { timeout: 15_000 }
        );
        allComments = commentsJson.split("\n").filter(Boolean);
      } catch (_) {
        allComments = reviewComments.map((c) => c.body);
      }

      let reviewSummary = "";
      try {
        reviewSummary = (await runCommand(
          "gh", ["api", `repos/${repoFullName}/pulls/${prNumber}/reviews`, "--jq",
            '[.[] | select(.state=="CHANGES_REQUESTED") | .body] | join("\\n")'],
          repoPath, { timeout: 15_000 }
        )).trim();
      } catch (_) {}

      prompt = buildPrReviewPrompt({
        prTitle, prUrl, branch,
        baseBranch: baseBranch || config.get("baseBranch"),
        reviewComments, allComments, reviewSummary,
      });
    }

    // Step 3: Run Claude Code to apply fixes, retrying on failure up to
    // prAutoFixMaxRetries (transient CLI/API errors shouldn't strand the PR)
    const maxFixRetries = Math.max(0, config.get("prAutoFixMaxRetries") ?? 2);
    let claudeResult;
    for (let attempt = 0; ; attempt++) {
      try {
        claudeResult = await runClaudeCode(prompt, repoPath, { taskId: linkedTaskId });
        break;
      } catch (err) {
        if (attempt >= maxFixRetries) throw err;
        logger.warn(
          { prNumber, attempt: attempt + 1, maxFixRetries, err: err.message },
          "PR auto-fix Claude run failed — retrying"
        );
        await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
      }
    }
    const claudeOutput = claudeResult.output || claudeResult;
    const diffStat = await runCommand("git", ["diff", "--stat", "HEAD"], repoPath);

    if (!diffStat) {
      const noChangesMsg = "Reviewed the comments — no code changes were needed.";
      try {
        await runCommand("gh", ["pr", "comment", String(prNumber), "--body", noChangesMsg, "--repo", repoFullName], repoPath, { timeout: 15_000 });
      } catch (_) {}

      if (prReviewRecord) {
        await updatePrReview(prReviewRecord.id, { state: "success", completed_at: new Date().toISOString(), duration_ms: Date.now() - pipelineStart });
      }

      recordAutoFixAttempt({
        taskId: linkedTaskId, prReviewId: prReviewRecord?.id, prNumber, repoFullName,
        reviewComments, fixInstructions: fixResult?.fixInstructions, fixSummary: "No changes needed",
        success: true, durationMs: Date.now() - pipelineStart,
      }).catch(() => {});
      recordAutoFixMetric(true);

      return { success: true, noChanges: true };
    }

    // Step 4: Commit and push
    await runCommand("git", ["add", "-A"], repoPath);
    // Resolve git author from linked task assignees (best-effort)
    let prReviewAuthorEnv = {};
    if (linkedTaskId) {
      try {
        const linkedTask = await getTaskById(linkedTaskId);
        if (linkedTask) {
          const author = await resolveGitAuthor(linkedTask);
          if (author) prReviewAuthorEnv = author;
        }
      } catch (_) {}
    }
    await runCommand("git", ["commit", "-m", `address PR review comments (#${prNumber})`], repoPath, { env: prReviewAuthorEnv });
    await runCommand("git", ["push", "origin", branch], repoPath, { timeout: 120_000 });

    // Push AI attribution notes (best-effort)
    await runCommand("git", ["push", "origin", "refs/notes/ai"], repoPath, { timeout: 15_000 }).catch(() => {});

    // Step 5: Post summary comment on the PR
    const fixSummary = fixResult?.summary ||
      claudeOutput.trim().split("\n").filter(Boolean).slice(-15).join("\n").substring(0, 800);

    const commentBody = [
      `🔧 **Auto-fix applied** — addressed ${reviewComments.length} review comment(s) and pushed updates.`,
      "",
      "**Changes:**",
      fixSummary,
      "",
      `**Diff:** ${diffStat.split("\n").pop() || ""}`,
    ].join("\n");

    try {
      await runCommand("gh", ["pr", "comment", String(prNumber), "--body", commentBody, "--repo", repoFullName], repoPath, { timeout: 15_000 });
    } catch (_) {}

    // Step 6: Re-request review from original reviewers
    if (config.get("prAutoFixReRequestReview")) {
      const reviewers = [...new Set(reviewComments.map((c) => c.user).filter(Boolean))];
      for (const reviewer of reviewers) {
        try {
          await runCommand(
            "gh", ["api", `repos/${repoFullName}/pulls/${prNumber}/requested_reviewers`,
              "-X", "POST", "-f", `reviewers[]=${reviewer}`],
            repoPath, { timeout: 15_000 }
          );
          logger.info({ prNumber, reviewer }, "[PR-REVIEW] Re-requested review");
        } catch (err) {
          logger.warn({ prNumber, reviewer, err: err.message }, "[PR-REVIEW] Failed to re-request review (non-fatal)");
        }
      }
    }

    const duration = Date.now() - pipelineStart;
    if (prReviewRecord) {
      await updatePrReview(prReviewRecord.id, {
        state: "success", claude_output: claudeOutput,
        completed_at: new Date().toISOString(), duration_ms: duration,
      });
    }

    // Track auto-fix attempt
    recordAutoFixAttempt({
      taskId: linkedTaskId, prReviewId: prReviewRecord?.id, prNumber, repoFullName,
      reviewComments, fixInstructions: fixResult?.fixInstructions, fixSummary,
      success: true, durationMs: duration,
    }).catch(() => {});
    recordAutoFixMetric(true);

    metrics.prReviewCompleted({ prNumber, repo: repoFullName, duration });
    notifySlack("pr_review_completed", { prNumber, repo: repoFullName });
    return { success: true, prNumber };

  } catch (error) {
    const duration = Date.now() - pipelineStart;
    if (prReviewRecord) {
      await updatePrReview(prReviewRecord.id, {
        state: "failed", error_message: error.message,
        completed_at: new Date().toISOString(), duration_ms: duration,
      });
    }

    metrics.prReviewFailed({ prNumber, repo: repoFullName, error: error.message, duration });

    recordAutoFixAttempt({
      taskId: linkedTaskId, prReviewId: prReviewRecord?.id, prNumber, repoFullName,
      reviewComments, success: false, errorMessage: error.message, durationMs: duration,
    }).catch(() => {});
    recordAutoFixMetric(false);

    try {
      await runCommand("gh", ["pr", "comment", String(prNumber), "--body",
        `❌ Failed to auto-fix review comments: ${error.message}`,
        "--repo", repoFullName], repoPath, { timeout: 15_000 });
    } catch (_) {}

    throw error;

  } finally {
    activeSessions.delete(sessionId);
    try {
      await safeCheckout(config.get("baseBranch"), path.join(REPOS_BASE_DIR, repoName));
    } catch (_) {}
  }
}

/**
 * Standalone fix-from-review function for use by other modules.
 * Generates AI fix instructions without executing them.
 */
export async function fixFromReview({ prNumber, prTitle, branch, repoFullName, reviewComments, taskId }) {
  const repoPath = path.join(REPOS_BASE_DIR, repoFullName.split("/")[1] || repoFullName);
  const baseBranch = config.get("baseBranch");

  let currentDiff = "";
  try {
    if (existsSync(repoPath)) {
      await runCommand("git", ["fetch", "origin"], repoPath);
      currentDiff = await runCommand(
        "git", ["diff", `origin/${baseBranch}...origin/${branch}`],
        repoPath, { timeout: 30_000 }
      );
    }
  } catch (_) {}

  let taskContext = null;
  if (taskId) {
    try {
      const task = await getTaskById(taskId);
      taskContext = task?.markdown_description || task?.description;
    } catch (_) {}
  }

  return generateFixFromReview({
    prTitle, branch, reviewComments, currentDiff, taskContext, taskId,
  });
}

/**
 * Cancel an active execution by taskId.
 * Kills the spawned Claude Code process(es) for the task (SIGTERM, escalating
 * to SIGKILL after 10s) and cleans up the session entry, so cancelled tasks
 * stop consuming tokens immediately.
 */
export async function cancelExecution(taskId) {
  let found = false;

  // Kill live Claude Code child processes for this task
  const procs = activeProcesses.get(taskId);
  if (procs && procs.size > 0) {
    found = true;
    for (const proc of procs) {
      proc.cancelled = true;
      try {
        proc.kill("SIGTERM");
        logger.info({ taskId, pid: proc.pid }, "Sent SIGTERM to Claude Code process");
      } catch (err) {
        logger.warn({ taskId, pid: proc.pid, err: err.message }, "Failed to SIGTERM Claude Code process");
      }

      // Escalate to SIGKILL if the process is still alive after 10s
      const killTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          try {
            proc.kill("SIGKILL");
            logger.warn({ taskId, pid: proc.pid }, "Escalated to SIGKILL — process did not exit on SIGTERM");
          } catch (_) {}
        }
      }, 10_000);
      if (killTimer.unref) killTimer.unref();
    }
    activeProcesses.delete(taskId);
  }

  for (const [sessionId, sessionData] of activeSessions.entries()) {
    if (sessionData.taskId === taskId) {
      activeSessions.delete(sessionId);
      logger.info({ taskId, sessionId }, "Execution cancelled");
      found = true;
    }
  }

  if (!found) {
    // No active session found for this task - this is OK (task may not be running)
    logger.info({ taskId }, "No active session found to cancel");
  }
  return found;
}

export function getActiveSessions() {
  return [...activeSessions.entries()].map(([id, data]) => ({ id, ...data }));
}

/**
 * Squash-merge a PR via the gh CLI. Used by autoMergeOnApproval when a
 * reviewer approves an AutoShip PR. Throws on failure (branch protection,
 * failing checks, conflicts) — callers treat that as non-fatal.
 */
export async function mergePullRequest(repoFullName, prNumber) {
  await runCommand(
    "gh", ["pr", "merge", String(prNumber), "--repo", repoFullName, "--squash"],
    process.cwd(), { timeout: 30_000 }
  );
  logger.info({ repoFullName, prNumber }, "PR auto-merged after approval");
}

// ── GitHub Webhook Auto-Registration ─────────────────────────────
const _webhookCache = new Set(); // track repos where we've already checked

async function ensureGitHubWebhook(repoFullName, repoPath) {
  if (_webhookCache.has(repoFullName)) return;
  _webhookCache.add(repoFullName);

  const baseUrl = process.env.BASE_URL;
  if (!baseUrl) return; // can't register without a public URL

  const webhookUrl = `${baseUrl}/webhook/github`;
  const requiredEvents = ["pull_request", "pull_request_review", "pull_request_review_comment"];

  try {
    // List existing hooks
    const hooksJson = await runCommand(
      "gh", ["api", `repos/${repoFullName}/hooks`, "--jq", "."],
      repoPath, { timeout: 15_000 }
    );
    const hooks = JSON.parse(hooksJson || "[]");
    const existing = hooks.find((h) => h.config?.url === webhookUrl);

    if (existing) {
      const missing = requiredEvents.filter((e) => !existing.events?.includes(e));
      if (missing.length === 0 && existing.active) return; // all good

      // Update to add missing events
      await runCommand("gh", [
        "api", `repos/${repoFullName}/hooks/${existing.id}`, "-X", "PATCH",
        "-f", `events=${JSON.stringify([...new Set([...existing.events, ...requiredEvents])])}`,
        "-F", "active=true",
      ], repoPath, { timeout: 15_000 });
      logger.info({ repo: repoFullName }, "Updated GitHub webhook with PR review events");
      return;
    }

    // Create new webhook
    const secret = process.env.GITHUB_WEBHOOK_SECRET || "";
    const createArgs = [
      "api", `repos/${repoFullName}/hooks`, "-X", "POST",
      "-f", `config[url]=${webhookUrl}`,
      "-f", "config[content_type]=json",
      "-f", "events=[\"pull_request\",\"pull_request_review\",\"pull_request_review_comment\"]",
      "-F", "active=true",
    ];
    if (secret) createArgs.push("-f", `config[secret]=${secret}`);

    await runCommand("gh", createArgs, repoPath, { timeout: 15_000 });
    logger.info({ repo: repoFullName, webhookUrl }, "Registered GitHub webhook for PR review events");
  } catch (err) {
    logger.warn({ repo: repoFullName, err: err.message }, "Could not register GitHub webhook");
  }
}
