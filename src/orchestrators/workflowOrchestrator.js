// src/orchestrators/workflowOrchestrator.js
// Main flow routing for quality check → reject/approve → coding plan → PR.

import { pool } from "../db.js";
import { logger } from "../logger.js";
import {
  postTaskComment,
  updateTaskStatus,
  updateTaskAssignees,
  addTagToTask,
  getRawTaskDetails,
} from "../clickup-client.js";
import { evaluateTaskQuality } from "../services/qualityCheckService.js";
import { generateCodingPlan } from "../services/codingPlanService.js";
import { startApprovalPolling } from "../handlers/approvalHandler.js";
import { extractAllRepos, ensureRepoCloned } from "../execution-engine.js";
import { detectProjectType, generateContextPrompt } from "../project-context.js";
import { config } from "../config-manager.js";
import { indexRepository, getRelevantContext } from "../codebase-index.js";
import { DebateOrchestrator } from "../debate/debate-orchestrator.js";
import { enqueueTask, createDebateSession, getSlackThreadTs, addExecutionLog } from "../task-queue.js";
import { scoreComplexity } from "../complexity.js";
import { assessComplexityWithLLM, combineComplexityScores } from "../services/llmComplexityService.js";
import { generateDiffPreview } from "../services/diffPreviewService.js";
import { sendApprovalMessage } from "../services/slackInteractiveService.js";

// ── Config Loader (no caching — always reads fresh) ──────────────

async function getWorkflowConfig() {
  const { rows } = await pool.query("SELECT * FROM admin_workflow_config WHERE id = 1");
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    qualityCheckRejectFlow: row.quality_check_reject_flow,
    qualityCheckApproveFlow: row.quality_check_approve_flow,
    qualityScoreThreshold: row.quality_score_threshold,
    rejectStatus: row.reject_status,
    approveStatus: row.approve_status,
    prRaisedStatus: row.pr_raised_status,
    approvalKeywords: typeof row.approval_keywords === "string"
      ? JSON.parse(row.approval_keywords)
      : row.approval_keywords || [],
    needsRevisionTag: row.needs_revision_tag,
    requireRepoField: row.require_repo_field ?? false,
    debateComplexityThreshold: row.debate_complexity_threshold || "complex",
  };
}

// ── Retry helper for ClickUp API calls ───────────────────────────

