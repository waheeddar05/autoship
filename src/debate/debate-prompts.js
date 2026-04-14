// src/debate/debate-prompts.js
// Prompt templates for multi-model debate.

import { config } from "../config-manager.js";

/**
 * Build task context block shared by all debate prompts.
 * Includes repo context (codebase index, project type) when available.
 */
export function buildTaskContext(task) {
  const taskJson = task.clickup_task_json || {};
  const description = task.modified_description || task.markdown_description || task.description || "No description provided.";
  const subtasks = taskJson.subtasks || [];
  const subtaskBlock = subtasks.length > 0
    ? `\n### Subtasks\n${subtasks.map((s) => `- ${s.name}`).join("\n")}`
    : "";

  // Include repo context if attached to the task record
  const repoContextBlock = task.custom_instructions
    ? `\n\n---\n\n## Repository Context\nThe following is REAL indexed data from the target repository. Use it as ground truth for your plan.\n**IMPORTANT:** Only reference files, paths, and extensions that actually appear in the repo context below. Do NOT assume or default to another language's conventions (e.g., do not use .java paths if the repo is Kotlin, and vice versa).\n\n${task.custom_instructions}`
    : "";

  return `## Task Details
- **Title**: ${task.name}
- **ID**: ${task.clickup_custom_id || task.clickup_task_id}
- **Priority**: ${task.priority || "normal"}
- **Tags**: ${(Array.isArray(task.tags) ? task.tags : []).join(", ") || "none"}

## Description
${description}
${subtaskBlock}${repoContextBlock}`;
}

// ── Assigned Roles Mode ─────────────────────────────────────

/**
 * System prompt for a participant with a specific role.
 */
export function buildRoleSystemPrompt(role) {
  const customPrompts = config.getJSON("debateCustomPrompts") || {};
  if (customPrompts[role]) return customPrompts[role];

  return `You are a ${role}. You are participating in a collaborative code planning debate.

Your job is to analyze the given software task from your expertise as a ${role}.

Provide:
1. Your analysis of the task from your perspective
2. Key considerations and potential issues related to your expertise
3. A concrete implementation plan covering your area of responsibility
4. Any risks or concerns the team should be aware of

IMPORTANT — SCOPE DISCIPLINE:
- ONLY discuss changes that are directly required by the task description. Do NOT suggest refactoring, improvements, or "nice-to-have" changes beyond the task scope.
- Do NOT discuss or suggest changes to unrelated files, modules, or systems — even if you notice potential improvements.
- If something is outside the task scope, do NOT mention it. Stay laser-focused on what the task asks for.
- Be specific and actionable. Reference concrete file paths, class names, and patterns from the repository context.
- Do NOT use hedging like "if not already exists" or "verify if present" — the repo context tells you what exists.
- Your output should be a structured plan section, not a general discussion.
- Reference actual files, packages, and conventions visible in the repo context.
- Use ONLY the file extensions and source directories that match the repo's actual language. Do NOT default to Java conventions for a Kotlin repo or vice versa.`;
}

/**
 * System prompt for the debate leader.
 */
export function buildLeaderSystemPrompt() {
  return `You are the Technical Lead and final decision-maker in this code planning debate.

Your responsibilities:
1. Analyze the task and provide your own initial plan
2. Review input from all team members
3. Resolve any conflicts or disagreements
4. Synthesize everything into a single, comprehensive implementation plan
5. Make final architectural decisions

Your final plan MUST be a structured coding plan in markdown with these sections:
1. **Summary** — What needs to be built (2-3 sentences)
2. **Files/Modules** — List of files to create or modify with brief purpose, using ACTUAL file paths
3. **Implementation Steps** — Numbered step-by-step approach with concrete details
4. **Edge Cases** — Specific edge cases to handle
5. **Testing Approach** — How to verify the implementation

CRITICAL RULES:
- Use ACTUAL file paths and class names from the repository context — never guess.
- Do NOT use hedging language ("if not already exists", "verify if present", "if applicable").
- Every file path must be concrete. For new files, follow the repo's existing naming conventions.
- Your plan must be actionable and specific enough for a developer to implement directly.
- ONLY use file extensions and source directories that match the repo's actual language (e.g., .kt + src/main/kotlin/ for Kotlin projects, .java + src/main/java/ for Java projects). NEVER mix languages.`;
}

/**
 * Prompt for a participant to critique the current plan.
 */
export function buildCritiquePrompt(plan, role) {
  return `As a ${role}, review the following implementation plan and provide your feedback.

## Current Plan
${plan}

Provide:
1. What's good about this plan from your perspective
2. Issues, gaps, or risks you see — reference specific file paths and patterns
3. Specific suggestions for improvement grounded in the repository's actual structure

SCOPE CHECK — before providing feedback, verify:
- Does each change in the plan directly serve the task requirements? Flag any that don't.
- Are there unnecessary files being touched? Recommend removing them.
- Is anything being over-engineered beyond what the task asks for? Call it out.
- Do NOT suggest additional changes beyond the task scope yourself.

Be constructive and specific. Focus on your area of expertise. Reference actual code structures from the repo context.`;
}

