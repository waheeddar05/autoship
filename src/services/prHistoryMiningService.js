// src/services/prHistoryMiningService.js
// PR history mining: searches recent PRs for similar changes to use as
// concrete examples in task prompts. Real examples from the same codebase
// are far more effective than generic instructions.

import { pool } from "../db.js";
import { logger } from "../logger.js";
import { providerRegistry } from "../providers/provider-registry.js";

const SIMILARITY_MODEL = process.env.SIMILARITY_MODEL || "anthropic:claude-haiku-4-5-20251001";
const SIMILARITY_TIMEOUT = 20_000;

/**
 * Find PRs similar to the current task from the repo's history.
 * Uses task description matching and AI-based relevance scoring.
 *
 * @param {object} params
 * @param {string} params.repoFullName - e.g. "org/repo"
 * @param {string} params.taskDescription - Current task description
 * @param {string} params.taskName - Current task name
 * @param {number} [params.limit=5] - Max PRs to return
 * @returns {Array<{ taskName: string, prUrl: string, similarity: number, summary: string }>}
 */
export async function findSimilarPRs({ repoFullName, taskDescription, taskName, limit = 5 }) {
  try {
    // Step 1: Get recent completed tasks for this repo
    const { rows: recentTasks } = await pool.query(
      `SELECT t.id, t.name, t.description, t.markdown_description, t.pr_url, t.pr_number,
              t.branch_name, t.completed_at, t.claude_output,
              po.merged, po.revisions, po.changes_requested
       FROM tasks t
       LEFT JOIN pr_outcomes po ON po.task_id = t.id
       WHERE (t.repo_full_name = $1 OR t.repo_name = $2)
         AND t.state = 'success'
         AND t.pr_url IS NOT NULL
       ORDER BY t.completed_at DESC
       LIMIT 30`,
      [repoFullName, repoFullName.split("/").pop()]
    );

    if (recentTasks.length === 0) {
      logger.debug({ repoFullName }, "No PR history found for repo");
      return [];
    }

    // Step 2: Score similarity using keyword overlap + AI
    const candidates = recentTasks.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description || t.markdown_description || "",
      prUrl: t.pr_url,
      prNumber: t.pr_number,
      merged: t.merged,
      keywordScore: computeKeywordSimilarity(taskDescription, taskName, t.name, t.description || ""),
    }));

    // Pre-filter: only keep tasks with some keyword overlap
    const filtered = candidates
      .filter(c => c.keywordScore > 0.05)
      .sort((a, b) => b.keywordScore - a.keywordScore)
      .slice(0, 10);

    if (filtered.length === 0) return [];

    // Step 3: Use AI to rank relevance
    const ranked = await rankByRelevance(taskName, taskDescription, filtered);

    const results = ranked.slice(0, limit);
    logger.info({ repoFullName, found: results.length }, "Similar PRs found");
    return results;
  } catch (err) {
    logger.warn({ repoFullName, err: err.message }, "PR history mining failed");
    return [];
  }
}

/**
 * Format similar PRs into a prompt section for context injection.
 */
export function formatSimilarPRsContext(similarPRs) {
  if (!similarPRs || similarPRs.length === 0) return "";

  const parts = ["\n## Similar Past PRs in This Repo"];
  parts.push("Use these as reference for patterns and conventions:\n");

  for (const pr of similarPRs) {
    parts.push(`### ${pr.taskName}`);
    if (pr.prUrl) parts.push(`PR: ${pr.prUrl}`);
    if (pr.summary) parts.push(pr.summary);
    if (pr.merged) parts.push("✅ This PR was merged successfully.");
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Compute keyword-based similarity between two task descriptions.
 * Returns a score from 0.0 to 1.0.
 */
function computeKeywordSimilarity(desc1, name1, name2, desc2) {
  const tokenize = (text) => {
    return (text || "").toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2)
      .filter(w => !STOP_WORDS.has(w));
  };

  const tokens1 = new Set(tokenize(`${name1} ${desc1}`));
  const tokens2 = new Set(tokenize(`${name2} ${desc2}`));

  if (tokens1.size === 0 || tokens2.size === 0) return 0;

  let overlap = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) overlap++;
  }

  // Jaccard similarity
  const union = new Set([...tokens1, ...tokens2]).size;
  return union > 0 ? overlap / union : 0;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "are", "was",
  "will", "have", "has", "been", "not", "but", "they", "which", "when",
  "can", "should", "would", "could", "into", "also", "each", "then",
  "add", "update", "create", "implement", "fix", "change", "make",
]);

/**
 * Use AI to rank candidate PRs by relevance to the current task.
 */
async function rankByRelevance(taskName, taskDescription, candidates) {
  const candidateList = candidates.map((c, i) =>
    `${i + 1}. "${c.name}" — ${c.description.substring(0, 150)}`
  ).join("\n");

  const systemPrompt = `You rank past PRs by relevance to a new task. Return ONLY a JSON array of indices (1-based) ordered by relevance, most relevant first. Example: [3, 1, 5]`;

  try {
    const response = await providerRegistry.chat(SIMILARITY_MODEL, [
      { role: "user", content: `New task: "${taskName}"\n${taskDescription?.substring(0, 300) || ""}\n\nPast PRs:\n${candidateList}` },
    ], {
      systemPrompt,
      temperature: 0,
      maxTokens: 256,
      timeout: SIMILARITY_TIMEOUT,
    });

    const content = typeof response === "string" ? response : response.content || response.text || "";
    const indices = JSON.parse(content.match(/\[[\d,\s]+\]/)?.[0] || "[]");

    return indices
      .filter(i => i >= 1 && i <= candidates.length)
      .map(i => {
        const c = candidates[i - 1];
        return {
          taskName: c.name,
          prUrl: c.prUrl,
          prNumber: c.prNumber,
          similarity: c.keywordScore,
          merged: c.merged,
          summary: c.description.substring(0, 200),
        };
      });
  } catch {
    // Fallback: return by keyword score
    return candidates.map(c => ({
      taskName: c.name,
      prUrl: c.prUrl,
      prNumber: c.prNumber,
      similarity: c.keywordScore,
      merged: c.merged,
      summary: c.description.substring(0, 200),
    }));
  }
}