async function withRetry(fn, { maxRetries = 3, label = "ClickUp API" } = {}) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) {
        logger.error({ label, attempt, err: err.message }, `${label} failed after ${maxRetries} attempts`);
        throw err;
      }
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10_000);
      logger.warn({ label, attempt, delay, err: err.message }, `${label} failed, retrying`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ── Workflow Step Logger ─────────────────────────────────────────

function logStep(taskId, flowType, stepName, status, extra = {}) {
  const entry = {
    taskId,
    flowType,
    stepName,
    status,
    ...extra,
  };
  if (status === "fail") {
    logger.error(entry, `Workflow step failed: ${stepName}`);
  } else if (status === "start") {
    logger.debug(entry, `Workflow step: ${stepName}`);
  } else {
    logger.info(entry, `Workflow step: ${stepName}`);
  }
}

// ── Main Entry Point ─────────────────────────────────────────────

/**
 * Run the quality check workflow for a ClickUp task.
 * Reads config fresh on each invocation.
 *
 * @param {object} task - Normalized ClickUp task (from getTaskDetails)
 * @param {object} [opts] - Options
 * @param {number} [opts.dbTaskId] - Database task ID (for execution logs visible in dashboard)
 * @returns {{ action: string, score: number, issues?: string[] }}
 */
export async function runWorkflow(task, { dbTaskId } = {}) {
  const cfg = await getWorkflowConfig();
  if (!cfg) {
    logger.warn({ taskId: task.id }, "Workflow config not found, skipping quality check workflow");
    return { action: "skipped", reason: "no_config" };
  }

  if (!cfg.qualityCheckRejectFlow && !cfg.qualityCheckApproveFlow) {
    logger.debug({ taskId: task.id }, "Both workflow flows are disabled, skipping");
    return { action: "skipped", reason: "flows_disabled" };
  }

  // Step 1: Run quality check
  logStep(task.id, "quality_check", "ai_evaluation", "start");
  if (dbTaskId) await addExecutionLog(dbTaskId, "info", "quality_check", "Running AI quality evaluation...");
  let result;
  try {
    result = await evaluateTaskQuality(task);
    logStep(task.id, "quality_check", "ai_evaluation", "success", {
      score: result.score,
      issueCount: result.issues.length,
    });
    if (dbTaskId) await addExecutionLog(dbTaskId, "info", "quality_check", `Quality score: ${result.score}/100 (threshold: ${cfg.qualityScoreThreshold}), issues: ${result.issues.length}`);
  } catch (err) {
    logStep(task.id, "quality_check", "ai_evaluation", "fail", { error: err.message });
    if (dbTaskId) await addExecutionLog(dbTaskId, "error", "quality_check", `Quality check failed: ${err.message}`);
    // Do NOT change task state on AI failure
    return { action: "error", reason: "quality_check_failed", error: err.message };
  }

  // Step 2: Route based on score and config
  const belowThreshold = result.score < cfg.qualityScoreThreshold;

  if (belowThreshold && cfg.qualityCheckRejectFlow) {
    if (dbTaskId) await addExecutionLog(dbTaskId, "warn", "quality_check", `Task below threshold (${result.score} < ${cfg.qualityScoreThreshold}), running reject flow`);
    return await runRejectFlow(task, result, cfg);
  }

  if (!belowThreshold && cfg.qualityCheckApproveFlow) {
    if (dbTaskId) await addExecutionLog(dbTaskId, "info", "quality_check", `Task passed quality check, starting approve flow`);
    return await runApproveFlow(task, result, cfg, { dbTaskId });
  }

  // Score below threshold but reject flow disabled, or score above but approve flow disabled
  logger.info(
    { taskId: task.id, score: result.score, threshold: cfg.qualityScoreThreshold },
    "Quality check complete but applicable flow is disabled"
  );
  return { action: "no_action", score: result.score, issues: result.issues };
}

// ── Reject Flow ──────────────────────────────────────────────────

async function runRejectFlow(task, qualityResult, cfg) {
  const flowType = "reject";

  // Step 2a: Post rejection comment
  logStep(task.id, flowType, "post_comment", "start");
  try {
    const comment = formatRejectionComment(qualityResult, cfg.qualityScoreThreshold);
    await withRetry(() => postTaskComment(task.id, comment), { label: "postRejectionComment" });
    logStep(task.id, flowType, "post_comment", "success");
  } catch (err) {
    logStep(task.id, flowType, "post_comment", "fail", { error: err.message });
    // Continue — don't block on comment failure
  }

  // Step 2b: Re-assign to task creator
  logStep(task.id, flowType, "reassign_creator", "start");
  try {
    const creatorId = await getTaskCreatorId(task.id);
    if (creatorId) {
      await withRetry(() => updateTaskAssignees(task.id, [Number(creatorId)]), { label: "reassignCreator" });
      logStep(task.id, flowType, "reassign_creator", "success", { creatorId });
    } else {
      logStep(task.id, flowType, "reassign_creator", "success", { note: "no creator found, skipping" });
    }
  } catch (err) {
    logStep(task.id, flowType, "reassign_creator", "fail", { error: err.message });
  }

  // Step 2c: Change status to reject status
  logStep(task.id, flowType, "update_status", "start");
  try {
    await withRetry(() => updateTaskStatus(task.id, cfg.rejectStatus), { label: "updateRejectStatus" });
    logStep(task.id, flowType, "update_status", "success", { status: cfg.rejectStatus });
  } catch (err) {
    logStep(task.id, flowType, "update_status", "fail", { error: err.message });
  }

  // Step 2d: Add needs-revision tag if configured
  if (cfg.needsRevisionTag) {
    logStep(task.id, flowType, "add_tag", "start");
    try {
      await withRetry(() => addTagToTask(task.id, cfg.needsRevisionTag), { label: "addRevisionTag" });
      logStep(task.id, flowType, "add_tag", "success", { tag: cfg.needsRevisionTag });
    } catch (err) {
      logStep(task.id, flowType, "add_tag", "fail", { error: err.message });
    }
  }

  return {
    action: "rejected",
    score: qualityResult.score,
    issues: qualityResult.issues,
    summary: qualityResult.summary,
  };
}

// ── Approve Flow ─────────────────────────────────────────────────

async function runApproveFlow(task, qualityResult, cfg, { dbTaskId } = {}) {
  const flowType = "approve";

  // Dedup guard: skip if a plan is already pending approval for this task
  try {
    const { rows: existing } = await pool.query(
      `SELECT id, state FROM workflow_approvals
       WHERE clickup_task_id = $1 AND state IN ('pending_approval', 'approved')
       ORDER BY created_at DESC LIMIT 1`,
      [task.id]
    );
    if (existing.length > 0) {
      logger.warn({ taskId: task.id, existingState: existing[0].state }, "Approve flow already ran for this task — skipping duplicate");
      return { action: "skipped", reason: "duplicate_approve_flow", existingState: existing[0].state };
    }
  } catch (err) {
    logger.warn({ taskId: task.id, err: err.message }, "Dedup check failed, continuing approve flow");
  }

  // Step 2a: Update status to approve status
  logStep(task.id, flowType, "update_status", "start");
  try {
    await withRetry(() => updateTaskStatus(task.id, cfg.approveStatus), { label: "updateApproveStatus" });
    logStep(task.id, flowType, "update_status", "success", { status: cfg.approveStatus });
  } catch (err) {
    logStep(task.id, flowType, "update_status", "fail", { error: err.message });
    // Status update is critical — abort flow
    return { action: "error", reason: "status_update_failed", error: err.message };
  }

  // Step 2b: Validate repo field (if required by config) — supports multi-repo
  const allRepos = extractAllRepos(task);
  const repoInfo = allRepos.length > 0 ? allRepos[0] : null;
  if (allRepos.length === 0 && cfg.requireRepoField) {
    logStep(task.id, flowType, "repo_validation", "fail", { reason: "missing_repo_field" });
    logger.warn({ taskId: task.id }, "Repo field is required but missing — aborting approve flow");
    try {
      await postTaskComment(
        task.id,
        [
          `⚠️ **Missing Repository Field**`,
          ``,
          `This task does not have a **Repo** (or Repository) custom field set.`,
          `The workflow requires a target repository to generate an accurate coding plan.`,
          ``,
          `**To fix:** Set the "Repo" custom field on this task to the target GitHub repository, then re-trigger the workflow.`,
          ``,
          `> _This check can be disabled by an admin in the Workflows dashboard → "Require Repo Field"._`,
        ].join("\n")
      );
    } catch (_) {}
    return {
      action: "error",
      reason: "missing_repo_field",
      score: qualityResult.score,
    };
  }
  if (allRepos.length > 0) {
    const repoNames = allRepos.map((r) => r.fullName).join(", ");
    logStep(task.id, flowType, "repo_validation", "success", { repos: repoNames, count: allRepos.length });
  } else {
    logStep(task.id, flowType, "repo_validation", "success", { note: "no repo field, but not required by config" });
  }

  // Step 2c: Resolve ALL repos and build combined deep context for plan generation
  let repoContext = null;
  let repoName = null;
  let codebaseIndex = null;
  let projectType = null; // detected project type (e.g. "kotlin-spring", "spring-boot")
  logStep(task.id, flowType, "resolve_repo", "start");
  if (dbTaskId) await addExecutionLog(dbTaskId, "info", "resolve_repo", "Resolving repositories and building code context...");
  try {
    if (allRepos.length > 0) {
      repoName = allRepos.map((r) => r.fullName).join(", ");
      logStep(task.id, flowType, "resolve_repo", "success", { repos: repoName, count: allRepos.length });

      // Clone/fetch ALL repos and build combined context
      const contextParts = [];
      for (const repo of allRepos) {
        logStep(task.id, flowType, "clone_repo", "start", { repo: repo.fullName });
        const repoPath = await ensureRepoCloned(repo.fullName);
        logStep(task.id, flowType, "clone_repo", "success", { repo: repo.fullName, repoPath });

        // Detect project type and generate context prompt
        logStep(task.id, flowType, "detect_project", "start", { repo: repo.fullName });
        const projectInfo = detectProjectType(repoPath);
        if (!projectType) projectType = projectInfo.type; // capture first repo's type
        let thisRepoContext = generateContextPrompt(projectInfo, repoPath);
        logStep(task.id, flowType, "detect_project", "success", { repo: repo.fullName, projectType: projectInfo.type });

        // Run codebase indexer for deep context
        if (config.get("codebaseIndexEnabled")) {
          logStep(task.id, flowType, "index_codebase", "start", { repo: repo.fullName });
          try {
            const thisIndex = indexRepository(repoPath);
            if (thisIndex) {
              // Keep first repo's index as primary (for complexity scoring downstream)
              if (!codebaseIndex) codebaseIndex = thisIndex;
              const taskDescription = task.markdownDescription || task.description || task.name;
              const maxTokens = config.get("codebaseIndexMaxTokens") || 4000;
              const relevantContext = getRelevantContext(thisIndex, taskDescription, maxTokens);
              if (relevantContext) {
                thisRepoContext = thisRepoContext + "\n\n" + relevantContext;
              }
              logStep(task.id, flowType, "index_codebase", "success", {
                repo: repo.fullName,
                controllers: thisIndex.controllers?.length || 0,
                services: thisIndex.services?.length || 0,
                models: thisIndex.models?.length || 0,
              });
            }
          } catch (indexErr) {
            logStep(task.id, flowType, "index_codebase", "fail", { repo: repo.fullName, error: indexErr.message });
          }
        }

        contextParts.push(`### Repository: ${repo.fullName}\n\n${thisRepoContext}`);
      }

      repoContext = contextParts.join("\n\n---\n\n");
      const contextTokenEstimate = Math.round((repoContext || "").length / 4);
      logStep(task.id, flowType, "resolve_repo", "combined_context", {
        repoCount: allRepos.length,
        contextTokensEstimate: contextTokenEstimate,
      });
    } else {
      logStep(task.id, flowType, "resolve_repo", "success", { note: "no repo field found, generating plan without repo context" });
    }
  } catch (err) {
    logStep(task.id, flowType, "resolve_repo", "fail", { error: err.message });
    // Non-fatal — continue plan generation without repo context
    if (repoContext) {
      repoContext += "\n\n> **Warning:** Full repo context could not be fetched: " + err.message;
    }
  }

  // Step 2d: Run debate if enabled AND task complexity meets threshold
  const debateEnabled = config.get("debateEnabled");
  let codingPlan;
  let planSource = "standard"; // track origin: "debate" or "standard"

  // Compute task complexity to determine if debate is warranted.
  // Keyword scoring is instant; when llmComplexityEnabled, an LLM assessment
  // (cheap model, keyword score passed as a hint) is blended in 30/70.
  const taskDesc = task.markdownDescription || task.description || task.name || "";
  const keywordResult = scoreComplexity(taskDesc, codebaseIndex);
  let complexityResult = keywordResult;

  if (config.get("llmComplexityEnabled")) {
    try {
      const llmResult = await assessComplexityWithLLM({
        taskName: task.name,
        taskDescription: taskDesc,
        repoContext,
        keywordScore: keywordResult,
      });
      complexityResult = combineComplexityScores(keywordResult, llmResult);
      if (dbTaskId) {
        await pool.query(
          `UPDATE tasks SET llm_complexity_score = $1, complexity_risks = $2, updated_at = NOW() WHERE id = $3`,
          [llmResult.score, JSON.stringify(llmResult.risks || []), dbTaskId]
        ).catch(() => {});
      }
    } catch (err) {
      logger.warn({ taskId: task.id, err: err.message }, "LLM complexity assessment failed — using keyword score");
    }
  }

  const taskComplexity = complexityResult.level;

  if (dbTaskId) {
    const detail = complexityResult.method === "combined"
      ? ` (keyword ${complexityResult.keywordScore}, LLM ${complexityResult.llmScore}${complexityResult.reasoning ? ` — ${complexityResult.reasoning}` : ""})`
      : "";
    await addExecutionLog(dbTaskId, "info", "complexity", `Task complexity: ${complexityResult.level} (score: ${complexityResult.score}/100)${detail}`);
  }

  // Check debate complexity threshold from workflow config (cfg was loaded
  // by runWorkflow and passed in — the old second query dropped the field)
  const complexityOrder = ["simple", "medium", "complex", "critical"];
  const debateThreshold = cfg?.debateComplexityThreshold || "complex";
  const taskComplexityIdx = complexityOrder.indexOf(taskComplexity);
  const thresholdIdx = complexityOrder.indexOf(debateThreshold);
  const meetsDebateThreshold = debateThreshold !== "disabled" && taskComplexityIdx >= 0 && thresholdIdx >= 0 && taskComplexityIdx >= thresholdIdx;

  if (debateEnabled && meetsDebateThreshold) {
    logStep(task.id, flowType, "debate", "start");
    if (dbTaskId) await addExecutionLog(dbTaskId, "info", "debate", `Starting multi-model debate (complexity ${taskComplexity} meets threshold ${debateThreshold})...`);
    try {
      codingPlan = await runDebateForPlan(task, qualityResult, { repoContext, repoName, codebaseIndex, projectType, dbTaskId });
      planSource = "debate";
      logStep(task.id, flowType, "debate", "success", { planLength: codingPlan.length, planSource });
      if (dbTaskId) await addExecutionLog(dbTaskId, "info", "debate", `Debate completed — plan generated (${codingPlan.length} chars)`);
    } catch (err) {
      logStep(task.id, flowType, "debate", "fail", { error: err.message });
      if (dbTaskId) await addExecutionLog(dbTaskId, "warn", "debate", `Debate failed: ${err.message} — falling back to standard plan generation`);
      logger.warn({ taskId: task.id }, "Debate failed, falling back to direct plan generation");
      // Fall through to standard plan generation
      codingPlan = null;
    }
  } else {
    if (dbTaskId) {
      if (!debateEnabled) {
        await addExecutionLog(dbTaskId, "info", "planning", "Debate disabled — generating plan directly");
      } else {
        await addExecutionLog(dbTaskId, "info", "planning", `Task complexity (${taskComplexity}) below debate threshold (${debateThreshold}) — generating plan directly`);
      }
    }
  }

  // Standard plan generation (no debate, or debate failed as fallback)
  // Configurable: planSkipComplexityThreshold allows skipping plan generation for simple tasks.
  const planSkipThreshold = config.get("planSkipComplexityThreshold") || "none";
  const planSkipOrder = ["simple", "medium", "complex", "critical"];
  const planTaskIdx = planSkipOrder.indexOf(taskComplexity);
  const planSkipIdx = planSkipOrder.indexOf(planSkipThreshold);
  const shouldSkipPlan = planSkipThreshold !== "none" && planTaskIdx >= 0 && planSkipIdx >= 0 && planTaskIdx <= planSkipIdx;

  if (!codingPlan && shouldSkipPlan) {
    logStep(task.id, flowType, "generate_plan", "skipped", { reason: `complexity ${taskComplexity} at or below threshold ${planSkipThreshold}` });
    if (dbTaskId) await addExecutionLog(dbTaskId, "info", "generate_plan", `Plan generation skipped — task complexity (${taskComplexity}) at or below threshold (${planSkipThreshold}). Executing directly.`);
    planSource = "skipped";
  } else if (!codingPlan) {
    logStep(task.id, flowType, "generate_plan", "start");
    if (dbTaskId) await addExecutionLog(dbTaskId, "info", "generate_plan", "Generating coding plan...");
    try {
      codingPlan = await generateCodingPlan(task, { repoContext, repoName, projectType });
      planSource = (debateEnabled && meetsDebateThreshold) ? "standard_fallback" : "standard";
      logStep(task.id, flowType, "generate_plan", "success", { planLength: codingPlan.length, planSource });
      if (dbTaskId) await addExecutionLog(dbTaskId, "info", "generate_plan", `Coding plan generated (${codingPlan.length} chars, source: ${planSource})`);
    } catch (err) {
      logStep(task.id, flowType, "generate_plan", "fail", { error: err.message });
      if (dbTaskId) await addExecutionLog(dbTaskId, "error", "generate_plan", `Plan generation failed: ${err.message}`);
      try {
        await postTaskComment(task.id, `⚠️ Coding plan generation failed: ${err.message}\nPlease create a plan manually.`);
      } catch (_) {}
      return { action: "error", reason: "plan_generation_failed", error: err.message };
    }
  }

  // When plan generation was skipped (simple task), bypass the entire approval flow
  // and return an action that lets the caller proceed directly to execution.
  if (planSource === "skipped") {
    // Post a brief comment to ClickUp so the task has some context
    try {
      await postTaskComment(task.id, `⚡ **Quick task** (complexity: ${taskComplexity}) — skipping plan approval, executing directly.`);
    } catch (_) {}

    // Auto-approve in workflow_approvals so execution pipeline can find it
    try {
      await pool.query(
        `INSERT INTO workflow_approvals
          (clickup_task_id, coding_plan, quality_score, quality_summary, state, plan_posted_at, approved_at)
         VALUES ($1, $2, $3, $4, 'approved', NOW(), NOW())`,
        [task.id, null, qualityResult.score, qualityResult.summary]
      );
    } catch (_) {}

    // Update task state to approved so execution pipeline picks it up
    if (dbTaskId) {
      try {
        await pool.query("UPDATE tasks SET state = 'approved', approved_at = NOW(), updated_at = NOW() WHERE id = $1", [dbTaskId]);
      } catch (_) {}
    }

    return {
      action: "execute_directly",
      score: qualityResult.score,
      summary: qualityResult.summary,
      planSource: "skipped",
      debateUsed: false,
    };
  }

  // Step 2e: Generate diff preview if enabled
  let diffPreview = null;
  let predictedFiles = [];
  if (config.get("diffPreviewEnabled")) {
    logStep(task.id, flowType, "diff_preview", "start");
    if (dbTaskId) await addExecutionLog(dbTaskId, "info", "diff_preview", "Generating impact/diff preview...");
    try {
      const dbTaskRow = await pool.query("SELECT id FROM tasks WHERE clickup_task_id = $1 ORDER BY id DESC LIMIT 1", [task.id]);
      const diffTaskId = dbTaskId || dbTaskRow.rows[0]?.id || null;

      const previewResult = await generateDiffPreview({
        codingPlan,
        taskName: task.name,
        repoContext,
        taskId: diffTaskId,
      });
      diffPreview = previewResult.preview;
      predictedFiles = previewResult.predictedFiles;
      logStep(task.id, flowType, "diff_preview", "success", { fileCount: predictedFiles.length });
    } catch (err) {
      logStep(task.id, flowType, "diff_preview", "fail", { error: err.message });
      // Non-fatal — continue without diff preview
    }
  }

  // Step 2f: Post coding plan as comment (with quality score header + diff preview) and store the comment ID
  // NOTE: This posts AFTER debate is complete — the plan is only sent to ClickUp once finalized
  logStep(task.id, flowType, "post_plan", "start");
  if (dbTaskId) await addExecutionLog(dbTaskId, "info", "post_plan", "Posting coding plan to ClickUp for approval...");
  let planCommentId = null;
  try {
    const planParts = [
      `**Quality Score:** ${qualityResult.score}/100 (threshold: ${cfg.qualityScoreThreshold})`,
      "",
      codingPlan,
    ];

    // Include diff preview in the plan comment
    if (diffPreview) {
      planParts.push("", "---", "", "## 🔍 Impact Preview", "", diffPreview);
    }

    const planWithScore = planParts.join("\n");
    const commentResponse = await withRetry(() => postTaskComment(task.id, planWithScore), { label: "postCodingPlan" });
    planCommentId = commentResponse?.id || null;
    logStep(task.id, flowType, "post_plan", "success", { planCommentId, planSource, hasDiffPreview: !!diffPreview });
  } catch (err) {
    logStep(task.id, flowType, "post_plan", "fail", { error: err.message });
  }

  // Step 2g: Assign to primary assignee (first assignee or creator fallback)
  logStep(task.id, flowType, "assign_owner", "start");
  try {
    const ownerId = task.assignees?.[0]?.id || await getTaskCreatorId(task.id);
    if (ownerId) {
      await withRetry(() => updateTaskAssignees(task.id, [Number(ownerId)]), { label: "assignOwner" });
      logStep(task.id, flowType, "assign_owner", "success", { ownerId });
    }
  } catch (err) {
    logStep(task.id, flowType, "assign_owner", "fail", { error: err.message });
  }

  // Step 2h: Add "Awaiting Plan Approval" tag
  logStep(task.id, flowType, "add_approval_tag", "start");
  try {
    await withRetry(() => addTagToTask(task.id, "Awaiting Plan Approval"), { label: "addApprovalTag" });
    logStep(task.id, flowType, "add_approval_tag", "success");
  } catch (err) {
    logStep(task.id, flowType, "add_approval_tag", "fail", { error: err.message });
  }

  // Step 2i: Store approval record with plan comment ID, diff preview, and predicted files
  logStep(task.id, flowType, "create_approval_record", "start");
  try {
    await pool.query(
      `INSERT INTO workflow_approvals
        (clickup_task_id, coding_plan, quality_score, quality_summary, state, plan_comment_id, plan_posted_at, diff_preview, predicted_files)
       VALUES ($1, $2, $3, $4, 'pending_approval', $5, NOW(), $6, $7)`,
      [task.id, codingPlan, qualityResult.score, qualityResult.summary, planCommentId, diffPreview, JSON.stringify(predictedFiles)]
    );
    logStep(task.id, flowType, "create_approval_record", "success", { planCommentId });
  } catch (err) {
    logStep(task.id, flowType, "create_approval_record", "fail", { error: err.message });
  }

  if (dbTaskId) await addExecutionLog(dbTaskId, "info", "awaiting_approval", "Plan posted — awaiting human approval before implementation begins");

  // Step 2j: Send Slack interactive approval message if enabled
  if (config.get("slackInteractiveApprovalsEnabled")) {
    logStep(task.id, flowType, "slack_approval", "start");
    try {
      // Try to get task's Slack thread for threading
      const dbTask = await pool.query("SELECT id FROM tasks WHERE clickup_task_id = $1 ORDER BY id DESC LIMIT 1", [task.id]);
      const dbTaskId = dbTask.rows[0]?.id || null;
      const threadTs = dbTaskId ? await getSlackThreadTs(dbTaskId).catch(() => null) : null;

      const slackResult = await sendApprovalMessage({
        clickupTaskId: task.id,
        taskName: task.name,
        planSummary: codingPlan,
        qualityScore: qualityResult.score,
        repoName,
        threadTs,
      });

      if (slackResult.ok) {
        // Store Slack message reference for updating later
        try {
          await pool.query(
            `UPDATE workflow_approvals SET slack_message_ts = $1, slack_channel_id = $2
             WHERE clickup_task_id = $3 AND state = 'pending_approval'`,
            [slackResult.ts, config.get("slackChannel") || process.env.SLACK_CHANNEL_ID, task.id]
          );
        } catch (_) {}
        logStep(task.id, flowType, "slack_approval", "success", { messageTs: slackResult.ts });
      } else {
        logStep(task.id, flowType, "slack_approval", "fail", { note: "Slack message not sent" });
      }
    } catch (err) {
      logStep(task.id, flowType, "slack_approval", "fail", { error: err.message });
    }
  }

  // Step 2k: Start polling for approval comments (with plan comment ID for gating)
  logStep(task.id, flowType, "start_approval_watch", "start");
  try {
    startApprovalPolling(task.id, cfg.approvalKeywords, { planCommentId });
    logStep(task.id, flowType, "start_approval_watch", "success");
  } catch (err) {
    logStep(task.id, flowType, "start_approval_watch", "fail", { error: err.message });
  }

  return {
    action: "approved_pending_plan",
    score: qualityResult.score,
    summary: qualityResult.summary,
    planSource,
    debateUsed: planSource === "debate",
    hasDiffPreview: !!diffPreview,
  };
}

// ── Debate-Driven Plan Generation ────────────────────────────────

/**
 * Run the multi-model debate engine and use the leader's final output as the coding plan.
 * The debate is grounded in real repo context (codebase index, project type, etc.).
 */
async function runDebateForPlan(task, qualityResult, { repoContext, repoName, codebaseIndex, projectType, dbTaskId }) {
  logger.info({ taskId: task.id, dbTaskId, projectType }, "Running debate engine before plan generation (debate enabled)");

  // Use the existing task record from the DB (already enqueued by handleTask)
  // If dbTaskId is provided, use it directly; otherwise fall back to enqueueTask for backward compat
  let dbTask;
  if (dbTaskId) {
    const { getTaskById } = await import("../task-queue.js");
    dbTask = await getTaskById(dbTaskId);
    if (!dbTask) throw new Error(`Task ${dbTaskId} not found in database`);
  } else {
    const { task: enqueuedTask } = await enqueueTask(task, { source: "workflow_debate" });
    if (!enqueuedTask) throw new Error("Failed to create task record for debate");
    dbTask = enqueuedTask;
  }

  // Attach repo context + project type to the task record for the debate prompts
  const contextWithProjectType = [
    projectType ? `**Project type:** ${projectType}` : null,
    repoContext,
  ].filter(Boolean).join("\n\n");
  if (contextWithProjectType) {
    await pool.query(
      "UPDATE tasks SET custom_instructions = $1 WHERE id = $2",
      [contextWithProjectType, dbTask.id]
    );
    dbTask.custom_instructions = contextWithProjectType;
  }

  // Read debate config
  const leaderModel = config.get("debateLeaderModel");
  const participants = config.getJSON("debateParticipants") || [];
  const debateStyle = config.get("debateStyle");
  const maxRounds = config.get("debateMaxRounds");
  const timeout = config.get("debateModelTimeout");
  const temperature = config.get("debateTemperature");
  const maxTokens = config.get("debateMaxTokens");

  if (participants.length < 1) {
    logger.warn({ taskId: task.id }, "Debate enabled but no participants configured, skipping debate");
    throw new Error("No debate participants configured");
  }

  // Create a debate session
  const session = await createDebateSession(dbTask.id, {
    leaderModel,
    participants,
    debateStyle,
    maxRounds,
  });

  logger.info({
    taskId: task.id,
    dbTaskId: dbTask.id,
    debateSessionId: session.id,
    leaderModel,
    participantCount: participants.length,
    style: debateStyle,
    maxRounds,
  }, "Debate session created for approve-flow plan generation");

  await addExecutionLog(dbTask.id, "info", "debate", `Debate session created (style: ${debateStyle}, leader: ${leaderModel}, ${participants.length} participants, max ${maxRounds} rounds)`);

  // Run the debate (synchronously — plan must be ready before posting)
  const orchestrator = new DebateOrchestrator(dbTask, {
    debateSessionId: session.id,
    leaderModel,
    participants,
    debateStyle,
    maxRounds,
    timeout,
    temperature,
    maxTokens,
  });

  const result = await orchestrator.run();

  if (!result.finalPlan || !result.finalPlan.trim()) {
    throw new Error("Debate produced empty plan");
  }

  logger.info({
    taskId: task.id,
    debateSessionId: session.id,
    rounds: result.rounds,
    degraded: result.degraded,
    planLength: result.finalPlan.length,
  }, "Debate completed — using leader's final plan as coding plan");

  await addExecutionLog(dbTask.id, "info", "debate", `Debate completed in ${result.rounds} round(s)${result.degraded ? " (degraded — some participants failed)" : ""} — plan ready for review`);

  // Format the debate result as a coding plan with preamble
  const agentName = process.env.AGENT_NAME || "AutoShip";
  const preambleParts = [
    `> *This plan was generated by ${agentName} via multi-model debate (${debateStyle}, ${result.rounds} rounds). Please review before approving.*`,
  ];
  if (repoName) {
    preambleParts.push(`> **Target repo:** \`${repoName}\``);
  }
  if (result.degraded) {
    preambleParts.push(`> ⚠️ *Some debate participants failed — plan may be less comprehensive.*`);
  }

  return [...preambleParts, "", result.finalPlan.trim()].join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────

async function getTaskCreatorId(clickupTaskId) {
  try {
    const raw = await getRawTaskDetails(clickupTaskId);
    return raw.creator?.id || null;
  } catch (err) {
    logger.warn({ taskId: clickupTaskId, err: err.message }, "Could not fetch task creator");
    return null;
  }
}

function formatRejectionComment(qualityResult, threshold) {
  const lines = [
    `## ⚠️ Task Quality Check — Needs Revision`,
    "",
    `**Score:** ${qualityResult.score}/100 (threshold: ${threshold})`,
    "",
    `**Summary:** ${qualityResult.summary}`,
    "",
  ];

  if (qualityResult.issues.length > 0) {
    lines.push("**Issues Found:**");
    for (const issue of qualityResult.issues) {
      lines.push(`- ${issue}`);
    }
    lines.push("");
  }

  lines.push(
    "Please address the issues above and update the task description, then move the task back to the appropriate status."
  );

  return lines.join("\n");
}
