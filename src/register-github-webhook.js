#!/usr/bin/env node
/**
 * Register GitHub webhooks on repos managed by AutoShip.
 *
 * Usage:
 *   node src/register-github-webhook.js                    # auto-detect repos from DB
 *   node src/register-github-webhook.js --repo org/repo    # specific repo
 *   node src/register-github-webhook.js --list             # list existing webhooks
 *
 * Requires: GITHUB_TOKEN env var or gh CLI authenticated.
 */

import "dotenv/config";

const BASE_URL = process.env.BASE_URL || "https://your-autoship-domain.example.com";
const WEBHOOK_URL = `${BASE_URL}/webhook/github`;
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const GITHUB_ORG = process.env.GITHUB_ORG || "your-github-org";

const REQUIRED_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
];

async function ghApi(endpoint, method = "GET", body = null) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  } else {
    // Fall back to gh CLI
    const { execSync } = await import("child_process");
    const args = method === "GET"
      ? `gh api ${endpoint}`
      : `gh api ${endpoint} -X ${method} --input -`;
    try {
      const result = execSync(args, {
        input: body ? JSON.stringify(body) : undefined,
        encoding: "utf-8",
        timeout: 15_000,
      });
      return JSON.parse(result);
    } catch (err) {
      console.error(`  gh CLI error: ${err.stderr || err.message}`);
      return null;
    }
  }

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`https://api.github.com${endpoint}`, opts);
  if (!res.ok) {
    const text = await res.text();
    console.error(`  API error ${res.status}: ${text}`);
    return null;
  }
  return res.json();
}

async function getReposFromDb() {
  try {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const { rows } = await pool.query(
      `SELECT DISTINCT repo_full_name FROM tasks WHERE repo_full_name IS NOT NULL`
    );
    await pool.end();
    return rows.map((r) => r.repo_full_name);
  } catch {
    return [];
  }
}

async function listWebhooks(repo) {
  const hooks = await ghApi(`/repos/${repo}/hooks`);
  if (!hooks || hooks.length === 0) {
    console.log(`  ${repo}: no webhooks`);
    return [];
  }
  for (const h of hooks) {
    const isAutoship = h.config?.url?.includes("/webhook/github");
    console.log(`  ${repo}: [${h.id}] ${h.config?.url} events=${h.events?.join(",")} active=${h.active} ${isAutoship ? "← AUTOSHIP" : ""}`);
  }
  return hooks;
}

async function registerWebhook(repo) {
  // Check existing
  const hooks = await ghApi(`/repos/${repo}/hooks`);
  if (hooks) {
    const existing = hooks.find((h) => h.config?.url === WEBHOOK_URL);
    if (existing) {
      // Check if events match
      const missingEvents = REQUIRED_EVENTS.filter((e) => !existing.events.includes(e));
      if (missingEvents.length === 0 && existing.active) {
        console.log(`  ✓ ${repo}: webhook already configured`);
        return;
      }
      // Update
      console.log(`  ↻ ${repo}: updating webhook (adding events: ${missingEvents.join(", ")})`);
      await ghApi(`/repos/${repo}/hooks/${existing.id}`, "PATCH", {
        events: [...new Set([...existing.events, ...REQUIRED_EVENTS])],
        active: true,
      });
      console.log(`  ✓ ${repo}: webhook updated`);
      return;
    }
  }

  // Create new
  console.log(`  + ${repo}: creating webhook...`);
  const config = {
    url: WEBHOOK_URL,
    content_type: "json",
  };
  if (WEBHOOK_SECRET) config.secret = WEBHOOK_SECRET;

  const result = await ghApi(`/repos/${repo}/hooks`, "POST", {
    name: "web",
    config,
    events: REQUIRED_EVENTS,
    active: true,
  });

  if (result) {
    console.log(`  ✓ ${repo}: webhook created (id: ${result.id})`);
  } else {
    console.error(`  ✗ ${repo}: failed to create webhook`);
  }
}

// ── Main ──
const args = process.argv.slice(2);

if (args.includes("--list")) {
  const repos = await getReposFromDb();
  if (repos.length === 0) {
    console.log("No repos found in DB. Use --repo org/name");
  }
  for (const repo of repos) await listWebhooks(repo);
  process.exit(0);
}

const repoArg = args.indexOf("--repo");
let repos;
if (repoArg >= 0 && args[repoArg + 1]) {
  repos = [args[repoArg + 1]];
} else {
  repos = await getReposFromDb();
}

if (repos.length === 0) {
  console.log("No repos to register. Use: node src/register-github-webhook.js --repo org/name");
  process.exit(1);
}

console.log(`Webhook URL: ${WEBHOOK_URL}`);
console.log(`Events: ${REQUIRED_EVENTS.join(", ")}`);
console.log(`Repos: ${repos.length}\n`);

for (const repo of repos) {
  await registerWebhook(repo);
}

console.log("\nDone.");
