// src/db.js
// PostgreSQL connection pool, schema initialization, and migration from JSON files.

import pg from "pg";
import { readFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://localhost:5432/clickup_automation";

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  logger.error({ err: err.message }, "Unexpected PostgreSQL pool error");
});

// ── Schema SQL ──────────────────────────────────────────────────

const SCHEMA_SQL = `
-- Core task queue table
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  clickup_task_id TEXT NOT NULL,
  clickup_custom_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  markdown_description TEXT,
  status TEXT,
  priority TEXT,
  tags JSONB DEFAULT '[]',
  assignees JSONB DEFAULT '[]',
  repo_full_name TEXT,
  repo_name TEXT,
  branch_name TEXT,
  pr_url TEXT,
  pr_number INTEGER,

  state TEXT NOT NULL DEFAULT 'received',
  custom_instructions TEXT,
  modified_description TEXT,

  claude_output TEXT,
  error_message TEXT,
  last_step TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 1,

  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  queued_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  duration_ms INTEGER,
  clickup_task_json JSONB
);

-- Partial unique index: only one active task per ClickUp task ID.
-- Excludes terminal states so the same task can be re-enqueued after completion/deletion.
-- Migration: clean up any duplicate active rows first (keep the latest), then recreate index.
DO $$ BEGIN
  -- Step 1: Remove duplicates — keep only the row with the highest id per clickup_task_id
  -- among active rows (those NOT in success/failed/deleted).
  DELETE FROM tasks a USING tasks b
  WHERE a.clickup_task_id = b.clickup_task_id
    AND a.id < b.id
    AND a.state NOT IN ('success', 'failed', 'deleted')
    AND b.state NOT IN ('success', 'failed', 'deleted');

  -- Step 2: Drop old index (might have wrong predicate without 'deleted')
  DROP INDEX IF EXISTS idx_tasks_active;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active
  ON tasks(clickup_task_id) WHERE state NOT IN ('success', 'failed', 'deleted');

CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_received ON tasks(received_at);

-- Chat messages for post-execution interaction
CREATE TABLE IF NOT EXISTS task_messages (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_task ON task_messages(task_id);

-- PR review tracking
CREATE TABLE IF NOT EXISTS pr_reviews (
  id SERIAL PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id),
  pr_number INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  branch TEXT,
  state TEXT NOT NULL DEFAULT 'received',
  review_comments JSONB,
  claude_output TEXT,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Execution log entries
CREATE TABLE IF NOT EXISTS execution_logs (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  step TEXT,
  message TEXT NOT NULL,
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exec_logs_task ON execution_logs(task_id);

-- Debate sessions for multi-model planning
CREATE TABLE IF NOT EXISTS debate_sessions (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending',

  leader_model TEXT NOT NULL,
  participants JSONB NOT NULL DEFAULT '[]',
  debate_style TEXT NOT NULL DEFAULT 'assigned_roles',
  execution_model TEXT,

  max_rounds INTEGER DEFAULT 2,
  actual_rounds INTEGER DEFAULT 0,

  final_plan TEXT,
  transcript JSONB DEFAULT '[]',

  error_message TEXT,
  degraded BOOLEAN DEFAULT FALSE,

  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_debate_task ON debate_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_debate_state ON debate_sessions(state);

-- Link tasks to debate sessions
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='tasks' AND column_name='debate_session_id') THEN
    ALTER TABLE tasks ADD COLUMN debate_session_id INTEGER REFERENCES debate_sessions(id);
  END IF;
END $$;

-- Users table for authentication and RBAC
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  image TEXT,
  role VARCHAR(20) NOT NULL DEFAULT 'READ_ONLY',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Session store table for connect-pg-simple
CREATE TABLE IF NOT EXISTS session (
  sid VARCHAR NOT NULL COLLATE "default",
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  PRIMARY KEY (sid)
);

CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);

-- Admin workflow configuration
CREATE TABLE IF NOT EXISTS admin_workflow_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  quality_check_reject_flow BOOLEAN DEFAULT FALSE,
  quality_check_approve_flow BOOLEAN DEFAULT FALSE,
  quality_score_threshold INTEGER DEFAULT 70,
  reject_status TEXT DEFAULT 'In Review',
  approve_status TEXT DEFAULT 'Development',
  pr_raised_status TEXT DEFAULT 'PR Raised',
  approval_keywords JSONB DEFAULT '["approved", "LGTM", "approve"]',
  needs_revision_tag TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1)
);

-- Seed default row if not exists
INSERT INTO admin_workflow_config (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Workflow approval tracking (prevents re-triggering)
CREATE TABLE IF NOT EXISTS workflow_approvals (
  id SERIAL PRIMARY KEY,
  clickup_task_id TEXT NOT NULL,
  coding_plan TEXT,
  quality_score INTEGER,
  quality_summary TEXT,
  state TEXT NOT NULL DEFAULT 'pending_approval',
  approved_at TIMESTAMPTZ,
  pr_url TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wf_approvals_task ON workflow_approvals(clickup_task_id);
CREATE INDEX IF NOT EXISTS idx_wf_approvals_state ON workflow_approvals(state);

-- Cost tracking table
CREATE TABLE IF NOT EXISTS task_costs (
  id SERIAL PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  step_name TEXT NOT NULL,
  model_used TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  estimated_cost DECIMAL(10,6) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_costs_task ON task_costs(task_id);

-- Org-level integration tokens (admin fallback)
CREATE TABLE IF NOT EXISTS org_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(50) NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  provider_user_id VARCHAR(255),
  provider_account_name VARCHAR(255),
  scopes TEXT,
  connected_by UUID REFERENCES users(id),
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

-- Per-user integration tokens
CREATE TABLE IF NOT EXISTS user_integrations (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  provider_user_id VARCHAR(255),
  provider_username VARCHAR(255),
  scopes TEXT,
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, provider)
);

-- OAuth state tokens (CSRF protection for OAuth flows)
CREATE TABLE IF NOT EXISTS oauth_states (
  state VARCHAR(64) PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
`;

