// src/services/clarificationService.js
// Clarifying-questions loop: instead of hard-rejecting a low-quality ticket,
// ask the author 2-3 targeted questions in a ClickUp comment, capture their
// reply, enrich the task description, and re-run the quality workflow.

import { providerRegistry } from "../providers/provider-registry.js";
import { pool } from "../db.js";
import { logger } from "../logger.js";

const CLARIFY_MODEL = process.env.CLARIFY_MODEL || "anthropic:claude-haiku-4-5-20251001";
const CLARIFY_TIMEOUT = 30_000;

/**
 * Generate 2-3 targeted clarifying questions from the quality-check issues.
 * Returns an array of question strings (empty on failure — caller falls back
 * to the normal reject flow).
 */
export async function generateClarifyingQuestions({ task, qualityResult }) {
  const systemPrompt = `You help make vague software tickets implementable. Given a ticket and the issues a quality review found, write the 2-3 MOST IMPORTANT questions whose answers would let a developer implement the ticket without guessing.

Rules: each question must be specific and answerable in a sentence or two; don't ask about things already in the ticket; prefer questions about acceptance criteria, scope boundaries, and concrete technical detail.

Return ONLY a JSON array of question strings, e.g. ["...?", "...?"]`;

  const userContent = [
    `## Ticket: ${task.name}`,
    task.markdownDescription || task.description || "(no description)",
    `\n## Quality review issues (score ${qualityResult.score}/100)`,
    ...(qualityResult.issues || []).map((i) => `- ${typeof i === "string" ? i : i.description || JSON.stringify(i)}`),
  ].join("\n");

  try {
    const response = await providerRegistry.chat(CLARIFY_MODEL, [
      { role: "user", content: userContent },
    ], { systemPrompt, temperature: 0.3, maxTokens: 1024, timeout: CLARIFY_TIMEOUT });

    const content = typeof response === "string" ? response : response.content || response.text || "";
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/(\[[\s\S]*\])/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[1].trim() : content.trim());
    if (!Array.isArray(parsed)) return [];
    return parsed.map((q) => String(q)).filter(Boolean).slice(0, 3);
  } catch (err) {
    logger.warn({ taskId: task.id, err: err.message }, "Clarifying question generation failed");
    return [];
  }
}

/** Format the ClickUp comment asking the questions. */
export function formatClarificationComment(questions, score) {
  return [
    `❓ **A few questions before AutoShip can pick this up** (quality score: ${score}/100)`,
    "",
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    "",
    "_Reply to this task with your answers and AutoShip will re-evaluate automatically._",
  ].join("\n");
}

/** Persist a pending clarification request. */
export async function createClarificationRequest({ clickupTaskId, dbTaskId, questions, commentId, attempt }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO clarification_requests (clickup_task_id, db_task_id, questions, comment_id, attempt, state)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [clickupTaskId, dbTaskId || null, JSON.stringify(questions), commentId || null, attempt]
    );
    return rows[0];
  } catch (err) {
    logger.warn({ clickupTaskId, err: err.message }, "Failed to create clarification request");
    return null;
  }
}

/** Get the pending clarification request for a task, if any. */
export async function getPendingClarification(clickupTaskId) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM clarification_requests
       WHERE clickup_task_id = $1 AND state = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
      [clickupTaskId]
    );
    return rows[0] || null;
  } catch (err) {
    logger.warn({ clickupTaskId, err: err.message }, "Failed to get pending clarification");
    return null;
  }
}

/** How many clarification rounds this task has already had. */
export async function getClarificationAttempts(clickupTaskId) {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int as count FROM clarification_requests WHERE clickup_task_id = $1`,
      [clickupTaskId]
    );
    return rows[0]?.count || 0;
  } catch {
    return 0;
  }
}

/** Record the author's answer and close the request. */
export async function recordClarificationAnswer(requestId, answerText) {
  try {
    await pool.query(
      `UPDATE clarification_requests SET state = 'answered', answer = $2, answered_at = NOW() WHERE id = $1`,
      [requestId, answerText.slice(0, 8000)]
    );
  } catch (err) {
    logger.warn({ requestId, err: err.message }, "Failed to record clarification answer");
  }
}

/**
 * Build the enriched description: original + Q&A block. The workflow and
 * prompts prefer modified_description, so this flows into re-evaluation.
 */
export function buildEnrichedDescription(originalDescription, questions, answerText) {
  return [
    originalDescription || "",
    "",
    "## Clarifications",
    ...questions.map((q, i) => `**Q${i + 1}: ${q}**`),
    "",
    `**Author's answers:**`,
    answerText,
  ].join("\n");
}
