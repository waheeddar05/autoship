// src/sources/github-issues-source.js
// GitHub Issues as a task source: label an issue "autoship" in a configured
// repo and AutoShip picks it up like a ClickUp task — plan, implement, PR.
//
// Task ids are "gh-<owner>-<repo>-<issueNumber>". The authoritative
// owner/repo/number mapping is stored in the task row's clickup_task_json
// under _github (ids alone are ambiguous when names contain dashes).

import { pool } from "../db.js";
import { logger } from "../logger.js";
import { config } from "../config-manager.js";

const GITHUB_API = "https://api.github.com";

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function ghFetch(path, options = {}) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: { ...ghHeaders(), ...(options.headers || {}) },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API ${options.method || "GET"} ${path} → ${response.status}: ${body.slice(0, 300)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

// ── Task id ↔ issue resolution ───────────────────────────────────

export function issueTaskId(owner, repo, number) {
  return `gh-${owner}-${repo}-${number}`;
}

/**
 * Resolve a gh- task id to { owner, repo, number } via the stored task row.
 */
async function resolveIssueRef(taskId) {
  const { rows } = await pool.query(
    `SELECT clickup_task_json FROM tasks WHERE clickup_task_id = $1 ORDER BY id DESC LIMIT 1`,
    [taskId]
  );
  const meta = rows[0]?.clickup_task_json?._github;
  if (!meta?.owner || !meta?.repo || !meta?.number) {
    throw new Error(`No GitHub issue mapping stored for task ${taskId}`);
  }
  return meta;
}

// ── Normalization ────────────────────────────────────────────────

/**
 * Normalize a GitHub issue into the internal task shape (the same shape
 * clickup-client's getTaskDetails returns). The synthesized "repo" custom
 * field points the pipeline at the issue's own repository.
 */
export function normalizeIssue(issue, owner, repo) {
  const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
  return {
    id: issueTaskId(owner, repo, issue.number),
    customId: `#${issue.number}`,
    name: issue.title,
    description: issue.body || "",
    markdownDescription: issue.body || "",
    status: issue.state === "open" ? "open" : "closed",
    priority: null,
    tags: labels,
    assignees: (issue.assignees || []).map((a) => ({ id: String(a.id), username: a.login })),
    subtasks: [],
    list: null,
    folder: null,
    space: null,
    url: issue.html_url,
    customFields: [
      { name: "repo", type: "text", value: `${owner}/${repo}` },
    ],
    // Source metadata — persisted in clickup_task_json for id resolution
    _github: { owner, repo, number: issue.number, creator: issue.user?.login || null },
    _source: "github_issues",
  };
}

// ── Source interface (used via task-source-router) ───────────────

export async function getTaskDetails(taskId) {
  const { owner, repo, number } = await resolveIssueRef(taskId);
  const issue = await ghFetch(`/repos/${owner}/${repo}/issues/${number}`);
  return normalizeIssue(issue, owner, repo);
}

export async function getRawTaskDetails(taskId) {
  const { owner, repo, number } = await resolveIssueRef(taskId);
  const issue = await ghFetch(`/repos/${owner}/${repo}/issues/${number}`);
  // Shape compatibility: workflowOrchestrator reads raw.creator.id
  return { ...issue, creator: issue.user ? { id: issue.user.id, username: issue.user.login } : null };
}

export async function postTaskComment(taskId, commentText) {
  const { owner, repo, number } = await resolveIssueRef(taskId);
  const comment = await ghFetch(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: commentText }),
  });
  return { id: String(comment.id) };
}

