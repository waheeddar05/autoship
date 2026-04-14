// src/debate/debate-orchestrator.js
// Core debate pipeline for multi-model task planning.

import { providerRegistry } from "../providers/provider-registry.js";
import { config } from "../config-manager.js";
import { logger } from "../logger.js";
import { metrics } from "../metrics.js";
import { updateDebateSession, getDebateSession, startStep, completeStep, addTaskCost } from "../task-queue.js";
import { notifySlack } from "../slack-notifier.js";
import { recordStepDuration, recordTokenUsage, recordCost, setDebateParticipants } from "../prometheus.js";
import { getIndexSummary } from "../codebase-index.js";
import {
  buildTaskContext, buildRoleSystemPrompt, buildLeaderSystemPrompt,
  buildCritiquePrompt, buildRevisionPrompt, buildDebaterSystemPrompt,
  buildDebateRoundPrompt, buildLeaderSynthesisPrompt, buildExecutionModelPrompt,
} from "./debate-prompts.js";

export class DebateOrchestrator {
  /**
   * @param {Object} taskRecord - Task row from DB
   * @param {Object} opts
   * @param {number} opts.debateSessionId
   * @param {string} opts.leaderModel - "provider:model"
   * @param {Array<{model: string, role: string}>} opts.participants
   * @param {string} opts.debateStyle - "assigned_roles" | "free_debate"
   * @param {number} opts.maxRounds
   * @param {number} opts.timeout - per-model timeout in ms
   * @param {number} opts.temperature
   * @param {number} opts.maxTokens
   */
  constructor(taskRecord, opts) {
    this.task = taskRecord;
    this.sessionId = opts.debateSessionId;
    this.leaderModel = opts.leaderModel;
    this.participants = opts.participants;
    this.debateStyle = opts.debateStyle;
    this.maxRounds = opts.maxRounds;
    this.timeout = opts.timeout || 60000;
    this.temperature = opts.temperature ?? 0.7;
    this.maxTokens = opts.maxTokens || 4096;
    this.transcript = [];
    this.taskContext = buildTaskContext(taskRecord);
  }

  async run() {
    const start = Date.now();

    try {
      await startStep(this.task.id, "debate");
      await updateDebateSession(this.sessionId, { state: "debating" });
      setDebateParticipants(this.participants.length);
      this._emitEvent("debate:started", { taskId: this.task.id, style: this.debateStyle });

      let result;
      if (this.debateStyle === "assigned_roles") {
        result = await this._runAssignedRoles();
      } else {
        result = await this._runFreeDebate();
      }

      // Leader selects execution model if configured
      let executionModel = null;
      if (config.get("executionModelMode") === "leader_selects") {
        executionModel = await this._selectExecutionModel(result.finalPlan);
      }

      const duration = Date.now() - start;
      await completeStep(this.task.id, "debate");
      recordStepDuration("debate", duration);
      setDebateParticipants(0);

      await updateDebateSession(this.sessionId, {
        state: "done",
        final_plan: result.finalPlan,
        transcript: this.transcript,
        actual_rounds: result.rounds,
        execution_model: executionModel,
        degraded: result.degraded || false,
        duration_ms: duration,
        completed_at: new Date().toISOString(),
      });

      this._emitEvent("debate:completed", {
        taskId: this.task.id,
        debateId: this.sessionId,
        rounds: result.rounds,
        executionModel,
        degraded: result.degraded,
      });

      notifySlack("debate_completed", { taskName: this.task.name, taskDbId: this.task.id, rounds: result.rounds, duration });

      // Auto-approve if not requiring approval
      if (!config.get("debateRequireApproval")) {
        await updateDebateSession(this.sessionId, {
          state: "approved",
          approved_at: new Date().toISOString(),
        });

        // Auto-trigger execution
        const { execute } = await import("../execution-engine.js");
        const { getTaskById } = await import("../task-queue.js");
        const task = await getTaskById(this.task.id);
        execute(task).catch((err) => {
          logger.error({ taskId: this.task.id, err: err.message }, "Auto-execution after debate failed");
        });
      }

      return result;

    } catch (err) {
      const duration = Date.now() - start;
      logger.error({ sessionId: this.sessionId, err: err.message }, "Debate failed");

      await updateDebateSession(this.sessionId, {
        state: "failed",
        error_message: err.message,
        transcript: this.transcript,
        duration_ms: duration,
        completed_at: new Date().toISOString(),
      });

      this._emitEvent("debate:failed", { taskId: this.task.id, error: err.message });
      throw err;
    }
  }

