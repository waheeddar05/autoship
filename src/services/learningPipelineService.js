// src/services/learningPipelineService.js
// Closed-loop learning pipeline: parses PR feedback, categorizes it,
// and builds per-repo lesson profiles to inject into future task prompts.

import { pool } from "../db.js";
import { providerRegistry } from "../providers/provider-registry.js";
import { logger } from "../logger.js";

const CATEGORIZE_MODEL = process.env.LEARNING_MODEL || "anthropic:claude-haiku-4-5-20251001";
const CATEGORIZE_TIMEOUT = 30_000;

// Feedback categories that the system tracks
const FEEDBACK_CATEGORIES = [
  "missing_tests",
  "error_handling",
  "security",
  "code_style",
  "naming_conventions",
  "performance",
  "type_safety",
  "api_design",
  "documentation",
  "logic_bug",
  "architecture",
  "dependency_management",
  "edge_cases",
  "code_duplication",
];

/**
 * Process PR review comments, categorize them via AI, and store lessons.
 * Called when a PR receives review feedback.
 *
 * @param {object} params
 * @param {number} params.taskId - DB task ID
 * @param {string} params.repoFullName - e.g. "org/repo"
 * @param {number} params.prNumber
 * @param {Array<{path: string, body: string, user: string}>} params.reviewComments
 * @returns {Array<object>} categorized lessons
 */
export async function processReviewFeedback({ taskId, repoFullName, prNumber, reviewComments }) {
  if (!reviewComments || reviewComments.length === 0) return [];

  try {
    const categorized = await categorizeComments(reviewComments);

    // Store each lesson
    for (const lesson of categorized) {
      await storeLesson({
        repoFullName,
        taskId,
        prNumber,
        category: lesson.category,
        lesson: lesson.lesson,
        filePath: lesson.filePath,
        severity: lesson.severity,
        originalComment: lesson.originalComment,
      });
    }

    logger.info({
      taskId,
      repoFullName,
      prNumber,
      lessonCount: categorized.length,
    }, "PR feedback processed and lessons stored");

    return categorized;
  } catch (err) {
    logger.error({ taskId, repoFullName, err: err.message }, "Failed to process review feedback");
    return [];
  }
}

/**
 * Use AI to categorize review comments into structured lessons.
 */
async function categorizeComments(reviewComments) {
  const commentText = reviewComments.map((c, i) => {
    const loc = c.path ? `File: ${c.path}` : "General";
    return `${i + 1}. [${loc}] ${c.body}`;
  }).join("\n");

  const systemPrompt = `You categorize PR review comments into structured lessons for an AI coding assistant.

Available categories: ${FEEDBACK_CATEGORIES.join(", ")}

For each review comment, extract:
1. The category (from the list above)
2. A concise, actionable lesson (what to do differently next time)
3. Severity: "critical", "major", "minor"

Return ONLY a JSON array:
[
  {
    "commentIndex": <1-based index>,
    "category": "<category>",
    "lesson": "<actionable lesson for future tasks>",
    "severity": "critical|major|minor",
    "filePath": "<file path if mentioned, or null>"
  }
]

Focus on extracting generalizable lessons, not task-specific fixes.
For example: "Always add input validation for API endpoints" rather than "Add validation to POST /users".`;

  try {
    const response = await providerRegistry.chat(CATEGORIZE_MODEL, [
      { role: "user", content: `Categorize these PR review comments:\n\n${commentText}` },
    ], {
      systemPrompt,
      temperature: 0.1,
      maxTokens: 2048,
      timeout: CATEGORIZE_TIMEOUT,
    });

    const content = typeof response === "string" ? response : response.content || response.text || "";
    return parseCategorizedComments(content, reviewComments);
  } catch (err) {
    logger.warn({ err: err.message }, "AI categorization failed, using rule-based fallback");
    return ruleBasedCategorization(reviewComments);
  }
}

/**
 * Rule-based fallback for categorization when AI is unavailable.
 */
function ruleBasedCategorization(comments) {
  const patterns = {
    missing_tests: /test|spec|coverage|assert/i,
    error_handling: /error\s*handl|try\s*catch|exception|throw/i,
    security: /secur|auth|inject|xss|csrf|saniti|token|secret/i,
    code_style: /style|format|lint|indent|spacing|convention/i,
    naming_conventions: /nam(e|ing)|variable|rename|method name/i,
    performance: /perform|optim|slow|memory|cache|n\+1|query/i,
    type_safety: /type|typescript|typing|generic|cast|null check/i,
    documentation: /doc|comment|readme|javadoc|jsdoc/i,
    logic_bug: /bug|incorrect|wrong|broken|fix|issue/i,
    edge_cases: /edge case|boundary|overflow|empty|null|undefined/i,
  };

  return comments.map((c) => {
    let category = "code_style"; // default
    for (const [cat, pattern] of Object.entries(patterns)) {
      if (pattern.test(c.body)) {
        category = cat;
        break;
      }
    }
    return {
      category,
      lesson: c.body.substring(0, 200),
      filePath: c.path || null,
      severity: "minor",
      originalComment: c.body,
    };
  });
}

