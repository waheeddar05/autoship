// src/services/codingPlanService.js
// AI-powered coding plan generation for approved tasks.

import { providerRegistry } from "../providers/provider-registry.js";
import { logger } from "../logger.js";

const PLAN_MODEL = process.env.CODING_PLAN_MODEL || "anthropic:claude-sonnet-4-6";
const PLAN_TIMEOUT = 90_000; // 90 seconds

const AGENT_NAME = process.env.AGENT_NAME || "AutoShip";

/**
 * Generate a structured coding plan for a ClickUp task.
 *
 * @param {object} task - Normalized ClickUp task object
 * @param {object} [options]
 * @param {string} [options.repoContext] - Repository context (project type, structure, conventions, indexed files)
 * @param {string} [options.repoName] - Repository name for reference
 * @returns {string} Markdown-formatted coding plan
 */
export async function generateCodingPlan(task, { repoContext, repoName, projectType, revisionFeedback, previousPlan } = {}) {
  const hasRepoContext = !!repoContext && repoContext.trim().length > 0;
  const isMultiRepo = repoName && repoName.includes(",");

  const multiRepoRules = isMultiRepo
    ? `
MULTI-REPOSITORY RULES:
- This task spans MULTIPLE repositories: ${repoName}
- Organize the "Files/Modules" and "Implementation Steps" sections BY REPOSITORY, using a sub-heading for each repo (e.g., "### Changes in \`org/repo-name\`").
- Clearly indicate which changes belong to which repository. Never mix file paths from different repos.
- If one repo depends on changes in another (e.g., API contract, shared types), call out the dependency and ordering explicitly.`
    : "";

  // Build language-specific rules so the AI never defaults to the wrong language
  let languageRules = "";
  if (projectType === "kotlin-spring") {
    languageRules = `
LANGUAGE RULES (MANDATORY):
- This is a KOTLIN project. ALL source files MUST use the .kt extension — NEVER .java.
- Source root is src/main/kotlin/ — NEVER use src/main/java/.
- Test root is src/test/kotlin/ — NEVER use src/test/java/.
- Use Kotlin idioms: data classes, val over var, extension functions, nullable types.
- Do NOT generate any .java file paths or Java-style code patterns.`;
  } else if (projectType === "spring-boot") {
    languageRules = `
LANGUAGE RULES:
- This is a Java Spring Boot project. Source files use the .java extension.
- Source root is src/main/java/. Test root is src/test/java/.`;
  }

  const systemPrompt = `You are a senior software architect creating a detailed coding plan for a development task.
${projectType ? `\nThe target repository is a **${projectType}** project.` : ""}

Generate a structured coding plan in markdown with these sections:
1. **Summary** — What needs to be built (2-3 sentences)
2. **Files/Modules** — List of files to create or modify with brief purpose. Use ACTUAL file paths from the repository context provided.
3. **Implementation Steps** — Numbered step-by-step approach with concrete details
4. **Edge Cases** — Specific edge cases to handle
5. **Testing Approach** — How to verify the implementation

CRITICAL RULES:
- Reference ACTUAL file paths, class names, and package structures from the repository context.
- Do NOT use hedging language like "if not already exists", "verify if exists", "check whether", or "if applicable".
- Do NOT use wildcard paths like "src/**/", "**/*.java", or vague directory references.
- Every file path must be a concrete path that either exists in the repo or is a new file you are explicitly creating.
- If an entity, model, or class already exists in the repo context, state its EXACT location and current fields/methods.
- For database migrations, reference the ACTUAL latest migration version number from the repo context and increment from there.
- For new files, state the exact directory and filename following the repo's existing naming conventions.
${hasRepoContext ? "- The repository context below contains REAL indexed data from the target repo. Use it as ground truth." : "- No repository context was provided. Note this limitation clearly in your plan and be explicit about what the developer must verify."}
${languageRules}${multiRepoRules}
Keep the plan actionable and specific. Do NOT include any JSON or code blocks unless showing specific code patterns to follow.
Format the entire response as clean markdown.`;

  const taskContent = [
    `# Task: ${task.name}`,
    "",
    task.markdownDescription || task.description || "(No description)",
  ];

  if (task.subtasks && task.subtasks.length > 0) {
    taskContent.push("", "## Subtasks");
    for (const st of task.subtasks) {
      taskContent.push(`- ${st.name || st}`);
    }
  }

  // Append repo context if available
  if (hasRepoContext) {
    const repoHeader = isMultiRepo ? "## Target Repositories" : "## Target Repository";
    taskContent.push("", "---", "", repoHeader + (repoName ? `: ${repoName}` : ""));
    taskContent.push("", repoContext);
  } else if (repoName) {
    taskContent.push("", "---", "");
    taskContent.push(`> **Note:** Target repo is \`${repoName}\` but repository context could not be fetched. Plan may require developer verification of actual file paths and conventions.`);
  }

  const messages = [];

  // If this is a plan revision, include the previous plan and feedback
  if (revisionFeedback && previousPlan) {
    messages.push({
      role: "user",
      content: `Create a coding plan for this task:\n\n${taskContent.join("\n")}`,
    });
    messages.push({
      role: "assistant",
      content: previousPlan,
    });
    messages.push({
      role: "user",
      content: [
        `The reviewer has requested changes to this plan. Here is their feedback:`,
        "",
        `> ${revisionFeedback}`,
        "",
        `Please revise the coding plan to incorporate this feedback. Generate the COMPLETE revised plan (not just the changes).`,
        `Maintain the same structure (Summary, Files/Modules, Implementation Steps, Edge Cases, Testing Approach).`,
      ].join("\n"),
    });
  } else {
    messages.push({
      role: "user",
      content: `Create a coding plan for this task:\n\n${taskContent.join("\n")}`,
    });
  }

  try {
    const response = await providerRegistry.chat(PLAN_MODEL, messages, {
      systemPrompt,
      temperature: 0.4,
      maxTokens: 4096,
      timeout: PLAN_TIMEOUT,
    });

    const plan = typeof response === "string" ? response : response.content || response.text || "";

    if (!plan.trim()) {
      throw new Error("AI returned empty coding plan");
    }

    // Add preamble
    const preambleParts = [
      `> *This plan was auto-generated by ${AGENT_NAME}. Please review before approving.*`,
    ];
    if (repoName) {
      preambleParts.push(`> **Target repo:** \`${repoName}\``);
    }
    if (!hasRepoContext) {
      preambleParts.push(`> ⚠️ *Plan generated without repo context — verify file paths and conventions before approving.*`);
    }

    const fullPlan = [
      ...preambleParts,
      "",
      plan.trim(),
    ].join("\n");

    logger.info({
      taskId: task.id,
      planLength: fullPlan.length,
      repoName: repoName || "none",
      hasRepoContext,
    }, "Coding plan generated");
    return fullPlan;
  } catch (err) {
    logger.error({ taskId: task.id, err: err.message }, "Coding plan generation failed");
    throw err;
  }
}
