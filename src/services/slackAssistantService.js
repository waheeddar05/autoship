// src/services/slackAssistantService.js
// Slash-style AI assistant in Slack: "@AutoShip <anything>" gets classified
// into an intent and answered in-thread —
//   ask         → answers tech/codebase questions using the codebase index
//   debug       → root-causes a pasted stack trace / production incident
//   spec_review → reviews a spec/RFC/design doc pasted in the message
//   pr_review   → runs an AI review of a PR and posts it on GitHub
//   task        → falls through to the existing Slack task intake (build → PR)
// Threads are remembered (assistant_threads) so follow-up mentions in the
// same thread continue the conversation.

import { pool } from "../db.js";
import { logger } from "../logger.js";
import { config } from "../config-manager.js";
import { providerRegistry } from "../providers/provider-registry.js";
import { handleAppMention } from "./slackTaskIntakeService.js";
import { createClickUpTask } from "../task-creator-api.js";
import { reviewPullRequest } from "./prReviewService.js";
import { ensureRepoCloned } from "../execution-engine.js";
import { indexRepository, getRelevantContext, getIndexSummary } from "../codebase-index.js";
import { detectProjectType, generateContextPrompt } from "../project-context.js";
import { buildCodebaseGraph, findAffectedModules } from "./codebaseGraphService.js";
import { recordAssistantRequest, recordTokenUsage, recordCost } from "../prometheus.js";
import fs from "node:fs";
import path from "node:path";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const ASSISTANT_MODEL = process.env.ASSISTANT_MODEL || "anthropic:claude-sonnet-4-6";
const INTENT_MODEL = process.env.ASSISTANT_INTENT_MODEL || "anthropic:claude-haiku-4-5-20251001";
const ANSWER_TIMEOUT = 120_000;
const INTENT_TIMEOUT = 20_000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_FILE_CHARS = 4_000;
const MAX_CONTEXT_FILES = 3;
const MAX_ANSWER_CHARS = 12_000;

const INTENTS = ["ask", "debug", "spec_review", "pr_review", "task", "help"];

// ── Slack Web API helper (same pattern as slackTaskIntakeService) ──

async function slackApi(method, body) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`Slack ${method} failed: ${result.error}`);
  return result;
}

// ── Parsing helpers ─────────────────────────────────────────────

/** Extract a PR reference: a github.com/.../pull/N URL or owner/repo#N shorthand. */
export function extractPrReference(text) {
  const url = text.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  if (url) return { repoFullName: url[1], prNumber: parseInt(url[2], 10) };
  const shorthand = text.match(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/);
  if (shorthand) return { repoFullName: shorthand[1], prNumber: parseInt(shorthand[2], 10) };
  return null;
}

/** Extract an owner/repo reference (ignoring PR URLs' trailing paths). */
function extractRepo(text) {
  const url = text.match(/github\.com\/([\w.-]+\/[\w.-]+)/);
  if (url) return url[1];
  const full = text.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/);
  if (full && !full[1].includes("..")) return full[1];
  const tagged = text.match(/\brepo[:=]\s*([A-Za-z0-9_.-]+\/?[A-Za-z0-9_.-]*)\b/i);
  return tagged ? tagged[1] : null;
}

