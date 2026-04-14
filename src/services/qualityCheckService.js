// src/services/qualityCheckService.js
// AI-powered quality evaluation of ClickUp task descriptions.

import { providerRegistry } from "../providers/provider-registry.js";
import { logger } from "../logger.js";

const QUALITY_CHECK_MODEL = process.env.QUALITY_CHECK_MODEL || "anthropic:claude-sonnet-4-6";
const QUALITY_CHECK_TIMEOUT = 60_000; // 60 seconds

/**
 * Evaluate a ClickUp task for quality and completeness.
 *
 * @param {object} task - Normalized ClickUp task object
 * @param {object} task.name - Task title
 * @param {object} task.description - Task description
 * @param {object} task.markdownDescription - Markdown description
 * @param {object} task.subtasks - Array of subtasks
 * @param {object} task.tags - Array of tag names
 * @returns {{ score: number, issues: string[], summary: string }}
 */
export async function evaluateTaskQuality(task) {
  const taskContent = buildTaskSummary(task);

  const systemPrompt = `You are a senior engineering manager reviewing task descriptions for completeness and quality before they enter development.

Evaluate the task on these criteria (each worth up to the indicated points):
1. **Clear title** (10 pts): Is the title descriptive and actionable?
2. **Problem statement** (15 pts): Does the description clearly explain what needs to be done and why?
3. **Acceptance criteria** (20 pts): Are there explicit, testable acceptance criteria?
4. **Technical details** (15 pts): Are relevant technical details, APIs, or data models mentioned?
5. **Edge cases** (15 pts): Are edge cases, error handling, or boundary conditions addressed?
6. **Scope definition** (10 pts): Is the scope well-defined (what's in/out)?
7. **Testing approach** (10 pts): Is there mention of how to test or validate?
8. **Dependencies** (5 pts): Are dependencies or blockers noted?

Return ONLY a valid JSON object with this exact structure:
{
  "score": <number 0-100>,
  "issues": ["issue1", "issue2", ...],
  "summary": "Brief overall assessment"
}

Be fair but thorough. A minimal task with just a title and one-line description should score around 20-30. A well-written task with all criteria should score 85-100.`;

  const messages = [
    {
      role: "user",
      content: `Evaluate this task:\n\n${taskContent}`,
    },
  ];

  try {
    const response = await providerRegistry.chat(QUALITY_CHECK_MODEL, messages, {
      systemPrompt,
      temperature: 0.3,
      maxTokens: 1024,
      timeout: QUALITY_CHECK_TIMEOUT,
    });

    const content = typeof response === "string" ? response : response.content || response.text || "";
    const result = parseJsonResponse(content);

    logger.info(
      { taskId: task.id, score: result.score, issueCount: result.issues.length },
      "Quality check completed"
    );

    return result;
  } catch (err) {
    logger.error({ taskId: task.id, err: err.message }, "Quality check AI call failed");
    throw err;
  }
}

function buildTaskSummary(task) {
  const parts = [`# Task: ${task.name}`];

  if (task.markdownDescription || task.description) {
    parts.push(`\n## Description\n${task.markdownDescription || task.description}`);
  } else {
    parts.push("\n## Description\n(No description provided)");
  }

  if (task.subtasks && task.subtasks.length > 0) {
    parts.push("\n## Subtasks");
    for (const st of task.subtasks) {
      parts.push(`- ${st.name || st}`);
    }
  }

  if (task.tags && task.tags.length > 0) {
    parts.push(`\n## Tags: ${task.tags.join(", ")}`);
  }

  return parts.join("\n");
}

function parseJsonResponse(content) {
  // Extract JSON from potential markdown code blocks
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
      summary: String(parsed.summary || ""),
    };
  } catch {
    logger.warn({ raw: content.substring(0, 500) }, "Failed to parse quality check JSON, returning default");
    return {
      score: 50,
      issues: ["Could not parse AI quality evaluation response"],
      summary: "Quality check produced unparseable output",
    };
  }
}
