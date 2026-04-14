// src/format-helpers.js
// Template-based naming for branches, PRs, and commits.
// Supports placeholders: {taskId}, {customId}, {name}, {slug}, {repo}

import { config } from "./config-manager.js";

/**
 * Generate a slug from a task name (lowercase, hyphenated, max 50 chars)
 */
export function slugify(text, maxLength = 50) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, maxLength);
}

/**
 * Apply a template string, replacing placeholders with values.
 * Placeholders: {taskId}, {customId}, {name}, {slug}, {repo}
 */
function applyTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value || "");
  }
  return result;
}

/**
 * Generate a short unique run identifier (6 chars, alphanumeric).
 * Used to make branch names unique across retries of the same task.
 */
export function generateRunId() {
  return Math.random().toString(36).substring(2, 8);
}

/**
 * Build template variables from a task record.
 * @param {object} task - The task record
 * @param {string} [runId] - Optional unique run identifier for branch uniqueness
 */
function buildVars(task, runId) {
  return {
    taskId: task.clickup_task_id || task.id,
    customId: task.clickup_custom_id || task.clickup_task_id || task.id,
    name: task.name || "untitled",
    slug: slugify(task.name || "untitled"),
    repo: task.repo_name || "",
    runId: runId || generateRunId(),
  };
}

/**
 * Generate a branch name from a task record using the configured format.
 * Default: feature/{taskId}-{slug}-{runId}
 * The {runId} ensures each execution gets a unique branch, even for the same task.
 * @param {object} task - The task record
 * @param {string} [runId] - Optional run identifier (auto-generated if not provided)
 */
export function formatBranchName(task, runId) {
  const template = config.get("branchNameFormat");
  return applyTemplate(template, buildVars(task, runId));
}

/**
 * Generate a PR title from a task record using the configured format.
 * Default: #{customId}: {name}
 */
export function formatPrTitle(task) {
  const template = config.get("prTitleFormat");
  return applyTemplate(template, buildVars(task));
}

/**
 * Generate a commit message from a task record using the configured format.
 * Default: #{customId}: {name}
 */
export function formatCommitMessage(task) {
  const template = config.get("commitMessageFormat");
  return applyTemplate(template, buildVars(task));
}

/**
 * Build the PR body with ClickUp link and Claude summary.
 */
export function buildPrBody(task, claudeOutput, branchName) {
  const summary = extractSummary(claudeOutput);
  const baseBranch = config.get("baseBranch");
  const taskUrl = task.clickup_task_json?.url || `https://app.clickup.com/t/${task.clickup_task_id}`;
  const taskName = task.name;
  const customId = task.clickup_custom_id || task.clickup_task_id;
  const description = task.modified_description || task.markdown_description || task.description || "See ClickUp task for details.";

  return `## ClickUp Task
[${taskName}](${taskUrl}) (\`${customId}\`)

## Description
${description.substring(0, 800)}

## Implementation Summary
${summary}

## Details
- **Branch**: \`${branchName}\`
- **Base**: \`${baseBranch}\``;
}

/**
 * Build the prompt for Claude Code from a task record.
 */
export function buildPrompt(task) {
  const taskJson = task.clickup_task_json || {};
  const subtasks = taskJson.subtasks || [];
  const subtaskBlock =
    subtasks.length > 0
      ? `\n## Subtasks\n${subtasks.map((s) => `- [ ] ${s.name}`).join("\n")}`
      : "";

  const customInstructions = task.custom_instructions
    ? `\n## Additional Instructions\n${task.custom_instructions}`
    : "";

  const description = task.modified_description || task.markdown_description || task.description || "No description provided.";
  const taskUrl = taskJson.url || `https://app.clickup.com/t/${task.clickup_task_id}`;

  return `You are a senior staff-level software engineer. Implement the following ClickUp task in this codebase.

## Task
- **Title**: ${task.name}
- **ID**: ${task.clickup_custom_id || task.clickup_task_id}
- **Priority**: ${task.priority || "normal"}
- **Tags**: ${(Array.isArray(task.tags) ? task.tags : []).join(", ") || "none"}
- **ClickUp URL**: ${taskUrl}

## Description
${description}
${subtaskBlock}
${customInstructions}

## Rules
1. Read the existing codebase first — understand patterns, structure, naming, and architecture.
2. Implement the FULL flow end-to-end (DB → backend → API → frontend if applicable). No partial changes.
3. Follow existing coding standards and conventions strictly.
4. Write unit tests for any new code.
5. Ensure the code compiles/builds without errors.
6. Do NOT modify unrelated files. If a file is not directly required by the task, do not touch it.
7. If the task description is ambiguous, make reasonable assumptions and document them.
8. Keep changes focused — solve EXACTLY what the task asks for. No refactoring, no "nice-to-have" improvements, no drive-by fixes.
9. Do NOT add, remove, or modify code that is not directly required by the task — even if you notice opportunities for improvement.
10. Before finishing, run \`git diff\` to verify your changes are meaningful and on-scope. Remove any accidental changes to unrelated files.

After implementing, provide a brief summary of what changed and why.`;
}