/** Does the text look like it contains a stack trace or crash log? */
export function looksLikeStackTrace(text) {
  return (
    /\n\s+at [\w.$<>[\]/ -]+[(:].*\d+/.test(text) || // JS/Java "at frame (file:line)"
    /Traceback \(most recent call last\)/.test(text) || // Python
    /^\s*File "[^"]+", line \d+/m.test(text) || // Python frames
    /Caused by: [\w.]+(Exception|Error)/.test(text) || // Java chained
    /(panic:|goroutine \d+ \[)/.test(text) || // Go
    /[\w.]+(Exception|Error): .+\n\s+at /.test(text) // generic exception + frame
  );
}

/**
 * Classify the mention into an intent. Deterministic rules first (free),
 * LLM fallback for ambiguous messages, defaulting to the pre-assistant
 * behavior (task intake) when everything else fails.
 */
export async function classifyIntent(text) {
  const trimmed = text.trim();

  if (/^(help|what can you do)\b/i.test(trimmed) && trimmed.length < 40) return "help";

  const prRef = extractPrReference(trimmed);
  if (prRef && /\breview\b/i.test(trimmed)) return "pr_review";

  if (looksLikeStackTrace(trimmed) || /^debug\b[:\s]/i.test(trimmed)) return "debug";

  if (/\breview\b.{0,30}\b(spec|rfc|design doc|prd|proposal|requirements?)\b/i.test(trimmed) ||
      /\b(spec|rfc|design doc|prd|proposal)\b.{0,30}\breview\b/i.test(trimmed) ||
      /^spec[:\s]/i.test(trimmed)) {
    return "spec_review";
  }

  if (/^(build|implement|add|create|fix|ship|make|write|refactor|update|change|remove|delete|rename|migrate|upgrade)\b/i.test(trimmed)) {
    return "task";
  }

  if (/\?/.test(trimmed) ||
      /^(how|what|where|why|when|who|which|can|could|does|do|is|are|explain|describe|show|tell|walk me)\b/i.test(trimmed)) {
    return "ask";
  }

  // Ambiguous — cheap LLM classification, falling back to intake behavior
  try {
    const response = await providerRegistry.chat(
      INTENT_MODEL,
      [{ role: "user", content: trimmed.slice(0, 2000) }],
      {
        systemPrompt: `Classify this Slack message to an engineering assistant into exactly one intent:
- "ask": a technical/codebase question seeking an answer
- "debug": reporting an error, incident, or crash to diagnose
- "spec_review": asking for feedback on a spec/design/document
- "pr_review": asking to review a pull request
- "task": asking to build/change something (create a work item)
Return ONLY a JSON object: {"intent": "<one of ask|debug|spec_review|pr_review|task>"}`,
        temperature: 0,
        maxTokens: 50,
        timeout: INTENT_TIMEOUT,
      }
    );
    const content = typeof response === "string" ? response : response.content || response.text || "";
    const match = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : content);
    if (INTENTS.includes(parsed.intent)) return parsed.intent;
  } catch (err) {
    logger.warn({ err: err.message }, "[ASSISTANT] Intent classification failed — defaulting to task intake");
  }
  return "task";
}

// ── Thread memory ───────────────────────────────────────────────

async function getThread(channel, threadTs) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM assistant_threads WHERE channel = $1 AND thread_ts = $2`,
      [channel, threadTs]
    );
    return rows[0] || null;
  } catch (err) {
    logger.warn({ err: err.message }, "[ASSISTANT] Thread lookup failed (non-fatal)");
    return null;
  }
}

async function saveThreadTurn(channel, threadTs, { repoFullName, intent, userMessage, assistantMessage }) {
  try {
    const existing = await getThread(channel, threadTs);
    const messages = Array.isArray(existing?.messages) ? existing.messages : [];
    messages.push({ role: "user", content: String(userMessage).slice(0, 4000) });
    if (assistantMessage) messages.push({ role: "assistant", content: String(assistantMessage).slice(0, 4000) });
    const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);

    await pool.query(
      `INSERT INTO assistant_threads (channel, thread_ts, repo_full_name, last_intent, messages)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel, thread_ts) DO UPDATE SET
         messages = $5,
         last_intent = $4,
         repo_full_name = COALESCE($3, assistant_threads.repo_full_name),
         updated_at = NOW()`,
      [channel, threadTs, repoFullName || null, intent, JSON.stringify(trimmed)]
    );
  } catch (err) {
    logger.warn({ err: err.message }, "[ASSISTANT] Thread save failed (non-fatal)");
  }
}

async function recordInteraction({ intent, channel, threadTs, requestedBy, repoFullName, requestText, responseText, modelUsed, usage, durationMs, error, suggestedTask }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO assistant_interactions
         (intent, channel, thread_ts, requested_by, repo_full_name, request_text, response_text,
          model_used, input_tokens, output_tokens, duration_ms, error, suggested_task)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        intent, channel, threadTs, requestedBy || null, repoFullName || null,
        String(requestText || "").slice(0, 4000), String(responseText || "").slice(0, 8000),
        modelUsed || null, usage?.inputTokens || 0, usage?.outputTokens || 0,
        durationMs || null, error ? String(error).slice(0, 1000) : null,
        suggestedTask ? JSON.stringify(suggestedTask) : null,
      ]
    );
    return rows[0].id;
  } catch (err) {
    logger.warn({ err: err.message }, "[ASSISTANT] Interaction record failed (non-fatal)");
    return null;
  }
}

// ── Repo context assembly ───────────────────────────────────────

/**
 * Build best-effort repo context for a question: project conventions +
 * CLAUDE.md, index-based relevant files, and the bodies of the top matches.
 * Every step is non-fatal — returns whatever could be gathered.
 */
async function buildAssistantRepoContext(repoFullName, question) {
  const blocks = [];
  let repoPath = null;
  let projectInfo = null;
  let index = null;

  try {
    repoPath = await ensureRepoCloned(repoFullName);
  } catch (err) {
    logger.warn({ repoFullName, err: err.message }, "[ASSISTANT] Repo clone failed — answering without repo context");
    return { blocks, repoPath: null, index: null, projectInfo: null };
  }

  try {
    projectInfo = detectProjectType(repoPath);
    const contextPrompt = generateContextPrompt(projectInfo, repoPath);
    if (contextPrompt) blocks.push(contextPrompt);
  } catch (err) {
    logger.warn({ repoFullName, err: err.message }, "[ASSISTANT] Project context failed (non-fatal)");
  }

  try {
    index = indexRepository(repoPath);
    if (index) {
      const summary = getIndexSummary(index);
      if (summary) blocks.push(summary);
      const maxTokens = config.get("assistantMaxContextTokens") || 6000;
      const relevant = getRelevantContext(index, question, maxTokens);
      if (relevant) blocks.push(relevant);

      // Read the top relevant files so answers cite real code, not just paths
      const fileMatches = [...relevant.matchAll(/\b([\w./-]+\.(?:js|ts|tsx|jsx|java|kt|py|go|rb|yml|yaml|properties|toml))\b/g)]
        .map((m) => m[1])
        .filter((f, i, arr) => arr.indexOf(f) === i)
        .slice(0, MAX_CONTEXT_FILES);
      for (const file of fileMatches) {
        try {
          const fullPath = path.join(repoPath, file);
          if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            const body = fs.readFileSync(fullPath, "utf8").slice(0, MAX_FILE_CHARS);
            blocks.push(`## File: ${file}\n\`\`\`\n${body}\n\`\`\``);
          }
        } catch (_) { /* skip unreadable files */ }
      }
    }
  } catch (err) {
    logger.warn({ repoFullName, err: err.message }, "[ASSISTANT] Codebase index failed (non-fatal)");
  }

  return { blocks, repoPath, index, projectInfo };
}

