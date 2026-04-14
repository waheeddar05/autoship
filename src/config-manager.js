// src/config-manager.js
// Runtime configuration that can be changed via the dashboard without restarting.
// Reads defaults from process.env, stores overrides in .runtime-config.json.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, "..", ".runtime-config.json");

// Schema: key → { envKey, default, type, label, description, options?, group? }
const SCHEMA = {
  // ── Execution ─────────────────────────────────────────────────
  executionMode: {
    envKey: "EXECUTION_MODE",
    default: "auto",
    type: "select",
    label: "Execution Mode",
    description: "Auto: execute immediately on trigger. Queue: require manual approval first.",
    group: "execution",
    options: [
      { value: "auto", label: "Fully Automatic" },
      { value: "queue", label: "Queue (Manual Approval)" },
    ],
  },
  claudeModel: {
    envKey: "CLAUDE_MODEL",
    default: "claude-opus-4-6",
    type: "select",
    label: "Claude Model",
    description: "AI model used for code generation",
    group: "execution",
    options: [
      { value: "claude-opus-4-6", label: "Claude Opus 4.6 (Most capable)" },
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Fast + capable)" },
      { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (Fastest)" },
    ],
  },
  claudeTimeout: {
    envKey: "CLAUDE_TIMEOUT_MS",
    default: 1800000,
    type: "number",
    label: "Claude Timeout (ms)",
    description: "Max time for Claude to work on a task",
    group: "execution",
    min: 60000,
    max: 7200000,
  },
  maxConcurrentSessions: {
    envKey: "MAX_CONCURRENT_SESSIONS",
    default: 1,
    type: "number",
    label: "Max Concurrent Sessions",
    description: "Maximum parallel Claude sessions",
    group: "execution",
    min: 1,
    max: 5,
  },
  skipPermissions: {
    envKey: "CLAUDE_SKIP_PERMISSIONS",
    default: true,
    type: "boolean",
    label: "Skip Permissions",
    description: "Run Claude with --dangerously-skip-permissions",
    group: "execution",
  },
  autoRetry: {
    envKey: "AUTO_RETRY_ON_FAILURE",
    default: false,
    type: "boolean",
    label: "Auto Retry on Failure",
    description: "Automatically retry failed tasks once",
    group: "execution",
  },

  // ── Trigger ────────────────────────────────────────────────────
  triggerTag: {
    envKey: "TRIGGER_TAG",
    default: "autoship",
    type: "text",
    label: "Trigger Tag",
    description: "Only process ClickUp tasks tagged with this tag (e.g. 'autoship')",
    group: "clickup",
  },

  // ── Slack ─────────────────────────────────────────────────────
  slackChannel: {
    envKey: "SLACK_CHANNEL",
    default: "",
    type: "text",
    label: "Slack Channel",
    description: "Slack channel ID or name for notifications",
    group: "slack",
  },
  slackThreadPerTask: {
    envKey: "SLACK_THREAD_PER_TASK",
    default: true,
    type: "boolean",
    label: "Thread Per Task",
    description: "Create a Slack thread per task for grouped notifications",
    group: "slack",
  },

  // ── Retry / Cost ──────────────────────────────────────────────
  maxRetryAttempts: {
    envKey: "MAX_RETRY_ATTEMPTS",
    default: 3,
    type: "number",
    label: "Max Retry Attempts",
    description: "Maximum number of automatic retry attempts on failure",
    group: "execution",
    min: 0,
    max: 10,
  },
  costTrackingEnabled: {
    envKey: "COST_TRACKING_ENABLED",
    default: true,
    type: "boolean",
    label: "Cost Tracking",
    description: "Track token usage and estimated costs per task step",
    group: "execution",
  },

  // ── ClickUp ───────────────────────────────────────────────────
  clickupWorkspaceId: {
    envKey: "CLICKUP_WORKSPACE_ID",
    default: "",
    type: "text",
    label: "Workspace ID",
    description: "ClickUp Workspace ID",
    group: "clickup",
  },
  clickupSpaceIds: {
    envKey: "CLICKUP_SPACE_IDS",
    default: "",
    type: "text",
    label: "Space IDs",
    description: "Comma-separated ClickUp Space IDs to filter (empty = all)",
    group: "clickup",
  },
  clickupFolderIds: {
    envKey: "CLICKUP_FOLDER_IDS",
    default: "",
    type: "text",
    label: "Folder IDs",
    description: "Comma-separated ClickUp Folder IDs to filter (empty = all)",
    group: "clickup",
  },
  clickupListIds: {
    envKey: "CLICKUP_LIST_IDS",
    default: "",
    type: "text",
    label: "List IDs",
    description: "Comma-separated ClickUp List IDs to filter (empty = all)",
    group: "clickup",
  },
  clickupAssigneeIds: {
    envKey: "CLICKUP_ASSIGNEE_IDS",
    default: "",
    type: "text",
    label: "Assignee IDs",
    description: "Comma-separated ClickUp User IDs to trigger on (empty = CLICKUP_MY_USER_ID)",
    group: "clickup",
  },
  triggerStatuses: {
    envKey: "TRIGGER_STATUSES",
    default: "backlog,ready,to do,open,todo,planning",
    type: "text",
    label: "Trigger Statuses",
    description: "Comma-separated ClickUp statuses that trigger automation",
    group: "clickup",
  },
  triggerEvents: {
    envKey: "TRIGGER_EVENTS",
    default: "assignment,status_change,tag_change,custom_field_change",
    type: "text",
    label: "Trigger Events",
    description: "Comma-separated events: assignment, status_change, tag_change, custom_field_change. WARNING: if empty, no webhooks will trigger!",
    group: "clickup",
  },

  // ── GitHub ────────────────────────────────────────────────────
  githubOrg: {
    envKey: "GITHUB_ORG",
    default: "your-github-org",
    type: "text",
    label: "GitHub Organization",
    description: "Default GitHub org for repo resolution",
    group: "github",
  },
  baseBranch: {
    envKey: "BASE_BRANCH",
    default: "dev",
    type: "select",
    label: "Base Branch",
    description: "Git branch to create feature branches from",
    group: "github",
    options: [
      { value: "dev", label: "dev" },
      { value: "main", label: "main" },
      { value: "master", label: "master" },
      { value: "develop", label: "develop" },
      { value: "staging", label: "staging" },
    ],
  },
  prTitleFormat: {
    envKey: "PR_TITLE_FORMAT",
    default: "#{customId}: {name}",
    type: "text",
    label: "PR Title Format",
    description: "Template: {taskId}, {customId}, {name}, {slug}, {repo}, {runId}",
    group: "github",
  },
  branchNameFormat: {
    envKey: "BRANCH_NAME_FORMAT",
    default: "feature/{taskId}-{slug}-{runId}",
    type: "text",
    label: "Branch Name Format",
    description: "Template: {taskId}, {customId}, {name}, {slug}, {repo}, {runId}",
    group: "github",
  },
  commitMessageFormat: {
    envKey: "COMMIT_MESSAGE_FORMAT",
    default: "#{customId}: {name}",
    type: "text",
    label: "Commit Message Format",
    description: "Template: {taskId}, {customId}, {name}, {slug}, {repo}, {runId}",
    group: "github",
  },
  autoMergeOnApproval: {
    envKey: "AUTO_MERGE_ON_APPROVAL",
    default: false,
    type: "boolean",
    label: "Auto-Merge on Approval",
    description: "Automatically merge PR when approved by reviewers",
    group: "github",
  },
  prReviewers: {
    envKey: "PR_REVIEWERS",
    default: "",
    type: "text",
    label: "PR Reviewers",
    description: "Comma-separated GitHub usernames to auto-assign as PR reviewers",
    group: "github",
  },

  // ── PR Review Handling ────────────────────────────────────────
  prAutoFixEnabled: {
    envKey: "PR_AUTO_FIX_ENABLED",
    default: true,
    type: "boolean",
    label: "Auto-Fix PR Comments",
    description: "Automatically fix code based on PR review comments",
    group: "pr_review",
  },
  prAutoFixRequireApproval: {
    envKey: "PR_AUTO_FIX_REQUIRE_APPROVAL",
    default: false,
    type: "boolean",
    label: "Require Approval for PR Fixes",
    description: "Queue PR review fixes for approval instead of auto-executing",
    group: "pr_review",
  },
  prAutoFixReviewerFilter: {
    envKey: "PR_AUTO_FIX_REVIEWER_FILTER",
    default: "",
    type: "text",
    label: "PR Fix Reviewer Filter",
    description: "Only auto-fix comments from these reviewers (comma-separated, empty = all)",
    group: "pr_review",
  },
  prAutoFixMaxRetries: {
    envKey: "PR_AUTO_FIX_MAX_RETRIES",
    default: 2,
    type: "number",
    label: "Auto-Fix Max Retries",
    description: "Maximum retry attempts for PR auto-fix",
    group: "pr_review",
    min: 0,
    max: 5,
  },
  prAutoFixReRequestReview: {
    envKey: "PR_AUTO_FIX_RE_REQUEST_REVIEW",
    default: true,
    type: "boolean",
    label: "Re-Request Review After Fix",
    description: "Automatically re-request review from the original reviewer after pushing fixes",
    group: "pr_review",
  },

  // ── Test Runner ─────────────────────────────────────────────
  testRunnerEnabled: {
    envKey: "TEST_RUNNER_ENABLED",
    default: false,
    type: "boolean",
    label: "Test Runner",
    description: "Run project tests after code generation, before PR creation",
    group: "execution",
  },
  testRunnerMaxRetries: {
    envKey: "TEST_RUNNER_MAX_RETRIES",
    default: 2,
    type: "number",
    label: "Test Fix Retries",
    description: "Max retries if tests fail (AI attempts to fix failures)",
    group: "execution",
    min: 0,
    max: 5,
  },

  // ── Build Verification ─────────────────────────────────────
  buildVerificationEnabled: {
    envKey: "BUILD_VERIFICATION_ENABLED",
    default: false,
    type: "boolean",
    label: "Build Verification",
    description: "Run a compile/build check after code generation (before tests). Spawns AI fix sessions on failure.",
    group: "execution",
  },
  buildVerificationMaxRetries: {
    envKey: "BUILD_VERIFICATION_MAX_RETRIES",
    default: 3,
    type: "number",
    label: "Build Fix Retries",
    description: "Max retries if build fails (AI attempts to fix build errors)",
    group: "execution",
    min: 0,
    max: 5,
  },

  // ── Slack Interactive Approvals ──────────────────────────────
  slackInteractiveApprovalsEnabled: {
    envKey: "SLACK_INTERACTIVE_APPROVALS_ENABLED",
    default: false,
    type: "boolean",
    label: "Slack Interactive Approvals",
    description: "Send Slack Block Kit messages with Approve/Reject buttons for plan approval",
    group: "slack",
  },

  // ── Diff Preview ────────────────────────────────────────────
  diffPreviewEnabled: {
    envKey: "DIFF_PREVIEW_ENABLED",
    default: false,
    type: "boolean",
    label: "Diff Preview in Plans",
    description: "Generate predicted file impact preview in coding plan comments",
    group: "execution",
  },

  // ── Debate / Multi-Model ────────────────────────────────────
  debateEnabled: {
    envKey: "DEBATE_ENABLED",
    default: false,
    type: "boolean",
    label: "Enable Multi-Model Debate",
    description: "Enable multi-model debate before task execution",
    group: "debate",
  },
  debateStyle: {
    envKey: "DEBATE_STYLE",
    default: "assigned_roles",
    type: "select",
    label: "Debate Style",
    description: "How models participate in the debate",
    group: "debate",
    options: [
      { value: "assigned_roles", label: "Assigned Roles (leader assigns expertise)" },
      { value: "free_debate", label: "Free Debate (all discuss equally)" },
    ],
  },
  debateLeaderModel: {
    envKey: "DEBATE_LEADER_MODEL",
    default: "anthropic:claude-opus-4-6",
    type: "text",
    label: "Leader Model",
    description: "Model that makes final decisions (provider:model format)",
    group: "debate",
  },
  debateParticipants: {
    envKey: "DEBATE_PARTICIPANTS",
    default: "[]",
    type: "text",
    label: "Debate Participants",
    description: 'JSON array: [{"model":"provider:id","role":"Role Name"}]',
    group: "debate",
  },
  debateMaxRounds: {
    envKey: "DEBATE_MAX_ROUNDS",
    default: 2,
    type: "number",
    label: "Max Debate Rounds",
    description: "Maximum debate/revision rounds (1-5)",
    group: "debate",
    min: 1,
    max: 5,
  },
  debateModelTimeout: {
    envKey: "DEBATE_MODEL_TIMEOUT_MS",
    default: 60000,
    type: "number",
    label: "Model Timeout (ms)",
    description: "Timeout per model response during debate",
    group: "debate",
    min: 10000,
    max: 300000,
  },
  debateAutoStart: {
    envKey: "DEBATE_AUTO_START",
    default: true,
    type: "boolean",
    label: "Auto-Start Debate",
    description: "Auto-start debate on task approval (false = manual trigger from UI)",
    group: "debate",
  },
  debateTemperature: {
    envKey: "DEBATE_TEMPERATURE",
    default: 0.7,
    type: "number",
    label: "Debate Temperature",
    description: "Temperature for debate model responses (0.0-1.0)",
    group: "debate",
    min: 0,
    max: 1,
  },
  debateMaxTokens: {
    envKey: "DEBATE_MAX_TOKENS",
    default: 4096,
    type: "number",
    label: "Debate Max Tokens",
    description: "Max tokens per debate model response",
    group: "debate",
    min: 256,
    max: 16384,
  },
  debatePlanInPrompt: {
    envKey: "DEBATE_PLAN_IN_PROMPT",
    default: "full",
    type: "select",
    label: "Plan Injection Mode",
    description: "How the debate plan is injected into the execution prompt",
    group: "debate",
    options: [
      { value: "full", label: "Full plan" },
      { value: "summary", label: "Condensed summary" },
    ],
  },
  debateCustomPrompts: {
    envKey: "DEBATE_CUSTOM_PROMPTS",
    default: "{}",
    type: "text",
    label: "Custom Role Prompts",
    description: "JSON: per-role custom system prompt overrides",
    group: "debate",
  },
  debateRequireApproval: {
    envKey: "DEBATE_REQUIRE_APPROVAL",
    default: true,
    type: "boolean",
    label: "Require Plan Approval",
    description: "Require user to approve debate plan before execution",
    group: "debate",
  },

  // ── Plan Generation & Injection ─────────────────────────────
  planSkipComplexityThreshold: {
    envKey: "PLAN_SKIP_COMPLEXITY_THRESHOLD",
    default: "none",
    type: "select",
    label: "Skip Plan for Simple Tasks",
    description: "Skip plan generation entirely for tasks at or below this complexity level. 'none' = always generate plans.",
    group: "debate",
    options: [
      { value: "none", label: "None (always generate plans)" },
      { value: "simple", label: "Simple (skip for score ≤ 20)" },
      { value: "medium", label: "Medium (skip for score ≤ 45)" },
    ],
  },
  planInjectionSkipThreshold: {
    envKey: "PLAN_INJECTION_SKIP_THRESHOLD",
    default: "none",
    type: "select",
    label: "Skip Plan Injection",
    description: "Skip injecting the approved plan into the execution prompt for tasks at or below this complexity. 'none' = always inject.",
    group: "debate",
    options: [
      { value: "none", label: "None (always inject plan)" },
      { value: "simple", label: "Simple (skip injection for score ≤ 20)" },
      { value: "medium", label: "Medium (skip injection for score ≤ 45)" },
    ],
  },
  planFramingMode: {
    envKey: "PLAN_FRAMING_MODE",
    default: "mandatory",
    type: "select",
    label: "Plan Framing Strictness",
    description: "How strictly Claude Code should follow the injected plan. 'mandatory' = exact step-by-step. 'guide' = use as reference, batch changes efficiently.",
    group: "debate",
    options: [
      { value: "mandatory", label: "Mandatory (follow plan exactly)" },
      { value: "guide", label: "Guide (use as reference, be efficient)" },
      { value: "adaptive", label: "Adaptive (mandatory for complex, guide for simple/medium)" },
    ],
  },

  // ── Execution Model ────────────────────────────────────────
  executionModel: {
    envKey: "EXECUTION_MODEL",
    default: "claude-opus-4-6",
    type: "text",
    label: "Execution Model",
    description: "Anthropic model for Claude Code CLI execution",
    group: "execution",
  },
  executionModelMode: {
    envKey: "EXECUTION_MODEL_MODE",
    default: "fixed",
    type: "select",
    label: "Execution Model Selection",
    description: "How the execution model is chosen",
    group: "execution",
    options: [
      { value: "fixed", label: "Fixed (always use configured model)" },
      { value: "leader_selects", label: "Leader Selects (debate leader picks model)" },
    ],
  },

  // ── Server ────────────────────────────────────────────────────
  // ── Project Context (Feature 3) ──────────────────────────────
  projectContextEnabled: {
    envKey: "PROJECT_CONTEXT_ENABLED",
    default: true,
    type: "boolean",
    label: "Project Context",
    description: "Detect project type and prepend context to Claude prompts",
    group: "execution",
  },

  // ── Multi-Repo (Feature 4) ────────────────────────────────
  multiRepoEnabled: {
    envKey: "MULTI_REPO_ENABLED",
    default: false,
    type: "boolean",
    label: "Multi-Repo Orchestration",
    description: "Enable orchestration across multiple repositories",
    group: "execution",
  },
  multiRepoParallel: {
    envKey: "MULTI_REPO_PARALLEL",
    default: false,
    type: "boolean",
    label: "Parallel Multi-Repo",
    description: "Execute multi-repo sub-tasks in parallel",
    group: "execution",
  },
  multiRepoMaxRepos: {
    envKey: "MULTI_REPO_MAX_REPOS",
    default: 3,
    type: "number",
    label: "Max Repos per Task",
    description: "Maximum repositories in a multi-repo task",
    group: "execution",
    min: 2,
    max: 10,
  },

  // ── Codebase Index (Feature 7) ────────────────────────────
  codebaseIndexEnabled: {
    envKey: "CODEBASE_INDEX_ENABLED",
    default: true,
    type: "boolean",
    label: "Codebase Indexing",
    description: "Index repos and include relevant context in prompts",
    group: "execution",
  },
  codebaseIndexMaxTokens: {
    envKey: "CODEBASE_INDEX_MAX_TOKENS",
    default: 4000,
    type: "number",
    label: "Index Max Tokens",
    description: "Max tokens for codebase context in prompts",
    group: "execution",
    min: 500,
    max: 16000,
  },

  // ── Analytics / ROI (Feature 15) ──────────────────────────
  developerHourlyRate: {
    envKey: "DEVELOPER_HOURLY_RATE",
    default: 20,
    type: "number",
    label: "Developer Hourly Rate ($)",
    description: "Estimated developer hourly rate for ROI calculations",
    group: "analytics",
    min: 5,
    max: 500,
  },
  simpleTaskHours: {
    envKey: "SIMPLE_TASK_HOURS",
    default: 16,
    type: "number",
    label: "Simple Task Hours",
    description: "Estimated hours a developer would spend on a simple task manually (~2 days)",
    group: "analytics",
    min: 4,
    max: 80,
  },
  mediumTaskHours: {
    envKey: "MEDIUM_TASK_HOURS",
    default: 24,
    type: "number",
    label: "Medium Task Hours",
    description: "Estimated hours a developer would spend on a medium task manually (~3 days)",
    group: "analytics",
    min: 8,
    max: 120,
  },
  complexTaskHours: {
    envKey: "COMPLEX_TASK_HOURS",
    default: 40,
    type: "number",
    label: "Complex Task Hours",
    description: "Estimated hours a developer would spend on a complex task manually (~5 days)",
    group: "analytics",
    min: 16,
    max: 200,
  },

  // ── Weekly Digest (Feature 17) ────────────────────────────
  weeklyDigestEnabled: {
    envKey: "WEEKLY_DIGEST_ENABLED",
    default: true,
    type: "boolean",
    label: "Weekly Digest",
    description: "Send weekly summary digest to Slack",
    group: "slack",
  },
  weeklyDigestDay: {
    envKey: "WEEKLY_DIGEST_DAY",
    default: "monday",
    type: "select",
    label: "Digest Day",
    description: "Day of week for weekly digest",
    group: "slack",
    options: [
      { value: "monday", label: "Monday" },
      { value: "tuesday", label: "Tuesday" },
      { value: "wednesday", label: "Wednesday" },
      { value: "thursday", label: "Thursday" },
      { value: "friday", label: "Friday" },
    ],
  },
  weeklyDigestHour: {
    envKey: "WEEKLY_DIGEST_HOUR",
    default: 9,
    type: "number",
    label: "Digest Hour",
    description: "Hour of day (0-23) for weekly digest",
    group: "slack",
    min: 0,
    max: 23,
  },

  // ── Server ────────────────────────────────────────────────────
  mode: {
    envKey: "MODE",
    default: "webhook",
    type: "select",
    label: "Server Mode",
    description: "How the server receives tasks",
    group: "server",
    options: [
      { value: "webhook", label: "Webhook (ClickUp pushes events)" },
      { value: "poller", label: "Poller (polls ClickUp every N seconds)" },
      { value: "both", label: "Both (webhook + poller)" },
    ],
  },
  pollInterval: {
    envKey: "POLL_INTERVAL_MS",
    default: 120000,
    type: "number",
    label: "Poll Interval (ms)",
    description: "How often to poll ClickUp (poller mode)",
    group: "server",
    min: 30000,
    max: 600000,
  },
};

