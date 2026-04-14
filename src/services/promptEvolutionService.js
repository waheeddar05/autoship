// src/services/promptEvolutionService.js
// Prompt evolution: tracks prompt variants, measures merge rates,
// and selects the best-performing prompt for each repo/task-type.

import { pool } from "../db.js";
import { logger } from "../logger.js";

/**
 * Register a prompt variant used for a task.
 *
 * @param {object} params
 * @param {number} params.taskId
 * @param {string} params.promptType - "system", "coding_plan", "execution"
 * @param {string} params.variantId - Unique identifier for this prompt version
 * @param {string} params.variantHash - Hash of the prompt content (for dedup)
 * @param {string} [params.repoFullName]
 */
export async function registerPromptVariant({ taskId, promptType, variantId, variantHash, repoFullName }) {
  try {
    await pool.query(
      `INSERT INTO prompt_variants (task_id, prompt_type, variant_id, variant_hash, repo_full_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (task_id, prompt_type) DO UPDATE SET variant_id = $3, variant_hash = $4`,
      [taskId, promptType, variantId, variantHash, repoFullName]
    );
  } catch (err) {
    logger.warn({ taskId, promptType, err: err.message }, "Failed to register prompt variant");
  }
}

/**
 * Record the outcome of a prompt variant (called when PR is merged or rejected).
 */
export async function recordPromptOutcome({ taskId, promptType, merged, revisionsNeeded, timeToMergeMs }) {
  try {
    await pool.query(
      `UPDATE prompt_variants SET merged = $3, revisions_needed = $4, time_to_merge_ms = $5, outcome_recorded_at = NOW()
       WHERE task_id = $1 AND prompt_type = $2`,
      [taskId, promptType, merged, revisionsNeeded, timeToMergeMs]
    );
  } catch (err) {
    logger.warn({ taskId, promptType, err: err.message }, "Failed to record prompt outcome");
  }
}

/**
 * Get performance stats for prompt variants.
 * Returns which variants have the best merge rates.
 */
export async function getPromptVariantStats(promptType, repoFullName = null) {
  try {
    let query = `
      SELECT variant_id,
             COUNT(*) as total_uses,
             COUNT(*) FILTER (WHERE merged = TRUE) as merges,
             COUNT(*) FILTER (WHERE merged = FALSE) as rejections,
             ROUND(COUNT(*) FILTER (WHERE merged = TRUE)::numeric / NULLIF(COUNT(*) FILTER (WHERE outcome_recorded_at IS NOT NULL), 0) * 100, 1) as merge_rate,
             ROUND(AVG(revisions_needed) FILTER (WHERE outcome_recorded_at IS NOT NULL), 1) as avg_revisions,
             ROUND(AVG(time_to_merge_ms) FILTER (WHERE merged = TRUE) / 3600000.0, 1) as avg_hours_to_merge
      FROM prompt_variants
      WHERE prompt_type = $1`;

    const params = [promptType];

    if (repoFullName) {
      query += ` AND repo_full_name = $2`;
      params.push(repoFullName);
    }

    query += ` GROUP BY variant_id ORDER BY merge_rate DESC NULLS LAST, total_uses DESC`;

    const { rows } = await pool.query(query, params);
    return rows;
  } catch (err) {
    logger.warn({ promptType, err: err.message }, "Failed to get prompt variant stats");
    return [];
  }
}

/**
 * Get the best-performing prompt variant for a given type/repo.
 * Returns the variant ID with the highest merge rate (min 3 uses).
 */
export async function getBestPromptVariant(promptType, repoFullName = null) {
  const stats = await getPromptVariantStats(promptType, repoFullName);
  const qualified = stats.filter(s => s.total_uses >= 3 && s.merge_rate !== null);

  if (qualified.length === 0) return null;

  return {
    variantId: qualified[0].variant_id,
    mergeRate: qualified[0].merge_rate,
    totalUses: qualified[0].total_uses,
    avgRevisions: qualified[0].avg_revisions,
  };
}

/**
 * Generate a variant ID from prompt content.
 * Uses a simple hash for tracking purposes.
 */
export function generateVariantHash(promptContent) {
  let hash = 0;
  for (let i = 0; i < promptContent.length; i++) {
    const char = promptContent.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `v_${Math.abs(hash).toString(36)}`;
}

/**
 * Get overall prompt evolution summary for dashboard.
 */
export async function getPromptEvolutionSummary() {
  try {
    const { rows } = await pool.query(
      `SELECT prompt_type,
              COUNT(DISTINCT variant_id) as variant_count,
              COUNT(*) as total_uses,
              ROUND(COUNT(*) FILTER (WHERE merged = TRUE)::numeric / NULLIF(COUNT(*) FILTER (WHERE outcome_recorded_at IS NOT NULL), 0) * 100, 1) as overall_merge_rate
       FROM prompt_variants
       GROUP BY prompt_type
       ORDER BY prompt_type`
    );
    return rows;
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to get prompt evolution summary");
    return [];
  }
}