function resolveRepo(text, thread) {
  return extractRepo(text) || thread?.repo_full_name || config.get("assistantDefaultRepo") || null;
}

function buildMessages(history, currentContent) {
  const messages = [];
  for (const msg of Array.isArray(history) ? history : []) {
    if ((msg.role === "user" || msg.role === "assistant") && msg.content) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  // Anthropic requires the conversation to start with a user turn
  while (messages.length > 0 && messages[0].role !== "user") messages.shift();
  messages.push({ role: "user", content: currentContent });
  return messages;
}

const SLACK_STYLE = `Format the answer for Slack mrkdwn: *bold* for emphasis, _italics_, \`inline code\`, \`\`\`code blocks\`\`\`, and "•" bullets. Do NOT use markdown headers (#), tables, or [links](url) — use <url|text> for links. Be concise and concrete; cite file paths like \`src/auth.js\` when referencing code. If you are unsure, say so rather than guessing.`;

// ── Intent handlers ─────────────────────────────────────────────

async function answerQuestion({ text, thread }) {
  const repoFullName = resolveRepo(text, thread);
  const contextParts = [];

  if (repoFullName) {
    const { blocks } = await buildAssistantRepoContext(repoFullName, text);
    contextParts.push(...blocks);
  }

  const userContent = [
    ...contextParts,
    `## Question\n${text}`,
  ].join("\n\n---\n\n");

  const systemPrompt = `You are AutoShip's engineering assistant answering a teammate's question in Slack${repoFullName ? ` about the repository ${repoFullName}` : ""}. Answer from the provided codebase context when available; when the context doesn't cover the question, say what you'd need to look at. ${SLACK_STYLE}`;

  const response = await providerRegistry.chat(ASSISTANT_MODEL, buildMessages(thread?.messages, userContent), {
    systemPrompt,
    temperature: 0.2,
    maxTokens: 1500,
    timeout: ANSWER_TIMEOUT,
  });

  const answer = (typeof response === "string" ? response : response.content || response.text || "").trim();
  return { answer, usage: response?.usage, repoFullName };
}

async function debugIncident({ text, thread }) {
  const repoFullName = resolveRepo(text, thread);
  const contextParts = [];
  let blastRadius = [];

  if (repoFullName) {
    const { blocks, repoPath, projectInfo } = await buildAssistantRepoContext(repoFullName, text);
    contextParts.push(...blocks);

    // Blast radius: map stack-trace files to the dependency graph
    try {
      if (repoPath) {
        const graph = await buildCodebaseGraph(repoPath, projectInfo?.type || "unknown");
        const traceFiles = [...text.matchAll(/([\w./-]+\.(?:js|ts|tsx|jsx|java|kt|py|go|rb))/g)]
          .map((m) => m[1])
          .filter((f, i, arr) => arr.indexOf(f) === i)
          .slice(0, 5);
        for (const traceFile of traceFiles) {
          const base = path.basename(traceFile);
          const module = graph.modules.find((mod) => mod.file.endsWith(base));
          if (module) {
            const affected = findAffectedModules(graph, module.file).slice(0, 10);
            if (affected.length > 0) blastRadius.push({ file: module.file, affected });
          }
        }
        if (blastRadius.length > 0) {
          const lines = blastRadius.map((b) => `- ${b.file} is depended on by: ${b.affected.join(", ")}`);
          contextParts.push(`## Dependency blast radius (modules that depend on the crashing files)\n${lines.join("\n")}`);
        }
      }
    } catch (err) {
      logger.warn({ repoFullName, err: err.message }, "[ASSISTANT] Blast radius analysis failed (non-fatal)");
    }
  }

  const userContent = [
    ...contextParts,
    `## Incident / error report\n${text}`,
  ].join("\n\n---\n\n");

  const systemPrompt = `You are AutoShip's incident-debugging assistant${repoFullName ? ` for the repository ${repoFullName}` : ""}. A teammate pasted an error, stack trace, or incident description. Diagnose it against the provided codebase context.
Structure your Slack reply with these bold section labels:
*Root cause hypothesis* — the most likely cause, with confidence (high/medium/low)
*Evidence* — which frames/files/context support it
*Blast radius* — what else is affected
*Suggested fix* — concrete change to make
*Next steps* — how to confirm the diagnosis
${SLACK_STYLE}
After your reply, append a fenced JSON block with a fix task draft:
\`\`\`json
{"taskTitle": "<imperative fix title>", "taskDescription": "<what to change and why, with file references>"}
\`\`\``;

  const response = await providerRegistry.chat(ASSISTANT_MODEL, buildMessages(thread?.messages, userContent), {
    systemPrompt,
    temperature: 0.2,
    maxTokens: 2000,
    timeout: ANSWER_TIMEOUT,
  });

  let answer = (typeof response === "string" ? response : response.content || response.text || "").trim();

  // Pull the fix-task draft out of the visible reply
  let suggestedTask = null;
  const jsonMatch = answer.match(/```json\s*([\s\S]*?)```\s*$/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      if (parsed.taskTitle) {
        suggestedTask = {
          title: String(parsed.taskTitle).slice(0, 200),
          description: String(parsed.taskDescription || "").slice(0, 4000),
        };
      }
    } catch (_) { /* leave the block in place if unparseable */ }
    if (suggestedTask) answer = answer.slice(0, jsonMatch.index).trim();
  }

  return { answer, usage: response?.usage, repoFullName, suggestedTask };
}

