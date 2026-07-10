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

    // Track costs — providers report usage as { inputTokens, outputTokens }
    const inputTokens = usage.inputTokens || 0;
    const outputTokens = usage.outputTokens || 0;
    const model = REVIEW_MODEL.split(":").pop();
    if (taskId && config.get("costTrackingEnabled") && (inputTokens || outputTokens)) {
      try {
        await addTaskCost(taskId, {
          stepName: "self_review",
          modelUsed: model,
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
          estimatedCost: estimateCost(inputTokens, outputTokens),
        });
        recordTokenUsage(model, "self_review", inputTokens + outputTokens);
        recordCost(model, estimateCost(inputTokens, outputTokens));
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
 * Format self-review findings as a markdown section for the PR body.
 * Used when the score is below the draft threshold so reviewers see what
 * the pre-submission review flagged.
 */
export function formatReviewFindings(reviewResult) {
  if (!reviewResult || !Array.isArray(reviewResult.issues) || reviewResult.issues.length === 0) return "";

  const parts = [`## Self-Review Findings (score: ${reviewResult.score}/100)`];
  if (reviewResult.summary) parts.push(reviewResult.summary, "");

  for (const issue of reviewResult.issues) {
    parts.push(`- **[${issue.severity}]** \`${issue.file}\`: ${issue.description}${issue.suggestion ? ` — _${issue.suggestion}_` : ""}`);
  }

  return parts.join("\n");
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

// Approximate Sonnet-class pricing; only used for the estimated_cost column
function estimateCost(inputTokens, outputTokens) {
  const promptCost = (inputTokens || 0) * 0.000003;
  const completionCost = (outputTokens || 0) * 0.000015;
  return promptCost + completionCost;
}
