// src/replay-harness.js
// Golden-task replay harness: re-run past successfully-merged tasks in
// dry-run mode (no commit, no push, no PR, no notifications) against the
// CURRENT model/prompt/config, and compare the files Claude changes with
// the files the merged PR actually touched. Run it before and after a
// config change to see whether the change helps or hurts.
//
//   npm run replay                     # replay the 5 most recent golden tasks
//   npm run replay -- --limit 10
//   npm run replay -- --repo acme/webapp
//   npm run replay -- --task 42 --task 57   # specific DB task ids
//
// Results are printed and persisted to the replay_results table.

import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import { pool, initialize as initDb } from "./db.js";
import { config } from "./config-manager.js";
import { logger } from "./logger.js";
import { buildPrompt, injectDebatePlan } from "./format-helpers.js";

const REPOS_BASE_DIR = process.env.REPOS_BASE_DIR || "./repos";
const REPLAY_DIR = path.join(REPOS_BASE_DIR, ".replay");

function parseArgs(argv) {
  const args = { limit: 5, repo: null, taskIds: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") args.limit = parseInt(argv[++i], 10) || 5;
    else if (argv[i] === "--repo") args.repo = argv[++i];
    else if (argv[i] === "--task") args.taskIds.push(parseInt(argv[++i], 10));
  }
  return args;
}

function run(cmd, cmdArgs, cwd, { timeout = 120_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, cmdArgs, {
      cwd,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", CI: "true" },
      timeout,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    if (input) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${cmd} ${cmdArgs[0]} exited ${code}: ${stderr.slice(0, 400)}`));
    });
    proc.on("error", reject);
  });
}

/** Golden tasks: successful, PR merged, with a stored repo. */
async function selectGoldenTasks({ limit, repo, taskIds }) {
  if (taskIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT t.*, po.pr_url as merged_pr_url FROM tasks t
       LEFT JOIN pr_outcomes po ON po.task_id = t.id AND po.merged = TRUE
       WHERE t.id = ANY($1)`,
      [taskIds]
    );
    return rows;
  }
  const params = [limit];
  let repoFilter = "";
  if (repo) {
    params.push(repo);
    repoFilter = "AND t.repo_full_name = $2";
  }
  const { rows } = await pool.query(
    `SELECT t.*, po.pr_url as merged_pr_url FROM tasks t
     JOIN pr_outcomes po ON po.task_id = t.id AND po.merged = TRUE
     WHERE t.state = 'success' AND t.repo_full_name IS NOT NULL
       AND t.repo_full_name NOT LIKE '%,%' ${repoFilter}
     ORDER BY t.completed_at DESC NULLS LAST
     LIMIT $1`,
    params
  );
  return rows;
}

/** Files the merged PR actually changed (via gh api). */
async function fetchExpectedFiles(repoFullName, prNumber) {
  const output = await run(
    "gh", ["api", `repos/${repoFullName}/pulls/${prNumber}/files`, "--paginate", "--jq", ".[].filename"],
    process.cwd(), { timeout: 30_000 }
  );
  return output.split("\n").filter(Boolean);
}

async function prepareReplayClone(repoFullName, baseBranch) {
  const dir = path.join(REPLAY_DIR, repoFullName.replace("/", "__"));
  const token = process.env.GITHUB_TOKEN;
  const cloneUrl = token
    ? `https://x-access-token:${token}@github.com/${repoFullName}.git`
    : `https://github.com/${repoFullName}.git`;

  try {
    await run("git", ["rev-parse", "--is-inside-work-tree"], dir, { timeout: 10_000 });
    await run("git", ["fetch", "origin", baseBranch], dir, { timeout: 120_000 });
  } catch {
    await run("mkdir", ["-p", REPLAY_DIR], process.cwd());
    await run("git", ["clone", "--depth", "50", cloneUrl, dir], process.cwd(), { timeout: 300_000 });
  }
  await run("git", ["checkout", "-B", "autoship-replay", `origin/${baseBranch}`], dir);
  await run("git", ["reset", "--hard", `origin/${baseBranch}`], dir);
  await run("git", ["clean", "-fd"], dir);
  return dir;
}

/** Run Claude Code headless in the replay clone. Nothing is committed. */
async function runClaudeDryRun(prompt, cwd) {
  const claudePath = process.env.CLAUDE_CODE_PATH || "claude";
  const model = config.get("executionModel") || "claude-opus-4-6";
  const timeout = config.get("claudeTimeout") || 30 * 60 * 1000;
  const args = ["--print", "--output-format", "json", "--model", model];
  if (config.get("skipPermissions")) args.push("--dangerously-skip-permissions");

  const started = Date.now();
  const output = await run(claudePath, args, cwd, { timeout, input: prompt });
  let usage = null;
  try {
    const parsed = JSON.parse(output);
    usage = { totalCostUsd: parsed.total_cost_usd || 0, numTurns: parsed.num_turns || 0 };
  } catch (_) {}
  return { durationMs: Date.now() - started, usage, model };
}