async function reviewSpec({ text, thread }) {
  const systemPrompt = `You are a staff engineer reviewing a spec/design document a teammate posted in Slack. Give a rigorous but constructive review.
Structure your Slack reply with these bold section labels:
*Summary* — what the spec proposes, in 1-2 sentences
*Strengths* — what's well thought out
*Gaps & ambiguities* — unspecified behavior, unclear requirements
*Risks & edge cases* — failure modes, scaling/security/migration concerns
*Questions for the author* — the 3-5 most important things to clarify
*Verdict* — ready to build / needs another pass, and why
${SLACK_STYLE}`;

  const response = await providerRegistry.chat(ASSISTANT_MODEL, buildMessages(thread?.messages, `## Spec to review\n${text}`), {
    systemPrompt,
    temperature: 0.3,
    maxTokens: 1800,
    timeout: ANSWER_TIMEOUT,
  });

  const answer = (typeof response === "string" ? response : response.content || response.text || "").trim();
  return { answer, usage: response?.usage, repoFullName: null };
}

async function runPrReviewFromSlack({ text }) {
  const prRef = extractPrReference(text);
  if (!prRef) {
    return { answer: "I couldn't find a PR reference. Point me at one like `acme/webapp#123` or a GitHub PR URL.", repoFullName: null };
  }

  const result = await reviewPullRequest({
    repoFullName: prRef.repoFullName,
    prNumber: prRef.prNumber,
    triggerSource: "slack",
  });

  if (!result.ok) {
    return {
      answer: `❌ Couldn't review \`${prRef.repoFullName}#${prRef.prNumber}\`: ${result.error || result.reason || "unknown error"}`,
      repoFullName: prRef.repoFullName,
    };
  }

  const verdictLabel = { approve: "✅ Looks good", comment: "💬 Has comments", request_changes: "🛑 Changes recommended" }[result.verdict];
  const topIssues = (result.issues || []).slice(0, 5)
    .map((issue) => `• [${issue.severity}] \`${issue.file}\` — ${issue.description}`)
    .join("\n");

  const answer = [
    `*Review of \`${prRef.repoFullName}#${prRef.prNumber}\`${result.prTitle ? ` — ${result.prTitle}` : ""}*`,
    `${verdictLabel} · score ${result.score}/100`,
    "",
    result.summary,
    topIssues ? `\n*Top findings:*\n${topIssues}` : "\nNo significant issues found.",
    result.commentUrl ? `\n<${result.commentUrl}|Full review posted on the PR>` : "",
  ].filter(Boolean).join("\n");

  return { answer, repoFullName: prRef.repoFullName, usage: null };
}