  // ── Assigned Roles Pipeline ──────────────────────────────

  async _runAssignedRoles() {
    const activeParticipants = [...this.participants];
    let degraded = false;

    // Phase 1: Each participant (including leader) generates initial plan
    this._emitEvent("debate:round", { taskId: this.task.id, phase: "initial_plans", round: 0 });

    const leaderPlan = await this._callModel(
      this.leaderModel, "Leader",
      buildLeaderSystemPrompt(),
      this.taskContext,
      "initial_plan"
    );

    if (!leaderPlan) throw new Error("Leader model failed to produce initial plan");

    const participantPlans = await this._callParticipantsParallel(
      activeParticipants,
      (p) => buildRoleSystemPrompt(p.role),
      this.taskContext,
      "initial_plan"
    );

    // Remove failed participants
    for (let i = activeParticipants.length - 1; i >= 0; i--) {
      if (!participantPlans[i]) {
        logger.warn({ model: activeParticipants[i].model, role: activeParticipants[i].role }, "Participant failed, removing from debate");
        activeParticipants.splice(i, 1);
        participantPlans.splice(i, 1);
        degraded = true;
      }
    }

    if (activeParticipants.length < 1) {
      return { finalPlan: leaderPlan.content, rounds: 0, degraded: true };
    }

    // Phase 2: Critique rounds
    let currentPlan = leaderPlan.content;
    let rounds = 0;

    for (let round = 1; round <= this.maxRounds; round++) {
      this._emitEvent("debate:round", { taskId: this.task.id, phase: "critique", round });

      const critiques = await this._callParticipantsParallel(
        activeParticipants,
        (p) => buildRoleSystemPrompt(p.role),
        buildCritiquePrompt(currentPlan, "participant"),
        "critique"
      );

      const validCritiques = critiques
        .map((c, i) => c ? { role: activeParticipants[i].role, model: activeParticipants[i].model, content: c.content } : null)
        .filter(Boolean);

      if (validCritiques.length === 0) break;

      // Leader revises
      this._emitEvent("debate:round", { taskId: this.task.id, phase: "revision", round });

      const revision = await this._callModel(
        this.leaderModel, "Leader",
        buildLeaderSystemPrompt(),
        buildRevisionPrompt(currentPlan, validCritiques),
        "revision"
      );

      if (revision) {
        currentPlan = revision.content;
      }
      rounds = round;
    }

    return { finalPlan: currentPlan, rounds, degraded };
  }

  // ── Free Debate Pipeline ─────────────────────────────────

  async _runFreeDebate() {
    const activeParticipants = [...this.participants];
    let degraded = false;
    const allDiscussion = [];

    // Phase 1: Initial thoughts from all participants
    this._emitEvent("debate:round", { taskId: this.task.id, phase: "initial_thoughts", round: 0 });

    const initialThoughts = await this._callParticipantsParallel(
      activeParticipants,
      () => buildDebaterSystemPrompt(),
      this.taskContext,
      "initial_thought"
    );

    // Collect and remove failed
    for (let i = activeParticipants.length - 1; i >= 0; i--) {
      if (initialThoughts[i]) {
        allDiscussion.push({
          participant: activeParticipants[i].model,
          model: activeParticipants[i].model,
          content: initialThoughts[i].content,
          round: 0,
        });
      } else {
        activeParticipants.splice(i, 1);
        initialThoughts.splice(i, 1);
        degraded = true;
      }
    }

    if (activeParticipants.length < 1) {
      throw new Error("All participants failed in initial round");
    }

    // Phase 2: Debate rounds
    let rounds = 0;
    for (let round = 1; round <= this.maxRounds; round++) {
      this._emitEvent("debate:round", { taskId: this.task.id, phase: "debate", round });

      const previousRound = allDiscussion.filter((d) => d.round === round - 1);

      const responses = await this._callParticipantsParallel(
        activeParticipants,
        () => buildDebaterSystemPrompt(),
        buildDebateRoundPrompt(previousRound),
        "debate"
      );

      for (let i = 0; i < activeParticipants.length; i++) {
        if (responses[i]) {
          allDiscussion.push({
            participant: activeParticipants[i].model,
            model: activeParticipants[i].model,
            content: responses[i].content,
            round,
          });
        }
      }

      rounds = round;
    }

    // Phase 3: Leader synthesis
    this._emitEvent("debate:leader_deciding", { taskId: this.task.id });

    const synthesis = await this._callModel(
      this.leaderModel, "Leader",
      buildLeaderSystemPrompt(),
      buildLeaderSynthesisPrompt(allDiscussion),
      "synthesis"
    );

    if (!synthesis) {
      // Fallback: use the best participant response
      const bestResponse = allDiscussion[allDiscussion.length - 1]?.content || "No plan produced.";
      return { finalPlan: bestResponse, rounds, degraded: true };
    }

    return { finalPlan: synthesis.content, rounds, degraded };
  }