function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

async function replayTask(task) {
  const repoFullName = task.repo_full_name;
  const baseBranch = config.get("baseBranch") || "dev";
  console.log(`\n▶ Replaying #${task.id} "${task.name}" (${repoFullName})`);

  const expectedFiles = task.pr_number
    ? await fetchExpectedFiles(repoFullName, task.pr_number).catch((err) => {
        console.warn(`  ⚠ Could not fetch merged PR files: ${err.message}`);
        return [];
      })
    : [];

  const dir = await prepareReplayClone(repoFullName, baseBranch);

  // Same prompt construction as a fresh run, plus the approved plan if one
  // was stored — so replays exercise the plan-injection path too.
  let prompt = buildPrompt(task);
  const { rows: approvals } = await pool.query(
    `SELECT coding_plan FROM workflow_approvals
     WHERE clickup_task_id = $1 AND coding_plan IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [task.clickup_task_id]
  );
  if (approvals[0]?.coding_plan) {
    prompt = injectDebatePlan(prompt, approvals[0].coding_plan, config.get("debatePlanInPrompt") || "full", {
      framingMode: config.get("planFramingMode") || "mandatory",
    });
  }

  const { durationMs, usage, model } = await runClaudeDryRun(prompt, dir);

  const changedOutput = await run("git", ["diff", "--name-only", "HEAD"], dir).catch(() => "");
  const untrackedOutput = await run("git", ["ls-files", "--others", "--exclude-standard"], dir).catch(() => "");
  const changedFiles = [...changedOutput.split("\n"), ...untrackedOutput.split("\n")]
    .filter(Boolean)
    .filter((f) => !f.startsWith(".autoship/"));
  const diffstat = await run("git", ["diff", "--stat", "HEAD"], dir).catch(() => "");

  // Clean the working tree — nothing from the replay survives
  await run("git", ["reset", "--hard", "HEAD"], dir).catch(() => {});
  await run("git", ["clean", "-fd"], dir).catch(() => {});

  const overlap = expectedFiles.length > 0 ? jaccard(changedFiles, expectedFiles) : null;
  const overlapPct = overlap === null ? null : Math.round(overlap * 100);

  await pool.query(
    `INSERT INTO replay_results (task_id, repo_full_name, model, changed_files, expected_files, overlap_pct, diffstat, duration_ms, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [task.id, repoFullName, model, JSON.stringify(changedFiles), JSON.stringify(expectedFiles), overlapPct,
     diffstat.slice(0, 2000), durationMs, usage?.totalCostUsd || null]
  );

  console.log(`  model: ${model} · ${(durationMs / 1000).toFixed(0)}s · $${(usage?.totalCostUsd || 0).toFixed(2)}`);
  console.log(`  changed ${changedFiles.length} file(s); merged PR touched ${expectedFiles.length}`);
  if (overlapPct !== null) console.log(`  file-set overlap vs merged PR: ${overlapPct}%`);

  return { taskId: task.id, name: task.name, model, overlapPct, changedFiles: changedFiles.length, expectedFiles: expectedFiles.length, durationMs };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await initDb();
  await config.initFromDb(pool);
  logger.level = "warn"; // keep replay output readable

  const golden = await selectGoldenTasks(args);
  if (golden.length === 0) {
    console.log("No golden tasks found (need successful tasks with merged PRs).");
    process.exit(0);
  }

  console.log(`Replaying ${golden.length} golden task(s) with executionModel=${config.get("executionModel")}`);
  const results = [];
  for (const task of golden) {
    try {
      results.push(await replayTask(task));
    } catch (err) {
      console.error(`  ✖ Replay failed for #${task.id}: ${err.message}`);
    }
  }

  if (results.length > 0) {
    const scored = results.filter((r) => r.overlapPct !== null);
    const avg = scored.length > 0 ? Math.round(scored.reduce((n, r) => n + r.overlapPct, 0) / scored.length) : "n/a";
    console.log(`\n═ Summary ═ ${results.length} replay(s), average file-set overlap: ${avg}%`);
    console.log("Compare runs across config changes via the replay_results table.");
  }
  await pool.end();
}

main().catch((err) => {
  console.error("Replay harness failed:", err.message);
  process.exit(1);
});