const HELP_TEXT = [
  "*Hi! I'm AutoShip — your AI engineering assistant.* Mention me with:",
  "• *A question* — `@AutoShip how does auth work in acme/webapp?` → I read the codebase and answer",
  "• *An error or stack trace* — `@AutoShip debug: <paste trace>` → root cause + suggested fix (+ one-click fix task)",
  "• *A spec to review* — `@AutoShip review this spec: …` → structured design feedback",
  "• *A PR to review* — `@AutoShip review acme/webapp#123` → in-depth review posted on the PR",
  "• *Something to build* — `@AutoShip add rate limiting to acme/api` → task draft → I implement it and open a PR",
  "",
  "_Mention me again in a thread to continue the conversation — I remember the context._",
].join("\n");

// ── Entry points ────────────────────────────────────────────────

/**
 * Handle a Slack app_mention through the assistant. Routes "build me X"
 * requests to the existing task intake; everything else is answered inline.
 * Fire-and-forget from the endpoint — never throws.
 */
export async function handleAssistantMention(event) {
  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const requestedBy = event.user;
  const text = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
  const startedAt = Date.now();

  try {
    if (!text) {
      await slackApi("chat.postMessage", { channel, thread_ts: threadTs, text: HELP_TEXT }).catch(() => {});
      return;
    }

    const thread = await getThread(channel, threadTs);
    const intent = await classifyIntent(text);
    logger.info({ channel, user: requestedBy, intent }, `[ASSISTANT] Mention classified as "${intent}"`);

    if (intent === "help") {
      await slackApi("chat.postMessage", { channel, thread_ts: threadTs, text: HELP_TEXT });
      recordAssistantRequest("help", true);
      return;
    }

    if (intent === "task") {
      // Existing intake flow: draft → Create / Create & Run buttons → PR
      recordAssistantRequest("task", true);
      await handleAppMention(event);
      return;
    }

    // Post a placeholder we update with the real answer
    const placeholderLabels = {
      ask: "🤔 _Reading the codebase…_",
      debug: "🔎 _Digging into the incident…_",
      spec_review: "📋 _Reviewing the spec…_",
      pr_review: "🧐 _Reviewing the PR — this can take a minute…_",
    };
    let placeholderTs = null;
    try {
      const posted = await slackApi("chat.postMessage", { channel, thread_ts: threadTs, text: placeholderLabels[intent] || "🤔 _Working on it…_" });
      placeholderTs = posted.ts;
    } catch (err) {
      logger.warn({ err: err.message }, "[ASSISTANT] Placeholder post failed — will post answer as a new message");
    }

    const handlers = { ask: answerQuestion, debug: debugIncident, spec_review: reviewSpec, pr_review: runPrReviewFromSlack };
    const result = await handlers[intent]({ text, thread });

    let answer = (result.answer || "").slice(0, MAX_ANSWER_CHARS) || "_I couldn't produce an answer — try rephrasing?_";
    const durationMs = Date.now() - startedAt;

    const interactionId = await recordInteraction({
      intent, channel, threadTs, requestedBy,
      repoFullName: result.repoFullName,
      requestText: text, responseText: answer,
      modelUsed: ASSISTANT_MODEL, usage: result.usage, durationMs,
      suggestedTask: result.suggestedTask,
    });

    // Debug answers with a fix-task draft get a one-click "Create fix task" button
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: answer.slice(0, 3000) } }];
    if (answer.length > 3000) {
      for (let i = 3000; i < answer.length; i += 3000) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: answer.slice(i, i + 3000) } });
      }
    }
    if (intent === "debug" && result.suggestedTask && interactionId && config.get("slackIntakeListId")) {
      blocks.push({
        type: "actions",
        elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Create fix task" }, action_id: "assistant_create_task", value: String(interactionId) },
        ],
      });
    }

    if (placeholderTs) {
      await slackApi("chat.update", { channel, ts: placeholderTs, text: answer.slice(0, 3000), blocks });
    } else {
      await slackApi("chat.postMessage", { channel, thread_ts: threadTs, text: answer.slice(0, 3000), blocks });
    }

    await saveThreadTurn(channel, threadTs, { repoFullName: result.repoFullName, intent, userMessage: text, assistantMessage: answer });

    recordAssistantRequest(intent, true);
    if (result.usage) {
      const totalTokens = (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
      recordTokenUsage(ASSISTANT_MODEL, `assistant_${intent}`, totalTokens);
      recordCost(ASSISTANT_MODEL, totalTokens * 0.000009);
    }
    logger.info({ channel, intent, durationMs, repo: result.repoFullName }, "[ASSISTANT] ✅ Answered");
  } catch (err) {
    logger.error({ channel, err: err.message }, "[ASSISTANT] Mention handling failed");
    recordAssistantRequest("error", false);
    await recordInteraction({ intent: "error", channel, threadTs, requestedBy, requestText: text, error: err.message, durationMs: Date.now() - startedAt });
    await slackApi("chat.postMessage", {
      channel, thread_ts: threadTs,
      text: `❌ Something went wrong: ${err.message}`,
    }).catch(() => {});
  }
}