/**
 * Build prompt for incremental update (adds context from previous execution).
 */
export function buildIncrementalPrompt(task, newInstructions) {
  const basePrompt = buildPrompt(task);
  const previousOutput = task.claude_output
    ? `\n## Previous Implementation Summary\n${extractSummary(task.claude_output)}`
    : "";

  return `${basePrompt}
${previousOutput}

## Update Request
The following changes/additions are requested on top of the existing implementation:

${newInstructions}

Make ONLY the changes requested above. Do not redo previous work unless it needs modification.`;
}

/**
 * Build prompt for PR review fix.
 */
export function buildPrReviewPrompt({ prTitle, prUrl, branch, baseBranch, reviewComments, allComments, reviewSummary }) {
  const commentBlock = reviewComments
    .map((c) => {
      const location = c.path ? `**File**: \`${c.path}\`${c.line ? ` (line ${c.line})` : ""}` : "**General comment**";
      return `${location}\n**Reviewer** (${c.user}): ${c.body}`;
    })
    .join("\n\n---\n\n");

  return `You are a senior staff-level software engineer. Address the following PR review comments on this codebase.

## PR Info
- **Title**: ${prTitle}
- **PR**: ${prUrl}
- **Branch**: ${branch} → ${baseBranch}

## Review Comments to Address
${commentBlock}

${reviewSummary ? `## Review Summary\n${reviewSummary}` : ""}

${allComments && allComments.length > reviewComments.length ? `## All PR Comments (for additional context)\n${allComments.join("\n---\n")}` : ""}

## Rules
1. Read the review comments carefully and understand what changes are requested.
2. Make ONLY the changes requested in the review — do not refactor or change unrelated code.
3. Follow existing coding standards and conventions.
4. Ensure the code compiles/builds without errors after changes.
5. If a comment is unclear, make a reasonable interpretation and note your assumption.

After fixing, provide a brief summary of what you changed for each comment.`;
}

/**
 * Inject a debate plan into the base prompt, before the ## Rules section.
 * Supports "full" (entire plan) or "summary" (condensed) injection modes.
 */
export function injectDebatePlan(basePrompt, debatePlan, mode = "full", { framingMode = "mandatory" } = {}) {
  if (!debatePlan) return basePrompt;

  const planContent = mode === "summary"
    ? debatePlan.substring(0, 800) + (debatePlan.length > 800 ? "\n\n[Plan truncated for brevity]" : "")
    : debatePlan;

  // Choose framing based on configured strictness level
  let planBlock;
  if (framingMode === "guide") {
    planBlock = `\n## Implementation Plan (Reference Guide — Approved by Reviewer)
This plan was reviewed and approved by a human reviewer. Use it as a **reference guide** — not a rigid step-by-step script.

**Guidelines:**
1. Read the plan to understand the overall approach and which files to change.
2. Make changes efficiently — batch edits to the same file together instead of many small incremental edits.
3. You MUST actually edit/create/delete files — do NOT just analyze or describe what you would do.
4. Verify your changes with \`git diff\` once at the end, not after every individual edit.
5. You may deviate from the exact order or approach if you find a better way, as long as the end result matches the plan's intent.

${planContent}\n`;
  } else {
    // "mandatory" (default) — strict step-by-step adherence
    planBlock = `\n## Implementation Plan (MANDATORY — Approved by Reviewer)
**CRITICAL: This plan was reviewed and approved by a human reviewer. You MUST follow this plan exactly.**

**Requirements:**
1. Follow each implementation step in the order specified below.
2. If the plan references file paths, run the discovery commands first to confirm actual paths before making changes.
3. You MUST actually edit/create/delete files as described — do NOT just analyze or describe what you would do.
4. After making changes, verify them with \`git diff\` to confirm files were modified.
5. If you cannot find a file mentioned in the plan, search for it using grep/find and adapt the path accordingly — do NOT skip the step.

${planContent}\n`;
  }

  // Insert before ## Rules
  const rulesIndex = basePrompt.indexOf("## Rules");
  if (rulesIndex !== -1) {
    return basePrompt.substring(0, rulesIndex) + planBlock + "\n" + basePrompt.substring(rulesIndex);
  }

  // Fallback: append to end
  return basePrompt + planBlock;
}

/**
 * Extract summary from Claude Code output (last meaningful lines).
 */
function extractSummary(output) {
  if (!output) return "See PR diff for changes.";
  const lines = output.trim().split("\n").filter(Boolean);
  return lines.slice(-20).join("\n").substring(0, 1200) || "See PR diff for changes.";
}
