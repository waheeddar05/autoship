// src/services/prAutoFixService.js
// AI-powered fix generation from PR review comments.

import { providerRegistry } from "../providers/provider-registry.js";
import { logger } from "../logger.js";
import { config } from "../config-manager.js";
import { addTaskCost } from "../task-queue.js";
import { recordTokenUsage, recordCost } from "../prometheus.js";

const FIX_MODEL = process.env.PR_FIX_MODEL || "anthropic:claude-sonnet-4-6";
const FIX_TIMEOUT = 120_000; // 2 minutes

/**
 * Generate code fixes based on PR review comments using AI.
 *
 * @param {object} params
 * @param {string} params.prTitle - PR title
 * @param {string} params.branch - Branch name
 * @param {string} params.reviewComments - Array of { path, line, body, user }
 * @param {string} params.currentDiff - Current diff of the PR
 * @param {string} [params.taskContext] - Original task description for context
 * @param {number} [params.taskId] - DB task ID for cost tracking
 * @returns {{ fixInstructions: string, summary: string, usage: object }}
 */
export async function generateFixFromReview({
  prTitle,
  branch,
  reviewComments,
  currentDiff,
  taskContext,
  taskId,
}) {
  const commentsSummary = reviewComments
    .map((c, i) => {
      const location = c.path ? `File: ${c.path}${c.line ? `:${c.line}` : ""}` : "General";
      return `${i + 1}. [${location}] (by @${c.user}): ${c.body}`;
    })
    .join("\n");

  const systemPrompt = `You are a senior developer fixing code based on PR review feedback.
You receive review comments on a pull request and must generate precise fix instructions.

RULES:
- Address EVERY review comment. Do not skip any.
- Be specific about file paths, line numbers, and exact code changes.
- If a comment asks for a stylistic change, apply it consistently across the affected files.
- If a comment points out a bug, fix the root cause, not just the symptom.
- Output a clear, actionable list of changes to make.
- Do NOT explain why the changes are needed — just describe the fix.`;

  const userContent = [
    `# PR: ${prTitle}`,
    `# Branch: ${branch}`,
    "",
    "## Review Comments to Address",
    commentsSummary,
    "",
    "## Current Diff",
    "```",
    (currentDiff || "").substring(0, 8000),
    "```",
  ];

  if (taskContext) {
    userContent.push("", "## Original Task Context", taskContext.substring(0, 2000));
  }

  userContent.push(
    "",
    "## Instructions",
    "Generate a detailed prompt that will be given to an AI code editor to fix all the review comments above.",
    "The prompt should reference specific files, functions, and line numbers. Be precise and actionable."
  );

  const messages = [{ role: "user", content: userContent.join("\n") }];

  try {
    const response = await providerRegistry.chat(FIX_MODEL, messages, {
      systemPrompt,
      temperature: 0.3,
      maxTokens: 4096,
      timeout: FIX_TIMEOUT,
    });

    const fixInstructions =
      typeof response === "string" ? response : response.content || response.text || "";
    const usage = response.usage || {};

    // Track costs
    if (taskId && config.get("costTrackingEnabled")) {
      try {
        await addTaskCost(taskId, {
          stepName: "pr_auto_fix",
          modelUsed: FIX_MODEL,
          promptTokens: usage.inputTokens || 0,
          completionTokens: usage.outputTokens || 0,
          totalTokens: (usage.inputTokens || 0) + (usage.outputTokens || 0),
          estimatedCost: 0,
        });
        recordTokenUsage(FIX_MODEL, "pr_auto_fix", (usage.inputTokens || 0) + (usage.outputTokens || 0));
      } catch (_) {}
    }

    // Generate a short summary for the PR comment
    const summary = fixInstructions
      .split("\n")
      .filter((l) => l.trim().startsWith("-") || l.trim().startsWith("*") || /^\d+\./.test(l.trim()))
      .slice(0, 10)
      .join("\n") || "Applied fixes based on review comments.";

    logger.info(
      { prTitle, commentCount: reviewComments.length, fixLength: fixInstructions.length },
      "Generated fix instructions from review comments"
    );

    return { fixInstructions, summary, usage };
  } catch (err) {
    logger.error({ prTitle, err: err.message }, "Failed to generate fix from review");
    throw err;
  }
}