// ── Initialize ──────────────────────────────────────────────────

async function initialize() {
  const safeUrl = DATABASE_URL.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
  logger.info({ url: safeUrl }, "Connecting to PostgreSQL");

  try {
    await pool.query(SCHEMA_SQL);
    logger.info("Database schema initialized");
  } catch (err) {
    logger.error({ err: err.message }, "Failed to initialize database schema");
    throw err;
  }

  // ── Schema migrations (ALTER TABLE IF) ──────────────────────
  const migrations = [
    // Step tracking JSONB column on tasks
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='task_steps') THEN
        ALTER TABLE tasks ADD COLUMN task_steps JSONB DEFAULT '[]';
      END IF;
    END $$;`,
    // Triggered-at timestamp
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='triggered_at') THEN
        ALTER TABLE tasks ADD COLUMN triggered_at TIMESTAMPTZ;
      END IF;
    END $$;`,
    // Slack thread TS
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='slack_thread_ts') THEN
        ALTER TABLE tasks ADD COLUMN slack_thread_ts TEXT;
      END IF;
    END $$;`,
    // Failure stage
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='failure_stage') THEN
        ALTER TABLE tasks ADD COLUMN failure_stage TEXT;
      END IF;
    END $$;`,
    // User activity tracking
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='last_active_at') THEN
        ALTER TABLE users ADD COLUMN last_active_at TIMESTAMPTZ;
      END IF;
    END $$;`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='activity_source') THEN
        ALTER TABLE users ADD COLUMN activity_source TEXT;
      END IF;
    END $$;`,
    // Feature 4: Multi-repo parent reference
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='multi_repo_parent_id') THEN
        ALTER TABLE tasks ADD COLUMN multi_repo_parent_id INTEGER REFERENCES tasks(id);
      END IF;
    END $$;`,
    // Feature 16: Complexity scoring
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='complexity_score') THEN
        ALTER TABLE tasks ADD COLUMN complexity_score INTEGER;
      END IF;
    END $$;`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='complexity_level') THEN
        ALTER TABLE tasks ADD COLUMN complexity_level TEXT;
      END IF;
    END $$;`,
    // Feature 10: PR outcomes table
    `CREATE TABLE IF NOT EXISTS pr_outcomes (
      id SERIAL PRIMARY KEY,
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      pr_url TEXT,
      merged BOOLEAN DEFAULT FALSE,
      changes_requested BOOLEAN DEFAULT FALSE,
      review_comments JSONB DEFAULT '[]',
      revisions INTEGER DEFAULT 0,
      time_to_merge_ms BIGINT,
      merged_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_pr_outcomes_task ON pr_outcomes(task_id);`,
    `CREATE INDEX IF NOT EXISTS idx_pr_outcomes_pr_url ON pr_outcomes(pr_url);`,
    // Plan approval gating: store plan comment ID and posting timestamp
    // Repo validation toggle on workflow config
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='admin_workflow_config' AND column_name='require_repo_field') THEN
        ALTER TABLE admin_workflow_config ADD COLUMN require_repo_field BOOLEAN DEFAULT FALSE;
      END IF;
    END $$;`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflow_approvals' AND column_name='plan_comment_id') THEN
        ALTER TABLE workflow_approvals ADD COLUMN plan_comment_id TEXT;
      END IF;
    END $$;`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflow_approvals' AND column_name='plan_posted_at') THEN
        ALTER TABLE workflow_approvals ADD COLUMN plan_posted_at TIMESTAMPTZ;
      END IF;
    END $$;`,
    // ClickUp user ID mapping for webhook assignee resolution
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='clickup_user_id') THEN
        ALTER TABLE users ADD COLUMN clickup_user_id VARCHAR(255);
      END IF;
    END $$;`,
    // Debate complexity threshold: only run debate for tasks at or above this complexity level
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='admin_workflow_config' AND column_name='debate_complexity_threshold') THEN
        ALTER TABLE admin_workflow_config ADD COLUMN debate_complexity_threshold TEXT DEFAULT 'complex';
      END IF;
    END $$;`,
    // Feature: Auto-fix enabled toggle on workflow config
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='admin_workflow_config' AND column_name='auto_fix_enabled') THEN
        ALTER TABLE admin_workflow_config ADD COLUMN auto_fix_enabled BOOLEAN DEFAULT TRUE;
      END IF;
    END $$;`,
    // Feature: Auto-fix attempt tracking table
    `CREATE TABLE IF NOT EXISTS auto_fix_attempts (
      id SERIAL PRIMARY KEY,
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      pr_review_id INTEGER REFERENCES pr_reviews(id) ON DELETE CASCADE,
      pr_number INTEGER,
      repo_full_name TEXT,
      review_comments JSONB DEFAULT '[]',
      fix_instructions TEXT,
      fix_summary TEXT,
      success BOOLEAN DEFAULT FALSE,
      error_message TEXT,
      duration_ms INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_auto_fix_task ON auto_fix_attempts(task_id);`,
    `CREATE INDEX IF NOT EXISTS idx_auto_fix_pr ON auto_fix_attempts(pr_number);`,
    // Feature: Test run results tracking table
    `CREATE TABLE IF NOT EXISTS test_run_results (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      repo_full_name TEXT,
      passed BOOLEAN NOT NULL,
      test_output TEXT,
      test_summary TEXT,
      retry_count INTEGER DEFAULT 0,
      duration_ms INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_test_runs_task ON test_run_results(task_id);`,
    // Feature: Test results summary on tasks
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='test_results_summary') THEN
        ALTER TABLE tasks ADD COLUMN test_results_summary TEXT;
      END IF;
    END $$;`,
    // Feature: Diff preview accuracy tracking table
    `CREATE TABLE IF NOT EXISTS diff_preview_accuracy (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      accuracy INTEGER,
      predicted_count INTEGER,
      actual_count INTEGER,
      correctly_predicted INTEGER,
      missed INTEGER,
      false_positives INTEGER,
      details JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_diff_accuracy_task ON diff_preview_accuracy(task_id);`,
    // Feature: Slack approval message tracking on workflow_approvals
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflow_approvals' AND column_name='slack_message_ts') THEN
        ALTER TABLE workflow_approvals ADD COLUMN slack_message_ts TEXT;
      END IF;
    END $$;`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflow_approvals' AND column_name='slack_channel_id') THEN
        ALTER TABLE workflow_approvals ADD COLUMN slack_channel_id TEXT;
      END IF;
    END $$;`,
    // Feature: Diff preview text on workflow_approvals
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflow_approvals' AND column_name='diff_preview') THEN
        ALTER TABLE workflow_approvals ADD COLUMN diff_preview TEXT;
      END IF;
    END $$;`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflow_approvals' AND column_name='predicted_files') THEN
        ALTER TABLE workflow_approvals ADD COLUMN predicted_files JSONB DEFAULT '[]';
      END IF;
    END $$;`,
    // Rename EDITOR role to DEVELOPER
    `UPDATE users SET role = 'DEVELOPER' WHERE role = 'EDITOR';`,

    // ── New Feature Tables ─────────────────────────────────────────

    // Repo lessons (closed-loop learning pipeline)
    `CREATE TABLE IF NOT EXISTS repo_lessons (
      id SERIAL PRIMARY KEY,
      repo_full_name TEXT NOT NULL,
      task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      pr_number INTEGER,
      category TEXT NOT NULL,
      lesson TEXT NOT NULL,
      file_path TEXT,
      severity TEXT DEFAULT 'minor',
      original_comment TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_repo_lessons_repo ON repo_lessons(repo_full_name);`,
    `CREATE INDEX IF NOT EXISTS idx_repo_lessons_category ON repo_lessons(category);`,

    // Task subtasks (task decomposition)
    `CREATE TABLE IF NOT EXISTS task_subtasks (
      id SERIAL PRIMARY KEY,
      parent_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      "order" INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT DEFAULT 'service',
      estimated_complexity TEXT DEFAULT 'medium',
      depends_on JSONB DEFAULT '[]',
      verification_steps JSONB DEFAULT '[]',
      state TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      verification_result TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );`,
    `CREATE INDEX IF NOT EXISTS idx_subtasks_parent ON task_subtasks(parent_task_id);`,
    `CREATE INDEX IF NOT EXISTS idx_subtasks_state ON task_subtasks(state);`,

    // Task checkpoints (execution recovery)
    `CREATE TABLE IF NOT EXISTS task_checkpoints (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      step TEXT NOT NULL,
      state JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(task_id, step)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON task_checkpoints(task_id);`,

    // Cost anomalies
    `CREATE TABLE IF NOT EXISTS cost_anomalies (
      id SERIAL PRIMARY KEY,
      task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      task_name TEXT,
      current_cost DECIMAL(10,6),
      avg_cost DECIMAL(10,6),
      reason TEXT,
      total_tokens INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_cost_anomalies_task ON cost_anomalies(task_id);`,

    // Config audit log
    `CREATE TABLE IF NOT EXISTS config_audit_log (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      source TEXT,
      config_key TEXT NOT NULL,
      old_value JSONB,
      new_value JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_config_audit_key ON config_audit_log(config_key);`,
    `CREATE INDEX IF NOT EXISTS idx_config_audit_time ON config_audit_log(created_at);`,

    // Multi-PR plans (orchestration)
    `CREATE TABLE IF NOT EXISTS multi_pr_plans (
      id SERIAL PRIMARY KEY,
      parent_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      repo_full_name TEXT,
      pr_type TEXT,
      depends_on_indices JSONB DEFAULT '[]',
      state TEXT NOT NULL DEFAULT 'pending',
      "order" INTEGER DEFAULT 0,
      pr_url TEXT,
      pr_number INTEGER,
      branch_name TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );`,
    `CREATE INDEX IF NOT EXISTS idx_multi_pr_parent ON multi_pr_plans(parent_task_id);`,

    // Prompt variants (A/B testing / prompt evolution)
    `CREATE TABLE IF NOT EXISTS prompt_variants (
      id SERIAL PRIMARY KEY,
      task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      prompt_type TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      variant_hash TEXT,
      repo_full_name TEXT,
      merged BOOLEAN,
      revisions_needed INTEGER,
      time_to_merge_ms BIGINT,
      outcome_recorded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(task_id, prompt_type)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_prompt_variants_type ON prompt_variants(prompt_type);`,
    `CREATE INDEX IF NOT EXISTS idx_prompt_variants_variant ON prompt_variants(variant_id);`,

    // Self-review results column on tasks
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='self_review_score') THEN
        ALTER TABLE tasks ADD COLUMN self_review_score INTEGER;
      END IF;
    END $$;`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='self_review_passed') THEN
        ALTER TABLE tasks ADD COLUMN self_review_passed BOOLEAN;
      END IF;
    END $$;`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='self_review_iterations') THEN
        ALTER TABLE tasks ADD COLUMN self_review_iterations INTEGER DEFAULT 0;
      END IF;
    END $$;`,

    // LLM complexity columns on tasks
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='llm_complexity_score') THEN
        ALTER TABLE tasks ADD COLUMN llm_complexity_score INTEGER;
      END IF;
    END $$;`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='complexity_risks') THEN
        ALTER TABLE tasks ADD COLUMN complexity_risks JSONB DEFAULT '[]';
      END IF;
    END $$;`,

    // Failure post-mortems: root-cause taxonomy per failed task
    `CREATE TABLE IF NOT EXISTS failure_causes (
      id SERIAL PRIMARY KEY,
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      task_name TEXT,
      repo_full_name TEXT,
      failure_stage TEXT,
      category TEXT NOT NULL,
      summary TEXT,
      recommendation TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_failure_causes_category ON failure_causes(category)`,
    `CREATE INDEX IF NOT EXISTS idx_failure_causes_created ON failure_causes(created_at)`,

    // Prompt evolution: store the prompt configuration descriptor so the
    // best-performing variant can be mapped back to actual settings
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='prompt_variants' AND column_name='prompt_content') THEN
        ALTER TABLE prompt_variants ADD COLUMN prompt_content TEXT;
      END IF;
    END $$;`,

    // Decomposition flag on tasks
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='decomposed') THEN
        ALTER TABLE tasks ADD COLUMN decomposed BOOLEAN DEFAULT FALSE;
      END IF;
    END $$;`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='subtask_count') THEN
        ALTER TABLE tasks ADD COLUMN subtask_count INTEGER DEFAULT 0;
      END IF;
    END $$;`,
  ];

  for (const migration of migrations) {
    try {
      await pool.query(migration);
    } catch (err) {
      logger.warn({ err: err.message }, "Migration step failed (non-fatal)");
    }
  }
  logger.info("Schema migrations applied");

  // Seed admin user
  await seedAdminUser();

  // Migrate JSON files if they exist and tables are empty
  await migrateJsonFiles();
}

