// src/services/prReviewService.js
// Review-every-PR: AI review of pull requests opened on registered repos
// (including human-authored ones), posted back as a PR comment. Triggered
// from the GitHub webhook (pull_request opened/ready_for_review) or
// on-demand from the Slack assistant ("@AutoShip review acme/webapp#123").

import { pool } from "../db.js";
import { logger } from "../logger.js";
import { config } from "../config-manager.js";
import { providerRegistry } from "../providers/provider-registry.js";
import { recordPrAgentReview } from "../prometheus.js";
import { recordTokenUsage, recordCost } from "../prometheus.js";

const PR_REVIEW_MODEL = process.env.PR_REVIEW_MODEL || "anthropic:claude-sonnet-4-6";
const PR_REVIEW_TIMEOUT = 120_000;
const MAX_DIFF_CHARS = 60_000;

const SEVERITY_ORDER = ["critical", "major", "minor", "suggestion"];
const SEVERITY_ICONS = { critical: "🔴", major: "🟠", minor: "🟡", suggestion: "💡" };
const VALID_VERDICTS = ["approve", "comment", "request_changes"];

function githubHeaders(accept = "application/vnd.github+json") {
  const headers = {
    Accept: accept,
    "User-Agent": "autoship-pr-reviewer",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubGet(path, accept) {
  const response = await fetch(`https://api.github.com${path}`, { headers: githubHeaders(accept) });
  if (!response.ok) {
    throw new Error(`GitHub GET ${path} failed: ${response.status} ${response.statusText}`);
  }
  return accept?.includes("diff") ? response.text() : response.json();
}

/** Fetch PR metadata (title, author, head sha, draft state, branches). */
export async function fetchPrMetadata(repoFullName, prNumber) {
  const pr = await githubGet(`/repos/${repoFullName}/pulls/${prNumber}`);
  return {
    prTitle: pr.title,
    prBody: pr.body || "",
    prAuthor: pr.user?.login,
    authorType: pr.user?.type,
    headSha: pr.head?.sha,
    headBranch: pr.head?.ref,
    baseBranch: pr.base?.ref,
    draft: !!pr.draft,
    htmlUrl: pr.html_url,
    changedFiles: pr.changed_files,
    additions: pr.additions,
    deletions: pr.deletions,
  };
}

/** Fetch the unified diff of a PR, truncated to MAX_DIFF_CHARS. */
export async function fetchPrDiff(repoFullName, prNumber) {
  const diff = await githubGet(`/repos/${repoFullName}/pulls/${prNumber}`, "application/vnd.github.v3.diff");
  if (diff.length > MAX_DIFF_CHARS) {
    return diff.slice(0, MAX_DIFF_CHARS) + "\n\n... [diff truncated for review] ...";
  }
  return diff;
}

async function postPrComment(repoFullName, prNumber, body) {
  const response = await fetch(`https://api.github.com/repos/${repoFullName}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: { ...githubHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    throw new Error(`GitHub comment on ${repoFullName}#${prNumber} failed: ${response.status}`);
  }
  const comment = await response.json();
  return comment.html_url;
}

function parseReviewJson(content) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const bare = content.match(/(\{[\s\S]*\})/);
  const raw = fenced ? fenced[1].trim() : bare ? bare[1].trim() : content.trim();
  const parsed = JSON.parse(raw);

  const issues = (Array.isArray(parsed.issues) ? parsed.issues : []).slice(0, 25).map((issue) => ({
    severity: SEVERITY_ORDER.includes(issue.severity) ? issue.severity : "minor",
    file: String(issue.file || "").slice(0, 300),
    line: Number.isFinite(Number(issue.line)) ? Number(issue.line) : null,
    description: String(issue.description || "").slice(0, 1000),
    suggestion: String(issue.suggestion || "").slice(0, 1000),
  }));

  return {
    verdict: VALID_VERDICTS.includes(parsed.verdict) ? parsed.verdict : "comment",
    score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
    summary: String(parsed.summary || "").slice(0, 2000),
    issues,
    testingGaps: (Array.isArray(parsed.testingGaps) ? parsed.testingGaps : []).slice(0, 10).map((g) => String(g).slice(0, 300)),
  };
}

/** Render the structured review as a GitHub comment body. */
export function formatReviewComment(review, { modelUsed } = {}) {
  const verdictLabel = {
    approve: "✅ Looks good",
    comment: "💬 Comments",
    request_changes: "🛑 Changes recommended",
  }[review.verdict];

  const lines = [
    `## 🤖 AutoShip Review — ${verdictLabel} (score: ${review.score}/100)`,
    "",
    review.summary,
  ];

  const bySeverity = SEVERITY_ORDER.filter((sev) => review.issues.some((i) => i.severity === sev));
  for (const sev of bySeverity) {
    lines.push("", `### ${SEVERITY_ICONS[sev]} ${sev.charAt(0).toUpperCase() + sev.slice(1)}`);
    for (const issue of review.issues.filter((i) => i.severity === sev)) {
      const location = issue.file ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\` — ` : "";
      lines.push(`- ${location}${issue.description}${issue.suggestion ? `\n  - _Suggestion:_ ${issue.suggestion}` : ""}`);
    }
  }

  if (review.testingGaps.length > 0) {
    lines.push("", "### 🧪 Testing gaps");
    for (const gap of review.testingGaps) lines.push(`- ${gap}`);
  }

  lines.push("", `---`, `_Automated review${modelUsed ? ` by \`${modelUsed}\`` : ""}. Findings are advisory — use your judgement._`);
  return lines.join("\n");
}

/**
 * Run an AI review of a pull request and (optionally) post it as a PR comment.
 * Never throws — returns { ok: false, error } on failure so webhook/Slack
 * callers can degrade gracefully.
 */
export async function reviewPullRequest({ repoFullName, prNumber, prTitle, prAuthor, headSha, triggerSource = "webhook" }) {
  const startedAt = Date.now();
  let reviewRowId = null;

  try {
    // Fill in metadata when the caller (e.g. Slack) only has repo + number
    let meta = { prTitle, prAuthor, headSha };
    if (!prTitle || !headSha) {
      meta = { ...meta, ...(await fetchPrMetadata(repoFullName, prNumber)) };
    }

    // Dedupe webhook-triggered reviews per head commit (Slack re-reviews on demand)
    if (triggerSource === "webhook" && meta.headSha) {
      const { rows } = await pool.query(
        `SELECT id FROM pr_agent_reviews
         WHERE repo_full_name = $1 AND pr_number = $2 AND head_sha = $3 AND state = 'completed'`,
        [repoFullName, prNumber, meta.headSha]
      );
      if (rows.length > 0) {
        logger.info({ repoFullName, prNumber, headSha: meta.headSha }, "[PR-AGENT-REVIEW] Already reviewed this commit — skipping");
        return { ok: false, skipped: true, reason: "already_reviewed" };
      }
    }

    const inserted = await pool.query(
      `INSERT INTO pr_agent_reviews (repo_full_name, pr_number, pr_title, pr_author, head_sha, trigger_source, state)
       VALUES ($1, $2, $3, $4, $5, $6, 'running') RETURNING id`,
      [repoFullName, prNumber, meta.prTitle || null, meta.prAuthor || null, meta.headSha || null, triggerSource]
    );
    reviewRowId = inserted.rows[0].id;

    const diff = await fetchPrDiff(repoFullName, prNumber);
    if (!diff.trim()) {
      await pool.query(`UPDATE pr_agent_reviews SET state = 'skipped', error = 'empty diff', completed_at = NOW() WHERE id = $1`, [reviewRowId]);
      return { ok: false, skipped: true, reason: "empty_diff" };
    }

    const systemPrompt = `You are a meticulous senior engineer doing an in-depth code review of a pull request.
Review for: correctness bugs, security issues, race conditions, error handling gaps, performance problems, missing tests, and unclear code. Do NOT nitpick style or formatting.
Be specific: reference files and lines from the diff. Only report issues you are confident about.
Return ONLY a JSON object:
{
  "verdict": "approve" | "comment" | "request_changes",
  "score": <0-100, overall quality of the change>,
  "summary": "<2-4 sentence overall assessment>",
  "issues": [{ "severity": "critical|major|minor|suggestion", "file": "<path>", "line": <number or null>, "description": "<what is wrong>", "suggestion": "<how to fix>" }],
  "testingGaps": ["<untested behavior worth covering>"]
}`;

    const userContent = [
      `## Pull Request: ${meta.prTitle || `#${prNumber}`}`,
      `Repo: ${repoFullName} · Author: ${meta.prAuthor || "unknown"} · Base: ${meta.baseBranch || "?"} ← ${meta.headBranch || "?"}`,
      meta.prBody ? `\n## Description\n${String(meta.prBody).slice(0, 3000)}` : "",
      `\n## Diff\n\`\`\`diff\n${diff}\n\`\`\``,
    ].filter(Boolean).join("\n");

    const response = await providerRegistry.chat(PR_REVIEW_MODEL, [{ role: "user", content: userContent }], {
      systemPrompt,
      temperature: 0.2,
      maxTokens: 3000,
      timeout: PR_REVIEW_TIMEOUT,
    });

    const content = typeof response === "string" ? response : response.content || response.text || "";
    const review = parseReviewJson(content);

    let commentUrl = null;
    if (config.get("prReviewPostComment")) {
      try {
        commentUrl = await postPrComment(repoFullName, prNumber, formatReviewComment(review, { modelUsed: PR_REVIEW_MODEL }));
      } catch (err) {
        logger.warn({ repoFullName, prNumber, err: err.message }, "[PR-AGENT-REVIEW] Failed to post PR comment (non-fatal)");
      }
    }

    const durationMs = Date.now() - startedAt;
    await pool.query(
      `UPDATE pr_agent_reviews
       SET state = 'completed', verdict = $2, score = $3, issues = $4, summary = $5,
           comment_url = $6, model_used = $7, duration_ms = $8, completed_at = NOW()
       WHERE id = $1`,
      [reviewRowId, review.verdict, review.score, JSON.stringify(review.issues), review.summary, commentUrl, PR_REVIEW_MODEL, durationMs]
    );

    recordPrAgentReview(true, review.verdict);
    if (response?.usage) {
      const totalTokens = (response.usage.inputTokens || 0) + (response.usage.outputTokens || 0);
      recordTokenUsage(PR_REVIEW_MODEL, "pr_agent_review", totalTokens);
      recordCost(PR_REVIEW_MODEL, totalTokens * 0.000009);
    }

    logger.info(
      { repoFullName, prNumber, verdict: review.verdict, score: review.score, issues: review.issues.length, durationMs },
      `[PR-AGENT-REVIEW] ✅ Reviewed ${repoFullName}#${prNumber} — ${review.verdict} (${review.score}/100)`
    );

    return { ok: true, ...review, commentUrl, prTitle: meta.prTitle, prUrl: meta.htmlUrl };
  } catch (err) {
    logger.error({ repoFullName, prNumber, err: err.message }, "[PR-AGENT-REVIEW] Review failed");
    recordPrAgentReview(false, "error");
    if (reviewRowId) {
      await pool
        .query(`UPDATE pr_agent_reviews SET state = 'failed', error = $2, completed_at = NOW() WHERE id = $1`, [reviewRowId, err.message.slice(0, 1000)])
        .catch(() => {});
    }
    return { ok: false, error: err.message };
  }
}