// ── Configuration Presets ─────────────────────────────────────────
// Each preset defines a set of config overrides to apply at once.
const PRESETS = {
  simple: {
    name: "Simple",
    description: "Single model, auto-execute. Best for quick prototyping — no approval queue, no debate.",
    icon: "⚡",
    settings: {
      executionMode: "auto",
      claudeModel: "claude-sonnet-4-6",
      executionModel: "claude-sonnet-4-6",
      executionModelMode: "fixed",
      maxConcurrentSessions: 1,
      claudeTimeout: 1200000,
      skipPermissions: true,
      autoRetry: false,
      debateEnabled: false,
      debateAutoStart: false,
      debateRequireApproval: false,
    },
  },
  standard: {
    name: "Standard",
    description: "Single model with queue approval. Tasks are queued for review before execution — no debate.",
    icon: "🛡️",
    settings: {
      executionMode: "queue",
      claudeModel: "claude-opus-4-6",
      executionModel: "claude-opus-4-6",
      executionModelMode: "fixed",
      maxConcurrentSessions: 1,
      claudeTimeout: 1800000,
      skipPermissions: true,
      autoRetry: false,
      debateEnabled: false,
      debateAutoStart: false,
      debateRequireApproval: false,
    },
  },
  multi_model: {
    name: "Multi-Model",
    description: "Multi-model debate with assigned roles. Multiple AI models review tasks before execution.",
    icon: "🧠",
    settings: {
      executionMode: "queue",
      claudeModel: "claude-opus-4-6",
      executionModel: "claude-opus-4-6",
      executionModelMode: "fixed",
      maxConcurrentSessions: 1,
      claudeTimeout: 1800000,
      skipPermissions: true,
      autoRetry: false,
      debateEnabled: true,
      debateStyle: "assigned_roles",
      debateLeaderModel: "anthropic:claude-opus-4-6",
      debateParticipants: JSON.stringify([
        { model: "anthropic:claude-sonnet-4-6", role: "Backend Architect" },
        { model: "openai:gpt-4o", role: "Security Reviewer" },
      ]),
      debateMaxRounds: 2,
      debateModelTimeout: 60000,
      debateAutoStart: true,
      debateTemperature: 0.7,
      debateMaxTokens: 4096,
      debateRequireApproval: true,
    },
  },
  multi_model_advanced: {
    name: "Multi-Model Advanced",
    description: "Full debate with leader-selected execution. Leader picks the best model and 3 participants debate freely.",
    icon: "🚀",
    settings: {
      executionMode: "queue",
      claudeModel: "claude-opus-4-6",
      executionModel: "claude-opus-4-6",
      executionModelMode: "leader_selects",
      maxConcurrentSessions: 2,
      claudeTimeout: 1800000,
      skipPermissions: true,
      autoRetry: true,
      debateEnabled: true,
      debateStyle: "free_debate",
      debateLeaderModel: "anthropic:claude-opus-4-6",
      debateParticipants: JSON.stringify([
        { model: "anthropic:claude-sonnet-4-6", role: "Software Engineer" },
        { model: "openai:gpt-4o", role: "Code Reviewer" },
        { model: "openai:o3-mini", role: "Performance Analyst" },
      ]),
      debateMaxRounds: 3,
      debateModelTimeout: 90000,
      debateAutoStart: true,
      debateTemperature: 0.7,
      debateMaxTokens: 8192,
      debateRequireApproval: true,
    },
  },
};