// ── Migration from JSON files ───────────────────────────────────

async function migrateJsonFiles() {
  const processedFile = path.join(__dirname, "..", ".processed-tasks.json");
  const metricsFile = path.join(__dirname, "..", ".metrics.json");

  // Check if we already have data
  const { rows } = await pool.query("SELECT COUNT(*) as count FROM tasks");
  if (parseInt(rows[0].count, 10) > 0) {
    logger.debug("Tasks table already has data, skipping JSON migration");
    return;
  }

  let migrated = 0;

  // Migrate processed tasks
  if (existsSync(processedFile)) {
    try {
      const processedIds = JSON.parse(readFileSync(processedFile, "utf-8"));
      for (const taskId of processedIds) {
        await pool.query(
          `INSERT INTO tasks (clickup_task_id, name, state, completed_at)
           VALUES ($1, $2, 'success', NOW())
           ON CONFLICT DO NOTHING`,
          [taskId, `Migrated task ${taskId}`]
        );
        migrated++;
      }
      logger.info({ count: migrated }, "Migrated processed tasks from JSON");
    } catch (err) {
      logger.warn({ err: err.message }, "Could not migrate processed tasks JSON");
    }
  }

  // Migrate metrics task history
  if (existsSync(metricsFile)) {
    try {
      const metricsData = JSON.parse(readFileSync(metricsFile, "utf-8"));
      const tasks = metricsData.tasks || [];
      for (const t of tasks) {
        if (!t.id) continue;
        // Skip if already migrated from processed tasks
        const existing = await pool.query(
          "SELECT id FROM tasks WHERE clickup_task_id = $1",
          [t.id]
        );
        if (existing.rows.length > 0) continue;

        await pool.query(
          `INSERT INTO tasks (clickup_task_id, name, repo_full_name, branch_name, pr_url,
            state, error_message, duration_ms, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT DO NOTHING`,
          [
            t.id,
            t.name || `Task ${t.id}`,
            t.repo || null,
            t.branch || null,
            t.prUrl || null,
            t.status === "success" ? "success" : t.status === "failed" ? "failed" : "success",
            t.error || null,
            t.duration || null,
            t.completedAt || new Date().toISOString(),
          ]
        );
        migrated++;
      }
      logger.info({ count: tasks.length }, "Migrated metrics task history from JSON");
    } catch (err) {
      logger.warn({ err: err.message }, "Could not migrate metrics JSON");
    }
  }

  // Rename JSON files as backup
  if (migrated > 0) {
    try {
      if (existsSync(processedFile)) renameSync(processedFile, processedFile + ".bak");
      if (existsSync(metricsFile)) renameSync(metricsFile, metricsFile + ".bak");
      logger.info("Renamed JSON state files to .bak");
    } catch (_) {}
  }
}

// ── Seed admin user ─────────────────────────────────────────────

async function seedAdminUser() {
  const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
  try {
    await pool.query(
      `INSERT INTO users (email, name, role)
       VALUES ($1, $2, 'ADMIN')
       ON CONFLICT (email) DO NOTHING`,
      [adminEmail, process.env.ADMIN_NAME || adminEmail.split("@")[0]]
    );
    logger.debug({ email: adminEmail }, "Admin user seeded");
  } catch (err) {
    logger.warn({ err: err.message }, "Could not seed admin user");
  }
}

// ── Exports ─────────────────────────────────────────────────────

export { pool, initialize, seedAdminUser };