export async function getTaskComments(taskId) {
  const { owner, repo, number } = await resolveIssueRef(taskId);
  const comments = await ghFetch(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`);
  // Match the ClickUp comment shape used by approval polling
  return (comments || []).map((c) => ({
    id: String(c.id),
    comment_text: c.body || "",
    date: new Date(c.created_at).getTime(),
    user: { username: c.user?.login },
  }));
}

/**
 * Status changes map to autoship:* labels on the issue (GitHub issues have
 * no status field): remove previous autoship:* labels, add the new one.
 */
export async function updateTaskStatus(taskId, status) {
  const { owner, repo, number } = await resolveIssueRef(taskId);
  const slug = `autoship:${String(status).toLowerCase().replace(/\s+/g, "-")}`;

  const issue = await ghFetch(`/repos/${owner}/${repo}/issues/${number}`);
  const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
  const kept = labels.filter((l) => !l.startsWith("autoship:"));

  await ghFetch(`/repos/${owner}/${repo}/issues/${number}`, {
    method: "PATCH",
    body: JSON.stringify({ labels: [...kept, slug] }),
  });
}

export async function addTagToTask(taskId, tag) {
  const { owner, repo, number } = await resolveIssueRef(taskId);
  await ghFetch(`/repos/${owner}/${repo}/issues/${number}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels: [String(tag).toLowerCase()] }),
  });
}

export async function removeTagFromTask(taskId, tag) {
  const { owner, repo, number } = await resolveIssueRef(taskId);
  try {
    await ghFetch(`/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(String(tag).toLowerCase())}`, {
      method: "DELETE",
    });
  } catch (err) {
    if (!err.message.includes("404")) throw err;
  }
}

export async function updateTaskAssignees(taskId, _assigneeIds) {
  // ClickUp assignee ids don't map to GitHub logins — reassignment flows
  // (reject/clarify) are a no-op for issue-sourced tasks; the issue author
  // is already watching the thread.
  logger.debug({ taskId }, "updateTaskAssignees is a no-op for GitHub issue tasks");
}

// ── Poller ───────────────────────────────────────────────────────

let pollerTimer = null;

/**
 * Poll configured repos for open issues carrying the trigger label and
 * hand new ones to the pipeline.
 */
export async function pollGitHubIssues() {
  const repos = config.getList("githubIssuesRepos");
  const label = config.get("githubIssuesLabel") || "autoship";
  if (repos.length === 0) return;

  // Lazy import to avoid a static cycle (orchestrator → engine → router → here)
  const { handleTask } = await import("../claude-orchestrator.js");

  for (const repoFullName of repos) {
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) {
      logger.warn({ repoFullName }, "[GH-ISSUES] Invalid repo in githubIssuesRepos — expected owner/repo");
      continue;
    }

    try {
      const issues = await ghFetch(
        `/repos/${owner}/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=50`
      );

      for (const issue of issues || []) {
        if (issue.pull_request) continue; // the issues API also returns PRs

        const taskId = issueTaskId(owner, repo, issue.number);

        // Skip issues that already have a task (any state). Re-trigger by
        // deleting the task from the dashboard and re-labeling the issue.
        const { rows } = await pool.query(
          `SELECT 1 FROM tasks WHERE clickup_task_id = $1 LIMIT 1`,
          [taskId]
        );
        if (rows.length > 0) continue;

        logger.info({ taskId, issue: `${repoFullName}#${issue.number}`, title: issue.title },
          `[GH-ISSUES] 🚀 New labeled issue — triggering pipeline`);

        const normalized = normalizeIssue(issue, owner, repo);
        handleTask(normalized, { source: "github_issues" }).catch((err) => {
          logger.error({ taskId, err: err.message }, "[GH-ISSUES] Task handling failed");
        });
      }
    } catch (err) {
      logger.warn({ repo: repoFullName, err: err.message }, "[GH-ISSUES] Poll failed for repo");
    }
  }
}

export function startGitHubIssuesPoller() {
  if (pollerTimer) return pollerTimer;
  const intervalMs = Number(config.get("githubIssuesPollIntervalMs")) || 120_000;

  logger.info({ intervalMs, repos: config.getList("githubIssuesRepos") }, "[GH-ISSUES] Starting GitHub Issues poller");
  pollGitHubIssues().catch(() => {});
  pollerTimer = setInterval(() => {
    if (!config.get("githubIssuesEnabled")) return;
    pollGitHubIssues().catch(() => {});
  }, intervalMs);
  if (pollerTimer.unref) pollerTimer.unref();
  return pollerTimer;
}