/**
 * Handle assistant Block Kit buttons (action_id prefix "assistant_").
 * Currently: assistant_create_task — turn a debug analysis into a ClickUp
 * fix task via the same path as Slack intake.
 */
export async function handleAssistantAction(actionId, value, userName, { channel, messageTs } = {}) {
  if (actionId !== "assistant_create_task") return;

  const interactionId = parseInt(value, 10);
  const { rows } = await pool.query(
    `SELECT * FROM assistant_interactions WHERE id = $1 AND suggested_task IS NOT NULL`,
    [interactionId]
  );
  const interaction = rows[0];

  const reply = (text) =>
    slackApi("chat.postMessage", { channel, thread_ts: interaction?.thread_ts || messageTs, text }).catch(() => {});

  if (!interaction) {
    await reply("⚠️ I couldn't find that analysis anymore.");
    return;
  }
  if (interaction.created_task_id) {
    await reply(`⚠️ A fix task was already created for this analysis.`);
    return;
  }

  const listId = config.get("slackIntakeListId");
  if (!listId) {
    await reply("⚙️ Set *Slack Intake List ID* in the AutoShip dashboard settings to create tasks from Slack.");
    return;
  }

  const suggested = typeof interaction.suggested_task === "string" ? JSON.parse(interaction.suggested_task) : interaction.suggested_task;

  try {
    const result = await createClickUpTask({
      listId: String(listId),
      title: suggested.title,
      description: suggested.description,
      tags: ["bug", "assistant"],
      priority: 2,
      repoFullName: interaction.repo_full_name,
      triggerImplementation: false,
      source: "slack_assistant",
    });

    await pool.query(`UPDATE assistant_interactions SET created_task_id = $2 WHERE id = $1`, [interactionId, result.taskId]);
    await reply(`✅ Fix task created by ${userName}: <${result.url}|${suggested.title}>`);
    logger.info({ interactionId, taskId: result.taskId }, "[ASSISTANT] Fix task created from debug analysis");
  } catch (err) {
    logger.error({ interactionId, err: err.message }, "[ASSISTANT] Fix task creation failed");
    await reply(`❌ Task creation failed: ${err.message}`);
  }
}