/**
 * GitHub webhook entry: review newly-opened PRs when reviewEveryPrEnabled.
 * Fire-and-forget from server.js — never throws.
 */
export async function handlePrOpened(payload) {
  try {
    if (!config.get("reviewEveryPrEnabled")) return;

    const pr = payload.pull_request;
    const repo = payload.repository;
    if (!pr || !repo) return;

    const action = payload.action;
    const reviewableAction =
      action === "opened" || action === "ready_for_review" || (action === "synchronize" && config.get("prReviewOnSync"));
    if (!reviewableAction) return;

    if (pr.draft && config.get("prReviewSkipDrafts")) {
      logger.info({ repo: repo.full_name, prNumber: pr.number }, "[PR-AGENT-REVIEW] ⏭️ SKIP: draft PR");
      return;
    }

    if (pr.user?.type === "Bot") {
      logger.info({ repo: repo.full_name, prNumber: pr.number, author: pr.user?.login }, "[PR-AGENT-REVIEW] ⏭️ SKIP: bot-authored PR");
      return;
    }

    logger.info({ repo: repo.full_name, prNumber: pr.number, action }, `[PR-AGENT-REVIEW] 📨 Reviewing PR #${pr.number} on ${repo.full_name}`);

    await reviewPullRequest({
      repoFullName: repo.full_name,
      prNumber: pr.number,
      prTitle: pr.title,
      prAuthor: pr.user?.login,
      headSha: pr.head?.sha,
      triggerSource: "webhook",
    });
  } catch (err) {
    logger.error({ err: err.message }, "[PR-AGENT-REVIEW] Webhook handling failed");
  }
}
