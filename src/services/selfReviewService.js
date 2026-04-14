// src/services/selfReviewService.js
// Pre-submission self-review: AI reviews generated code before PR creation.
// Catches issues before a human reviewer ever sees the PR.

import { providerRegistry } from "../providers/provider-registry.js";
import { logger } from "../logger.js";
import { config } from "../config-manager.js";
import { addTaskCost } from "../task-queue.js";
import { recordTokenUsage, recordCost } from "../prometheus.js";

const REVIEW_MODEL = process.env.SELF_REVIEW_MODEL || "anthropic:claude-sonnet-4-6";
const REVIEW_TIMEOUT = 90_000;

/**
 * Run a self-review on generated code before submission.
 * Returns review result with pass/fail, issues found, and suggested fixes.
 *
 * @param {object} params
 * @param {string} params.diff - The git diff of changes
 * @param {string} params.taskDescription - Original task description
 * @param {string} params.codingPlan - The coding plan that was followed
 * @param {string} [params.repoContext] - Repository context (project type, conventions)
 * @param {number} [params.taskId] - DB task ID for cost tracking
 * @returns {{ passed: boolean, score: number, issues: Array<{severity: string, file: string, description: string, suggestion: string}>, summary: string, usage: object }}
 */
export async function reviewGeneratedCode({
  diff,
  taskDescription,
  codingPlan,
  repoContext,
  taskId,
}) {
  if (!diff || diff.trim().length === 0) {
    return {
      passed: false,
      score: 0,
      issues: [{ severity: "critical", file: "N/A", description: "No code changes were generated", suggestion: "Re-run the task" }],
      summary: "No diff to review — Claude produced no code changes.",
      usage: {},
    };
  }

  const systemPrompt = `You are a senior code reviewer performing a pre-submission review of AI-generated code.
Your job is to catch issues BEFORE the code reaches a human reviewer.

Review the diff against the original task requirements and coding plan.

Check for these categories:
1. **Correctness** — Does the code actually implement what was asked? Are there logic bugs?
2. **Completeness** — Are all requirements from the task description addressed? Missing features?
3. **Error Handling** — Are errors properly caught and handled? Edge cases covered?
4. **Security** — Any injection risks, exposed secrets, missing auth checks, unsafe operations?
5. **Testing** — Are tests included? Do they cover the main paths and edge cases?
6. **Code Quality** — Naming conventions, dead code, unnecessary complexity, code duplication?
7. **API Contracts** — Do new endpoints match expected request/response shapes?
8. **Dependencies** — Any missing imports, undefined references, or circular dependencies?

Return ONLY a valid JSON object:
{
  "passed": <boolean - true if code is ready for human review, false if critical issues>,
  "score": <number 0-100>,
  "issues": [
    {
      "severity": "critical|major|minor|suggestion",
      "file": "<file path from diff>",
      "description": "<what's wrong>",
      "suggestion": "<how to fix it>"
    }
  ],
  "summary": "<2-3 sentence overall assessment>"
}

Score guidelines:
- 90-100: Excellent, ready to submit
- 70-89: Good, minor issues only
- 50-69: Needs work, has major issues
- 0-49: Critical problems, should not submit

Mark passed=false if ANY critical issue exists or score < 60.`;

  const userContent = buildReviewPrompt(diff, taskDescription, codingPlan, repoContext);

  try {
    const response = await providerRegistry.chat(REVIEW_MODEL, [
      { role: "user", content: userContent },
    ], {
      systemPrompt,
      temperature: 0.2,
      maxTokens: 4096,
      timeout: REVIEW_TIMEOUT,
    });

    const content = typeof response === "string" ? response : response.content || response.text || "";
    const usage = response.usage || {};

    // Track costs
    if (taskId && usage.prompt_tokens) {
      try {
        await addTaskCost(taskId, "self_review", REVIEW_MODEL.split(":").pop(), usage.prompt_tokens, usage.completion_tokens || 0);
        recordTokenUsage("self_review", usage.prompt_tokens, usage.completion_tokens || 0);
        recordCost("self_review", estimateCost(usage));
      } catch (_) {}
    }

    const result = parseReviewResponse(content);

    logger.info({
      taskId,
      passed: result.passed,
      score: result.score,
      issueCount: result.issues.length,
      criticalCount: result.issues.filter(i => i.severity === "critical").length,
    }, "Self-review completed");

    return { ...result, usage };
  } catch (err) {
    logger.error({ taskId, err: err.message }, "Self-review AI call failed");
    // On failure, pass through (don't block the pipeline)
    return {
      passed: true,
      score: -1,
      issues: [],
      summary: `Self-review skipped due to error: ${err.message}`,
      usage: {},
    };
  }
}