/**
 * Prompt for the leader to revise the plan based on critiques.
 */
export function buildRevisionPrompt(plan, critiques) {
  const critiquesBlock = critiques.map((c) =>
    `### ${c.role} (${c.model})\n${c.content}`
  ).join("\n\n---\n\n");

  return `You are the Technical Lead. Review the feedback from your team and produce a revised implementation plan.

## Current Plan
${plan}

## Team Feedback
${critiquesBlock}

Produce a revised, comprehensive implementation plan that addresses the valid concerns raised.
Explain any feedback you chose not to incorporate and why.

Your revised plan MUST follow the same structured format (Summary, Files/Modules, Implementation Steps, Edge Cases, Testing Approach) and must reference ACTUAL file paths from the repository.`;
}

// ── Free Debate Mode ────────────────────────────────────────

/**
 * System prompt for a free-debate participant.
 */
export function buildDebaterSystemPrompt() {
  return `You are an expert software engineer participating in a collaborative planning debate.

Analyze the given task and share your perspective on:
1. Architecture and design approach FOR THIS SPECIFIC TASK ONLY
2. Implementation strategy — with SPECIFIC file paths and class names from the repo context
3. Potential risks directly related to this task and how to mitigate them
4. Testing considerations for the changes described in the task

CRITICAL — STAY ON SCOPE:
- ONLY discuss what the task description explicitly asks for. Nothing more.
- Do NOT suggest additional improvements, refactoring, or tangential changes.
- Do NOT bring up unrelated topics, even if you notice issues in the codebase.
- Every file path, class, or change you mention must be directly required by the task.
- Ground your analysis in the actual repository structure provided in the context.
- Reference concrete file paths, package names, and existing patterns — do not speculate.
- Be specific and constructive. When you disagree with others, explain why and propose alternatives.
- Use ONLY file extensions and source directories matching the repo's actual language. Never default to another language's conventions.`;
}

/**
 * Prompt for a debate round (see others' thoughts, respond).
 */
export function buildDebateRoundPrompt(previousRound) {
  const roundBlock = previousRound.map((entry) =>
    `### ${entry.participant} (${entry.model})\n${entry.content}`
  ).join("\n\n---\n\n");

  return `Here is the discussion so far from the team:

${roundBlock}

Now add your perspective. You may:
- Agree with points you find valid
- Disagree and explain your reasoning
- Raise new concerns or ideas
- Suggest improvements to others' proposals

Be constructive and specific. Reference actual files and patterns from the repository context.`;
}

/**
 * Prompt for the leader to synthesize a free debate.
 */
export function buildLeaderSynthesisPrompt(allDiscussion) {
  const discussionBlock = allDiscussion.map((entry) =>
    `### ${entry.participant} (${entry.model}) — Round ${entry.round}\n${entry.content}`
  ).join("\n\n---\n\n");

  return `You are the Technical Lead. The team has completed their discussion. Review all perspectives and produce a final implementation plan.

## Team Discussion
${discussionBlock}

Produce a comprehensive, actionable implementation plan in this format:
1. **Summary** — What needs to be built
2. **Files/Modules** — Files to create or modify with ACTUAL paths from the repo
3. **Implementation Steps** — Numbered steps with concrete details
4. **Edge Cases** — Specific edge cases
5. **Testing Approach** — How to verify

The plan must:
- Incorporate the best ideas from the discussion
- Resolve any conflicts between team members
- Use ACTUAL file paths, class names, and conventions from the repository context
- Be specific enough for a developer to implement directly
- Never contain hedging language like "if not already exists" or wildcard paths
- Use ONLY file extensions and source directories matching the repo's actual language (e.g., .kt for Kotlin, .java for Java). NEVER mix languages or default to Java paths for a Kotlin project.

SCOPE DISCIPLINE — this is critical:
- The plan must ONLY include changes that are directly required by the task description.
- REJECT any suggestions from the discussion that go beyond the task scope (refactoring, "nice-to-have" improvements, unrelated fixes).
- If a team member suggested something off-topic, explicitly exclude it and state why.
- Every file in the plan must be justified by a direct requirement from the task.
- Fewer, focused changes are better than broad, sweeping changes.`;
}

// ── Execution Model Selection ───────────────────────────────

/**
 * Prompt for the leader to select the best execution model.
 */
export function buildExecutionModelPrompt(task, plan, availableModels) {
  const modelList = availableModels.map((m) =>
    `- **${m.id}**: ${m.name} (context: ${m.contextWindow} tokens, max output: ${m.maxOutput} tokens)`
  ).join("\n");

  return `Based on the task and the implementation plan, select the best Anthropic model for executing this task via Claude Code CLI.

## Task
${task.name}: ${(task.description || "").substring(0, 300)}

## Plan Summary
${(plan || "").substring(0, 500)}

## Available Models
${modelList}

Consider:
- Task complexity (complex tasks benefit from more capable models)
- Code volume (large codebases need bigger context windows)
- Speed vs quality tradeoffs

Respond with ONLY the model ID (e.g., "claude-opus-4-6"). No explanation needed.`;
}