  // ── Model Communication ──────────────────────────────────

  async _callModel(modelSpec, participantName, systemPrompt, userMessage, phase) {
    try {
      this._emitEvent("debate:participant_response", {
        taskId: this.task.id,
        participant: participantName,
        model: modelSpec,
        phase,
        status: "calling",
      });

      const result = await providerRegistry.chat(modelSpec, [
        { role: "user", content: userMessage },
      ], {
        systemPrompt,
        temperature: this.temperature,
        maxTokens: this.maxTokens,
        timeout: this.timeout,
      });

      this.transcript.push({
        participant: participantName,
        model: modelSpec,
        role: participantName,
        content: result.content,
        phase,
        round: this._currentRound(),
        ts: new Date().toISOString(),
      });

      this._emitEvent("debate:participant_response", {
        taskId: this.task.id,
        participant: participantName,
        model: modelSpec,
        phase,
        status: "done",
        contentLength: result.content.length,
      });

      // Record cost from usage data if available
      if (config.get("costTrackingEnabled") && result.usage) {
        try {
          const promptTokens = result.usage.inputTokens || 0;
          const completionTokens = result.usage.outputTokens || 0;
          const totalTokens = promptTokens + completionTokens;
          // Rough cost estimation per token (adjust per model)
          const estimatedCost = totalTokens * 0.000015; // rough average
          await addTaskCost(this.task.id, {
            stepName: `debate_${phase}`,
            modelUsed: modelSpec,
            promptTokens, completionTokens, totalTokens, estimatedCost,
          });
          recordTokenUsage(modelSpec, `debate_${phase}`, totalTokens);
          recordCost(modelSpec, estimatedCost);
        } catch (_) { /* non-fatal */ }
      }

      return result;

    } catch (err) {
      logger.error({ model: modelSpec, participant: participantName, err: err.message }, "Model call failed");

      this.transcript.push({
        participant: participantName,
        model: modelSpec,
        role: participantName,
        content: `[ERROR: ${err.message}]`,
        phase,
        round: this._currentRound(),
        ts: new Date().toISOString(),
      });

      return null;
    }
  }

  async _callParticipantsParallel(participants, systemPromptFn, userMessage, phase) {
    return Promise.all(
      participants.map((p) =>
        this._callModel(p.model, p.role || p.model, systemPromptFn(p), userMessage, phase)
      )
    );
  }

  async _selectExecutionModel(plan) {
    try {
      const anthropicModels = await providerRegistry.getAnthropicModels();
      if (anthropicModels.length === 0) return null;

      const prompt = buildExecutionModelPrompt(this.task, plan, anthropicModels);
      const result = await providerRegistry.chat(this.leaderModel, [
        { role: "user", content: prompt },
      ], {
        temperature: 0,
        maxTokens: 100,
        timeout: this.timeout,
      });

      const selectedModel = result.content.trim().replace(/["`']/g, "");
      const validModel = anthropicModels.find((m) => m.id === selectedModel);

      if (validModel) {
        logger.info({ selectedModel, leader: this.leaderModel }, "Leader selected execution model");
        return selectedModel;
      }

      logger.warn({ selectedModel }, "Leader selected invalid model, falling back to default");
      return null;
    } catch (err) {
      logger.warn({ err: err.message }, "Execution model selection failed, using default");
      return null;
    }
  }

  _currentRound() {
    const rounds = this.transcript.map((t) => t.round).filter((r) => typeof r === "number");
    return rounds.length > 0 ? Math.max(...rounds) : 0;
  }

  _emitEvent(type, data) {
    metrics._emit(type, { ...data, ts: new Date().toISOString() });
  }
}
