// src/services/specialistAgentsService.js
// Specialist agents for the debate system: domain-specific AI reviewers
// that contribute security, performance, testing, and architecture perspectives.

import { providerRegistry } from "../providers/provider-registry.js";
import { logger } from "../logger.js";

const SPECIALIST_MODEL = process.env.SPECIALIST_MODEL || "anthropic:claude-sonnet-4-6";
const SPECIALIST_TIMEOUT = 45_000;

// Available specialist roles
const SPECIALISTS = {
  security: {
    name: "Security Reviewer",
    systemPrompt: `You are a security-focused code reviewer. Your ONLY job is to identify security concerns in the proposed implementation plan.

Focus on:
- Authentication and authorization gaps
- Input validation and sanitization
- SQL injection, XSS, CSRF risks
- Secrets management (hardcoded tokens, API keys)
- Data exposure (PII in logs, overly permissive APIs)
- Dependency vulnerabilities
- Insecure defaults

Be specific. Reference concrete files/endpoints from the plan. If no security concerns exist, say so briefly.`,
  },

  performance: {
    name: "Performance Analyst",
    systemPrompt: `You are a performance-focused engineer reviewing an implementation plan. Your ONLY job is to flag performance risks.

Focus on:
- N+1 query patterns
- Missing database indexes for new queries
- Unbounded data fetching (no pagination/limits)
- Memory leaks (event listeners, timers, caches without eviction)
- Blocking operations on hot paths
- Missing caching opportunities
- Large payload sizes

Be specific and actionable. If no performance concerns exist, say so briefly.`,
  },

  testing: {
    name: "Test Coverage Analyst",
    systemPrompt: `You are a QA engineer reviewing an implementation plan for test coverage adequacy.

Focus on:
- Are unit tests planned for business logic?
- Are integration tests planned for API endpoints?
- Are edge cases explicitly tested (empty inputs, nulls, errors)?
- Is error path testing included?
- Are there regression risks that need specific test cases?
- Is the testing approach proportional to the change's risk?

Suggest specific test cases that should be included. If the plan already has adequate testing, confirm it briefly.`,
  },

  architecture: {
    name: "Architecture Reviewer",
    systemPrompt: `You are a software architect reviewing an implementation plan for architectural soundness.

Focus on:
- Does this follow existing patterns in the codebase?
- Are responsibilities properly separated (controller/service/repository)?
- Will this create tight coupling or circular dependencies?
- Is the data model appropriate and extensible?
- Are there better patterns for this type of change?
- Does this create technical debt?

Reference the existing codebase structure when making suggestions. If the architecture is sound, confirm it briefly.`,
  },

  api_design: {
    name: "API Design Reviewer",
    systemPrompt: `You are an API design expert reviewing an implementation plan.

Focus on:
- RESTful conventions (proper HTTP methods, status codes, resource naming)
- Request/response payload design (consistency, backward compatibility)
- Error response format (structured, actionable)
- Versioning considerations
- Rate limiting and pagination
- Documentation needs (OpenAPI/Swagger)

If no API changes are involved, state that briefly and skip.`,
  },
};

/**
 * Run specialist reviews on a coding plan or debate result.
 * Returns an array of specialist perspectives.
 *
 * @param {object} params
 * @param {string} params.taskDescription - Task being implemented
 * @param {string} params.plan - The coding plan or debate result
 * @param {string} [params.repoContext] - Repository context
 * @param {string[]} [params.specialists] - Which specialists to consult (defaults to all)
 * @param {number} [params.taskId] - For logging
 * @returns {Array<{ specialist: string, name: string, concerns: string, hasConcerns: boolean }>}
 */
export async function runSpecialistReviews({
  taskDescription,
  plan,
  repoContext,
  specialists,
  taskId,
}) {
  const activeSpecialists = specialists
    ? specialists.filter(s => SPECIALISTS[s])
    : Object.keys(SPECIALISTS);

  const userContent = buildSpecialistPrompt(taskDescription, plan, repoContext);

  // Run all specialists in parallel
  const reviews = await Promise.allSettled(
    activeSpecialists.map(async (key) => {
      const spec = SPECIALISTS[key];
      try {
        const response = await providerRegistry.chat(SPECIALIST_MODEL, [
          { role: "user", content: userContent },
        ], {
          systemPrompt: spec.systemPrompt,
          temperature: 0.3,
          maxTokens: 1500,
          timeout: SPECIALIST_TIMEOUT,
        });

        const content = typeof response === "string" ? response : response.content || response.text || "";

        const hasConcerns = !/(no\s+(security\s+)?concerns|looks?\s+good|no\s+issues|nothing\s+to\s+flag)/i.test(content);

        return {
          specialist: key,
          name: spec.name,
          concerns: content.trim(),
          hasConcerns,
        };
      } catch (err) {
        logger.warn({ specialist: key, taskId, err: err.message }, "Specialist review failed");
        return {
          specialist: key,
          name: spec.name,
          concerns: `Review skipped: ${err.message}`,
          hasConcerns: false,
        };
      }
    })
  );

  const results = reviews
    .filter(r => r.status === "fulfilled")
    .map(r => r.value);

  logger.info({
    taskId,
    specialistsRun: results.length,
    withConcerns: results.filter(r => r.hasConcerns).length,
  }, "Specialist reviews completed");

  return results;
}

/**
 * Format specialist reviews into a section for the execution prompt.
 */
export function formatSpecialistInsights(reviews) {
  if (!reviews || reviews.length === 0) return "";

  const withConcerns = reviews.filter(r => r.hasConcerns);
  if (withConcerns.length === 0) {
    return "\n## Specialist Reviews\nAll specialist reviewers (security, performance, testing, architecture) found no concerns.\n";
  }

  const parts = ["\n## Specialist Review Findings"];
  parts.push("Address these concerns during implementation:\n");

  for (const review of withConcerns) {
    parts.push(`### ${review.name}`);
    parts.push(review.concerns);
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Determine which specialists are relevant for a given task.
 * Uses simple heuristics to avoid running unnecessary reviews.
 */
export function selectRelevantSpecialists(taskDescription, codingPlan) {
  const text = `${taskDescription} ${codingPlan || ""}`.toLowerCase();
  const relevant = [];

  // Always run architecture
  relevant.push("architecture");

  // Always run testing
  relevant.push("testing");

  // Security: if auth, user data, API, or external integrations mentioned
  if (/auth|secur|token|api|endpoint|user|password|login|permission|role|secret|encrypt/i.test(text)) {
    relevant.push("security");
  }

  // Performance: if database, query, cache, large data, or scaling mentioned
  if (/databas|query|cache|perform|optim|scale|bulk|batch|index|pagina|memory|load/i.test(text)) {
    relevant.push("performance");
  }

  // API design: if endpoint, REST, API, route mentioned
  if (/api|endpoint|route|rest|graphql|request|response|payload|status\s*code/i.test(text)) {
    relevant.push("api_design");
  }

  return [...new Set(relevant)];
}

/**
 * Get list of available specialist types.
 */
export function getAvailableSpecialists() {
  return Object.entries(SPECIALISTS).map(([key, spec]) => ({
    key,
    name: spec.name,
  }));
}

function buildSpecialistPrompt(taskDescription, plan, repoContext) {
  const parts = [];
  parts.push(`## Task Description\n${taskDescription}\n`);
  parts.push(`## Implementation Plan\n${plan}\n`);

  if (repoContext) {
    parts.push(`## Repository Context\n${repoContext.substring(0, 3000)}\n`);
  }

  return parts.join("\n");
}
