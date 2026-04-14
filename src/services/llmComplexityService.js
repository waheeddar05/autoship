// src/services/llmComplexityService.js
// LLM-powered complexity assessment — augments the keyword-based scorer
// with actual understanding of task scope and repo context.

import { providerRegistry } from "../providers/provider-registry.js";
import { logger } from "../logger.js";

const COMPLEXITY_MODEL = process.env.COMPLEXITY_MODEL || "anthropic:claude-haiku-4-5-20251001";
const COMPLEXITY_TIMEOUT = 30_000;

/**
 * Assess task complexity using an LLM that understands the actual task and repo.
 *
 * @param {object} params
 * @param {string} params.taskName
 * @param {string} params.taskDescription
 * @param {string} [params.repoContext] - Indexed repo files/endpoints
 * @param {object} [params.keywordScore] - Result from keyword-based scoreComplexity()
 * @returns {{ score: number, level: string, estimatedFiles: number, estimatedTime: string, risks: string[], reasoning: string }}
 */
export async function assessComplexityWithLLM({
  taskName,
  taskDescription,
  repoContext,
  keywordScore,
}) {
  const systemPrompt = `You assess the complexity of software development tasks.

You receive a task description and optionally the repository's file/class index.
Assess the TRUE complexity considering:

1. **Scope**: How many files/modules need changes? Are changes isolated or cross-cutting?
2. **Risk**: Could changes break existing functionality? Are there data migrations?
3. **Ambiguity**: Is the task well-defined or will the developer need to make design decisions?
4. **Dependencies**: Does this touch shared code, APIs consumed by others, or database schemas?
5. **Testing Burden**: How many test cases would a thorough implementation need?

Return ONLY a valid JSON object:
{
  "score": <number 1-100>,
  "level": "simple|medium|complex|critical",
  "estimatedFiles": <number of files likely to be modified>,
  "estimatedTime": "<human readable estimate>",
  "risks": ["<specific risk 1>", "<specific risk 2>"],
  "reasoning": "<1-2 sentence explanation>"
}

Scoring guide:
- 1-20 (simple): Single file change, well-defined, low risk
- 21-45 (medium): 2-5 files, some decisions needed, moderate risk
- 46-70 (complex): 5-15 files, cross-cutting, high risk, design decisions
- 71-100 (critical): Major architecture changes, migrations, high blast radius`;

  const userContent = buildComplexityPrompt(taskName, taskDescription, repoContext, keywordScore);

  try {
    const response = await providerRegistry.chat(COMPLEXITY_MODEL, [
      { role: "user", content: userContent },
    ], {
      systemPrompt,
      temperature: 0.1,
      maxTokens: 1024,
      timeout: COMPLEXITY_TIMEOUT,
    });

    const content = typeof response === "string" ? response : response.content || response.text || "";
    const result = parseComplexityResponse(content);

    logger.info({
      taskName,
      llmScore: result.score,
      llmLevel: result.level,
      keywordScore: keywordScore?.score,
    }, "LLM complexity assessment complete");

    return result;
  } catch (err) {
    logger.warn({ taskName, err: err.message }, "LLM complexity assessment failed, using keyword fallback");
    // Return keyword score as fallback
    if (keywordScore) {
      return {
        score: keywordScore.score,
        level: keywordScore.level,
        estimatedFiles: keywordScore.estimatedFiles,
        estimatedTime: keywordScore.estimatedTime,
        risks: [],
        reasoning: "Fallback to keyword-based scoring (LLM assessment failed).",
      };
    }
    return {
      score: 30,
      level: "medium",
      estimatedFiles: 3,
      estimatedTime: "30 min - 2 hrs",
      risks: [],
      reasoning: "Default score (both LLM and keyword assessment unavailable).",
    };
  }
}

/**
 * Combine keyword-based and LLM-based scores with weighted average.
 */
export function combineComplexityScores(keywordResult, llmResult, weights = { keyword: 0.3, llm: 0.7 }) {
  const combinedScore = Math.round(
    keywordResult.score * weights.keyword + llmResult.score * weights.llm
  );

  let level;
  if (combinedScore <= 20) level = "simple";
  else if (combinedScore <= 45) level = "medium";
  else if (combinedScore <= 70) level = "complex";
  else level = "critical";

  return {
    score: combinedScore,
    level,
    estimatedFiles: llmResult.estimatedFiles || keywordResult.estimatedFiles,
    estimatedTime: llmResult.estimatedTime || keywordResult.estimatedTime,
    risks: llmResult.risks || [],
    reasoning: llmResult.reasoning || "",
    keywordScore: keywordResult.score,
    llmScore: llmResult.score,
    method: "combined",
  };
}

function buildComplexityPrompt(taskName, taskDescription, repoContext, keywordScore) {
  const parts = [];
  parts.push(`## Task: ${taskName}`);
  parts.push(taskDescription || "(No description)");

  if (repoContext) {
    parts.push("\n## Repository Structure");
    parts.push(repoContext.substring(0, 4000));
  }

  if (keywordScore) {
    parts.push(`\n## Keyword-Based Pre-Score: ${keywordScore.score}/100 (${keywordScore.level})`);
    if (keywordScore.factors) {
      const matched = keywordScore.factors.find(f => f.matched);
      if (matched) {
        parts.push(`Matched keywords: ${matched.matched.join(", ")}`);
      }
    }
  }

  return parts.join("\n");
}

function parseComplexityResponse(content) {
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();

  try {
    const parsed = JSON.parse(jsonStr);
    const score = Math.max(1, Math.min(100, Number(parsed.score) || 30));
    return {
      score,
      level: ["simple", "medium", "complex", "critical"].includes(parsed.level) ? parsed.level : inferLevel(score),
      estimatedFiles: Number(parsed.estimatedFiles) || 3,
      estimatedTime: String(parsed.estimatedTime || "Unknown"),
      risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
      reasoning: String(parsed.reasoning || ""),
    };
  } catch {
    return {
      score: 30,
      level: "medium",
      estimatedFiles: 3,
      estimatedTime: "30 min - 2 hrs",
      risks: [],
      reasoning: "Could not parse LLM response.",
    };
  }
}

function inferLevel(score) {
  if (score <= 20) return "simple";
  if (score <= 45) return "medium";
  if (score <= 70) return "complex";
  return "critical";
}