class ConfigManager {
  constructor() {
    this.overrides = this._loadOverridesFromFile();
    this._dbReady = false;
  }

  /**
   * Initialize DB-backed persistence. Call once after DB pool is ready.
   * Loads overrides from DB (merging with any file-based ones) and
   * migrates file overrides to DB if present.
   */
  async initFromDb(pool) {
    this._pool = pool;
    try {
      // Ensure table exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS config_overrides (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // Load from DB
      const { rows } = await pool.query("SELECT key, value FROM config_overrides");
      const dbOverrides = {};
      for (const row of rows) {
        dbOverrides[row.key] = row.value;
      }

      // Migrate file overrides to DB if they exist and DB is empty
      const fileOverrides = this._loadOverridesFromFile();
      if (Object.keys(fileOverrides).length > 0 && rows.length === 0) {
        for (const [k, v] of Object.entries(fileOverrides)) {
          await pool.query(
            `INSERT INTO config_overrides (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
            [k, JSON.stringify(v)]
          );
        }
        Object.assign(dbOverrides, fileOverrides);
      }

      this.overrides = dbOverrides;
      this._dbReady = true;
    } catch (err) {
      // Fall back to file-based if DB fails
      console.error("[ConfigManager] DB init failed, using file fallback:", err.message);
    }
  }

  _loadOverridesFromFile() {
    try {
      if (existsSync(CONFIG_FILE)) {
        return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      }
    } catch (_) {}
    return {};
  }

  _saveOverrides() {
    // Save to DB if available
    if (this._dbReady && this._pool) {
      // Fire-and-forget DB writes
      for (const [k, v] of Object.entries(this.overrides)) {
        this._pool.query(
          `INSERT INTO config_overrides (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
          [k, JSON.stringify(v)]
        ).catch(() => {});
      }
    }
    // Also save to file as backup
    try {
      writeFileSync(CONFIG_FILE, JSON.stringify(this.overrides, null, 2));
    } catch (_) {}
  }

  /** Get a single config value (override > env > default) */
  get(key) {
    const schema = SCHEMA[key];
    if (!schema) return undefined;

    if (key in this.overrides) return this.overrides[key];
    if (schema.envKey && process.env[schema.envKey]) {
      const envVal = process.env[schema.envKey];
      if (schema.type === "number") return parseInt(envVal, 10);
      if (schema.type === "boolean") return envVal === "true";
      return envVal;
    }
    return schema.default;
  }

  /**
   * Get a JSON config value parsed. Returns null on parse failure.
   */
  getJSON(key) {
    const val = this.get(key);
    if (!val || typeof val !== "string") return val;
    try { return JSON.parse(val); } catch { return null; }
  }

  /**
   * Get a comma-separated config value as an array of trimmed strings.
   * Returns empty array if value is empty/undefined.
   */
  getList(key) {
    const val = this.get(key);
    if (!val || typeof val !== "string") return [];
    return val.split(",").map((s) => s.trim()).filter(Boolean);
  }

  /** Set a runtime override */
  set(key, value) {
    if (!SCHEMA[key]) throw new Error(`Unknown config key: ${key}`);
    this.overrides[key] = value;
    this._saveOverrides();
  }

  /** Remove a runtime override (revert to env/default) */
  reset(key) {
    delete this.overrides[key];
    this._saveOverrides();
    // Also remove from DB
    if (this._dbReady && this._pool) {
      this._pool.query("DELETE FROM config_overrides WHERE key = $1", [key]).catch(() => {});
    }
  }

  /** Get all config values with their schema for the dashboard */
  getAll() {
    const result = {};
    for (const [key, schema] of Object.entries(SCHEMA)) {
      result[key] = {
        ...schema,
        value: this.get(key),
        isOverridden: key in this.overrides,
      };
    }
    return result;
  }

  /** Get config values grouped by group name */
  getAllGrouped() {
    const groups = {};
    for (const [key, schema] of Object.entries(SCHEMA)) {
      const group = schema.group || "general";
      if (!groups[group]) groups[group] = {};
      groups[group][key] = {
        ...schema,
        value: this.get(key),
        isOverridden: key in this.overrides,
      };
    }
    return groups;
  }

  /** Get schema (for UI rendering) */
  getSchema() {
    return SCHEMA;
  }

  /** Get available configuration presets. */
  getPresets() {
    return Object.entries(PRESETS).map(([id, preset]) => ({
      id,
      name: preset.name,
      description: preset.description,
      icon: preset.icon,
      debateEnabled: !!preset.settings.debateEnabled,
    }));
  }

  /**
   * Apply a configuration preset.
   * Sets all config keys in the preset's settings as runtime overrides.
   * @param {string} presetId
   * @returns {{ applied: string[], preset: object }}
   */
  applyPreset(presetId) {
    const preset = PRESETS[presetId];
    if (!preset) throw new Error(`Unknown preset: ${presetId}`);

    const applied = [];
    for (const [key, value] of Object.entries(preset.settings)) {
      if (SCHEMA[key]) {
        this.overrides[key] = value;
        applied.push(key);
      }
    }
    this._saveOverrides();

    return { applied, preset: { id: presetId, name: preset.name } };
  }
}

export const config = new ConfigManager();