/**
 * Store a lesson in the database.
 */
async function storeLesson({ repoFullName, taskId, prNumber, category, lesson, filePath, severity, originalComment }) {
  try {
    await pool.query(
      `INSERT INTO repo_lessons (repo_full_name, task_id, pr_number, category, lesson, file_path, severity, original_comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [repoFullName, taskId, prNumber, category, lesson, filePath, severity, originalComment]
    );
  } catch (err) {
    logger.warn({ repoFullName, category, err: err.message }, "Failed to store lesson");
  }
}

/**
 * Get accumulated lessons for a repo to inject into task prompts.
 * Returns the most relevant and frequent lessons.
 *
 * @param {string} repoFullName
 * @param {number} [limit=20] - Max lessons to return
 * @returns {string} Formatted lessons text for prompt injection
 */
export async function getRepoLessons(repoFullName, limit = 20) {
  try {
    // Get lessons grouped by category with counts
    const { rows: categoryCounts } = await pool.query(
      `SELECT category, COUNT(*) as count,
              array_agg(DISTINCT lesson ORDER BY lesson) as lessons
       FROM repo_lessons
       WHERE repo_full_name = $1
       GROUP BY category
       ORDER BY count DESC
       LIMIT $2`,
      [repoFullName, limit]
    );

    if (categoryCounts.length === 0) return "";

    const parts = ["## Lessons from Past PR Reviews"];
    parts.push("The following patterns have been flagged by reviewers. Avoid these issues:\n");

    for (const row of categoryCounts) {
      const categoryLabel = row.category.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      const topLessons = (row.lessons || []).slice(0, 3);
      parts.push(`### ${categoryLabel} (flagged ${row.count}x)`);
      for (const lesson of topLessons) {
        parts.push(`- ${lesson}`);
      }
      parts.push("");
    }

    return parts.join("\n");
  } catch (err) {
    logger.warn({ repoFullName, err: err.message }, "Failed to get repo lessons");
    return "";
  }
}

/**
 * Get a statistical summary of lessons for a repo.
 */
export async function getLessonStats(repoFullName) {
  try {
    const { rows } = await pool.query(
      `SELECT
        COUNT(*) as total_lessons,
        COUNT(DISTINCT pr_number) as prs_analyzed,
        COUNT(DISTINCT category) as categories_seen,
        mode() WITHIN GROUP (ORDER BY category) as most_common_category,
        COUNT(*) FILTER (WHERE severity = 'critical') as critical_count,
        COUNT(*) FILTER (WHERE severity = 'major') as major_count,
        COUNT(*) FILTER (WHERE severity = 'minor') as minor_count
       FROM repo_lessons
       WHERE repo_full_name = $1`,
      [repoFullName]
    );
    return rows[0] || {};
  } catch (err) {
    logger.warn({ repoFullName, err: err.message }, "Failed to get lesson stats");
    return {};
  }
}

/**
 * Decay old lessons — reduce the weight of lessons older than N days.
 * Lessons that haven't been re-flagged recently are less relevant.
 */
export async function decayOldLessons(daysThreshold = 90) {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM repo_lessons WHERE created_at < NOW() - INTERVAL '${daysThreshold} days'`
    );
    if (rowCount > 0) {
      logger.info({ deleted: rowCount, daysThreshold }, "Decayed old repo lessons");
    }
    return rowCount;
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to decay old lessons");
    return 0;
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function parseCategorizedComments(content, originalComments) {
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/(\[[\s\S]*\])/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return ruleBasedCategorization(originalComments);

    return parsed.map((item) => ({
      category: FEEDBACK_CATEGORIES.includes(item.category) ? item.category : "code_style",
      lesson: String(item.lesson || ""),
      filePath: item.filePath || null,
      severity: ["critical", "major", "minor"].includes(item.severity) ? item.severity : "minor",
      originalComment: originalComments[item.commentIndex - 1]?.body || "",
    }));
  } catch {
    return ruleBasedCategorization(originalComments);
  }
}