/**
 * Run iterative self-review: review → fix → re-review cycle.
 * Attempts up to maxIterations to get the code to pass review.
 */
export async function iterativeSelfReview({
  diff,
  taskDescription,
  codingPlan,
  repoContext,
  taskId,
  maxIterations = 2,
}) {
  const reviews = [];
  let currentDiff = diff;
  let lastResult = null;

  for (let i = 0; i < maxIterations; i++) {
    const result = await reviewGeneratedCode({
      diff: currentDiff,
      taskDescription,
      codingPlan,
      repoContext,
      taskId,
    });

    reviews.push({ iteration: i + 1, ...result });
    lastResult = result;

    if (result.passed || result.score >= 80) {
      logger.info({ taskId, iteration: i + 1 }, "Self-review passed");
      break;
    }

    if (i < maxIterations - 1) {
      logger.info({ taskId, iteration: i + 1, score: result.score }, "Self-review found issues, generating fix instructions");
      // The fix instructions can be fed back to Claude Code for another pass
      // The caller (execution-engine) handles the actual re-execution
    }
  }

  return {
    finalResult: lastResult,
    iterations: reviews,
    totalIterations: reviews.length,
  };
}

/**
 * Generate fix instructions from self-review issues for Claude Code to apply.
 */
export function generateFixInstructions(reviewResult) {
  if (!reviewResult.issues || reviewResult.issues.length === 0) return null;

  const criticalAndMajor = reviewResult.issues.filter(
    i => i.severity === "critical" || i.severity === "major"
  );

  if (criticalAndMajor.length === 0) return null;

  const instructions = criticalAndMajor.map((issue, idx) => {
    return `${idx + 1}. [${issue.severity.toUpperCase()}] ${issue.file}: ${issue.description}\n   Fix: ${issue.suggestion}`;
  }).join("\n\n");

  return `The following issues were found during self-review. Please fix them:\n\n${instructions}`;
}

// ── Internal helpers ────────────────────────────────────────────

function buildReviewPrompt(diff, taskDescription, codingPlan, repoContext) {
  const parts = [];

  parts.push("## Original Task Description");
  parts.push(taskDescription || "(No description)");

  if (codingPlan) {
    parts.push("\n## Coding Plan");
    parts.push(codingPlan);
  }

  if (repoContext) {
    parts.push("\n## Repository Context");
    parts.push(repoContext);
  }

  parts.push("\n## Generated Code Diff");
  parts.push("```diff");
  // Truncate extremely large diffs to stay within context
  const maxDiffLength = 30000;
  if (diff.length > maxDiffLength) {
    parts.push(diff.substring(0, maxDiffLength));
    parts.push(`\n... (truncated, ${diff.length - maxDiffLength} chars omitted)`);
  } else {
    parts.push(diff);
  }
  parts.push("```");

  return parts.join("\n");
}

function parseReviewResponse(content) {
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      passed: !!parsed.passed,
      score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(i => ({
        severity: String(i.severity || "minor"),
        file: String(i.file || "unknown"),
        description: String(i.description || ""),
        suggestion: String(i.suggestion || ""),
      })) : [],
      summary: String(parsed.summary || ""),
    };
  } catch {
    logger.warn({ raw: content.substring(0, 500) }, "Failed to parse self-review JSON");
    return {
      passed: true,
      score: -1,
      issues: [],
      summary: "Self-review produced unparseable output — passing through.",
    };
  }
}

function estimateCost(usage) {
  const promptCost = (usage.prompt_tokens || 0) * 0.000003;
  const completionCost = (usage.completion_tokens || 0) * 0.000015;
  return promptCost + completionCost;
}
