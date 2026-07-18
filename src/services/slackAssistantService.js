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
import { indexRepository, getRelevantContext, getIndexSummary } from "../codebase-index.js";
import { detectProjectType, generateContextPrompt } from "../project-context.js";
import { buildCodebaseGraph, findAffectedModules } from "./codebaseGraphService.js";
import { isRepoAllowed } from "./repoAllowlistService.js";
import { recordAssistantRequest, recordTokenUsage, recordCost } from "../prometheus.js";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const ASSISTANT_MODEL = process.env.ASSISTANT_MODEL || "anthropic:claude-sonnet-4-6";
const INTENT_MODEL = process.env.ASSISTANT_INTENT_MODEL || "anthropic:claude-haiku-4-5-20251001";
const ANSWER_TIMEOUT = 120_000;
const INTENT_TIMEOUT = 20_000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_FILE_CHARS = 4_000;
const MAX_CONTEXT_FILES = 3;
const MAX_ANSWER_CHARS = 12_000;
const MAX_INPUT_CHARS = 6_000; // cap on raw user text sent to the LLM

// Dedicated read-only clone dir — kept separate from the execution engine's
// REPOS_BASE_DIR so answering questions never races task executions that
// check out feature branches and edit files in place.
const REPOS_BASE_DIR = process.env.REPOS_BASE_DIR || "/app/repos";
const ASSISTANT_REPOS_DIR = process.env.ASSISTANT_REPOS_DIR || `${REPOS_BASE_DIR}-assistant`;

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

const FILE_EXT_RE = /\.(js|ts|tsx|jsx|mjs|cjs|java|kt|py|go|rb|rs|c|cc|cpp|h|hpp|cs|php|swift|scala|css|scss|less|html|json|ya?ml|toml|xml|sh|sql|md|txt|lock|properties)$/i;

/**
 * Validate an "owner/repo" reference. Rejects anything that could escape
 * REPOS_BASE_DIR (path traversal) or isn't a well-formed repo name.
 */
export function isValidRepoFullName(s) {
  if (!s || typeof s !== "string") return false;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return false;
  for (const seg of s.split("/")) {
    if (seg === "." || seg === ".." || seg.includes("..")) return false;
  }
  return true;
}

/**
 * Extract a PR reference: a github.com/.../pull/N URL or owner/repo#N
 * shorthand. Returns null unless the repo reference is well-formed.
 */
export function extractPrReference(text) {
  const url = text.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  if (url && isValidRepoFullName(url[1])) return { repoFullName: url[1], prNumber: parseInt(url[2], 10) };
  const shorthand = text.match(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/);
  if (shorthand && isValidRepoFullName(shorthand[1])) return { repoFullName: shorthand[1], prNumber: parseInt(shorthand[2], 10) };
  return null;
}

/**
 * Extract an EXPLICIT repo reference — a github.com URL or a `repo:` tag.
 * These are unambiguous user intent, so they're trusted (after validation).
 */
function extractExplicitRepo(text) {
  const url = text.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
  if (url) {
    const name = url[1].replace(/\.git$/, "");
    if (isValidRepoFullName(name)) return name;
  }
  const tagged = text.match(/\brepo[:=]\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/i);
  if (tagged && isValidRepoFullName(tagged[1])) return tagged[1];
  return null;
}

/**
 * Extract a BARE `owner/repo` token, rejecting file paths and trace frames
 * (e.g. "src/auth.js", "CI/CD", "24/7", "a/b/c"). Callers should confirm the
 * result is a known repo before trusting it — this is a candidate, not proof.
 */
function extractBareRepo(text) {
  const re = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const candidate = m[1];
    if (!isValidRepoFullName(candidate)) continue;
    const after = text.slice(re.lastIndex, re.lastIndex + 3);
    if (after.startsWith("/")) continue; // deeper path: a/b/c
    if (/^:\d/.test(after)) continue; // trace frame: file.js:12
    const repoSeg = candidate.split("/")[1];
    if (FILE_EXT_RE.test(repoSeg)) continue; // looks like a file
    return candidate;
  }
  return null;
}

/** Is this a repo AutoShip has seen before (a real, registered repo)? */
async function isKnownRepo(fullName) {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM tasks WHERE lower(repo_full_name) = lower($1) LIMIT 1`,
      [fullName]
    );
    return rows.length > 0;
  } catch (err) {
    logger.warn({ err: err.message }, "[ASSISTANT] Known-repo lookup failed (non-fatal)");
    return false;
  }
}

// ── Read-only repo clone (separate from the execution engine's clones) ──

async function git(args, cwd, timeout = 60_000) {
  return execFileP("git", args, {
    cwd,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/**
 * Ensure a fresh, read-only checkout of a repo's DEFAULT branch under
 * ASSISTANT_REPOS_DIR. Unlike ensureRepoCloned (which only fetches and is
 * shared with the mutating execution pipeline), this hard-resets to the
 * remote default branch so answers reflect current mainline code.
 */
async function ensureAssistantClone(repoFullName) {
  if (!isValidRepoFullName(repoFullName)) throw new Error(`Invalid repo reference: ${repoFullName}`);
  const repoName = repoFullName.split("/")[1];
  const repoPath = path.join(ASSISTANT_REPOS_DIR, repoName);
  const token = process.env.GITHUB_TOKEN;
  const cloneUrl = token
    ? `https://x-access-token:${token}@github.com/${repoFullName}.git`
    : `git@github.com:${repoFullName}.git`;

  if (!fs.existsSync(repoPath)) {
    fs.mkdirSync(ASSISTANT_REPOS_DIR, { recursive: true });
    await git(["clone", "--depth", "50", cloneUrl, repoName], ASSISTANT_REPOS_DIR, 120_000);
  } else if (token) {
    await git(["remote", "set-url", "origin", cloneUrl], repoPath).catch(() => {});
  }

  // Resolve the remote default branch (origin/HEAD), falling back to config.
  let defaultBranch = config.get("baseBranch") || "main";
  try {
    const { stdout } = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoPath);
    const branch = stdout.trim().replace(/^origin\//, "");
    if (branch) defaultBranch = branch;
  } catch {
    await git(["remote", "set-head", "origin", "-a"], repoPath).catch(() => {});
    try {
      const { stdout } = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoPath);
      const branch = stdout.trim().replace(/^origin\//, "");
      if (branch) defaultBranch = branch;
    } catch { /* keep config/main fallback */ }
  }

  await git(["fetch", "--depth", "50", "origin", defaultBranch], repoPath, 120_000).catch((err) => {
    logger.warn({ repoFullName, err: err.message }, "[ASSISTANT] Fetch failed (using cached checkout)");
  });
  await git(["checkout", "-B", defaultBranch, `origin/${defaultBranch}`], repoPath).catch(async () => {
    await git(["checkout", "-f", defaultBranch], repoPath).catch(() => {});
  });
  await git(["reset", "--hard", `origin/${defaultBranch}`], repoPath).catch(() => {});
  return repoPath;
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

  // Bare help request only — "help me fix X" is a real task, not the help card
  if (/^(help|what can you do|commands|usage)\s*[!?.]*$/i.test(trimmed)) return "help";

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
    repoPath = await ensureAssistantClone(repoFullName);
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

/**
 * Resolve which repo a mention is about. Explicit signals (github.com URL,
 * `repo:` tag) are trusted; a bare owner/repo token is only used if it's a
 * repo AutoShip already knows — otherwise we fall back to the thread's repo
 * or the configured default. This prevents file paths / stack-trace frames
 * (e.g. "src/auth.js") from hijacking repo resolution.
 */
async function resolveRepo(text, thread) {
  const explicit = extractExplicitRepo(text);
  if (explicit) return { repoFullName: explicit, explicit: true };
  const bare = extractBareRepo(text);
  if (bare && (await isKnownRepo(bare))) return { repoFullName: bare, explicit: true };
  return { repoFullName: thread?.repo_full_name || config.get("assistantDefaultRepo") || null, explicit: false };
}

/** A Slack-ready message explaining why a repo is out of scope. */
function scopeDenialMessage(scope, repoFullName) {
  const team = `${config.get("assistantTeamOrg")}/${config.get("assistantTeamSlug")}`;
  if (scope.reason === "list_unavailable") {
    return `⚠️ I couldn't load the *${team}* team's repo list${scope.error ? ` (${scope.error})` : ""}. Ask an admin to confirm the GitHub token has \`read:org\` scope and can see the team.`;
  }
  const sample = (scope.sample || []).length
    ? `\nRepos I can work with include: ${scope.sample.map((r) => `\`${r}\``).join(", ")}${scope.sample.length >= 10 ? " …" : ""}`
    : "";
  return `🔒 I can only work with repositories in the *${team}* team, so I can't touch \`${repoFullName}\`.${sample}`;
}

/**
 * Resolve the repo for a Q&A/debug turn AND enforce team scope.
 * Returns { repoFullName, denial }. If the user *explicitly* named an
 * out-of-team repo, `denial` is a message and `repoFullName` is null (hard
 * block). If the repo only came from the thread/default and isn't allowed,
 * we silently drop context (repoFullName null, no denial).
 */
async function resolveScopedRepo(text, thread) {
  const { repoFullName, explicit } = await resolveRepo(text, thread);
  if (!repoFullName) return { repoFullName: null, denial: null };
  const scope = await isRepoAllowed(repoFullName);
  if (scope.allowed) return { repoFullName, denial: null };
  return { repoFullName: null, denial: explicit ? scopeDenialMessage(scope, repoFullName) : null };
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
  const { repoFullName, denial } = await resolveScopedRepo(text, thread);
  if (denial) return { answer: denial, repoFullName: null, blocked: true, modelUsed: ASSISTANT_MODEL };
  const question = text.slice(0, MAX_INPUT_CHARS);
  const contextParts = [];

  if (repoFullName) {
    const { blocks } = await buildAssistantRepoContext(repoFullName, question);
    contextParts.push(...blocks);
  }

  const userContent = [
    ...contextParts,
    `## Question\n${question}`,
  ].join("\n\n---\n\n");

  const systemPrompt = `You are AutoShip's engineering assistant answering a teammate's question in Slack${repoFullName ? ` about the repository ${repoFullName}` : ""}. Answer from the provided codebase context when available; when the context doesn't cover the question, say what you'd need to look at. ${SLACK_STYLE}`;

  const response = await providerRegistry.chat(ASSISTANT_MODEL, buildMessages(thread?.messages, userContent), {
    systemPrompt,
    temperature: 0.2,
    maxTokens: 1500,
    timeout: ANSWER_TIMEOUT,
  });

  const answer = (typeof response === "string" ? response : response.content || response.text || "").trim();
  return { answer, usage: response?.usage, repoFullName, modelUsed: ASSISTANT_MODEL };
}

async function debugIncident({ text, thread }) {
  const { repoFullName, denial } = await resolveScopedRepo(text, thread);
  if (denial) return { answer: denial, repoFullName: null, blocked: true, modelUsed: ASSISTANT_MODEL };
  const incident = text.slice(0, MAX_INPUT_CHARS);
  const contextParts = [];
  let blastRadius = [];

  if (repoFullName) {
    const { blocks, repoPath, projectInfo } = await buildAssistantRepoContext(repoFullName, incident);
    contextParts.push(...blocks);

    // Blast radius: map stack-trace files to the dependency graph
    try {
      if (repoPath) {
        const graph = await buildCodebaseGraph(repoPath, projectInfo?.type || "unknown");
        const traceFiles = [...incident.matchAll(/([\w./-]+\.(?:js|ts|tsx|jsx|java|kt|py|go|rb))/g)]
          .map((m) => m[1])
          .filter((f, i, arr) => arr.indexOf(f) === i)
          .slice(0, 5);
        for (const traceFile of traceFiles) {
          const base = path.basename(traceFile);
          // Exact-basename match with a path boundary — avoids "auth.js"
          // wrongly matching "oauth.js"
          const module = graph.modules.find((mod) => path.basename(mod.file) === base);
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
    `## Incident / error report\n${incident}`,
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

  return { answer, usage: response?.usage, repoFullName, suggestedTask, modelUsed: ASSISTANT_MODEL };
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

  const response = await providerRegistry.chat(ASSISTANT_MODEL, buildMessages(thread?.messages, `## Spec to review\n${text.slice(0, MAX_INPUT_CHARS)}`), {
    systemPrompt,
    temperature: 0.3,
    maxTokens: 1800,
    timeout: ANSWER_TIMEOUT,
  });

  const answer = (typeof response === "string" ? response : response.content || response.text || "").trim();
  return { answer, usage: response?.usage, repoFullName: null, modelUsed: ASSISTANT_MODEL };
}

async function runPrReviewFromSlack({ text }) {
  const prRef = extractPrReference(text);
  if (!prRef) {
    return { answer: "I couldn't find a PR reference. Point me at one like `acme/webapp#123` or a GitHub PR URL.", repoFullName: null };
  }

  // Team scope: only review PRs on the team's repos
  const scope = await isRepoAllowed(prRef.repoFullName);
  if (!scope.allowed) {
    return { answer: scopeDenialMessage(scope, prRef.repoFullName), repoFullName: null, blocked: true };
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
      modelUsed: result.modelUsed,
      usage: result.usage,
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

  return { answer, repoFullName: prRef.repoFullName, usage: result.usage, modelUsed: result.modelUsed };
}

const HELP_TEXT = [
  "*Hi! I'm AutoShip — your AI engineering assistant.* Mention me with:",
  "• *A question* — `@AutoShip how does auth work in acme/webapp?` → I read the codebase and answer",
  "• *An error or stack trace* — `@AutoShip debug: <paste trace>` → root cause + suggested fix (+ one-click fix task)",
  "• *A spec to review* — `@AutoShip review this spec: …` → structured design feedback",
  "• *A PR to review* — `@AutoShip review acme/webapp#123` → in-depth review posted on the PR",
  "• *Something to build* — `@AutoShip add rate limiting to acme/api` → task draft → a ClickUp task is created to track it → I implement it and open a PR",
  "",
  "_I work only with your team's repositories, and every build I take on is tracked as a ClickUp task._",
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
  let placeholderTs = null;

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
      // Team scope: block implement requests that name an out-of-team repo
      const referenced = extractExplicitRepo(text) || extractBareRepo(text);
      if (referenced) {
        const scope = await isRepoAllowed(referenced);
        if (!scope.allowed) {
          await slackApi("chat.postMessage", { channel, thread_ts: threadTs, text: scopeDenialMessage(scope, referenced) }).catch(() => {});
          recordAssistantRequest("task", false);
          return;
        }
      }
      // Existing intake flow: draft → Create / Create & Run buttons → ClickUp
      // task (in the configured folder) → PR. Count success only after intake
      // actually completes.
      await handleAppMention(event);
      recordAssistantRequest("task", true);
      return;
    }

    // Post a placeholder we update with the real answer
    const placeholderLabels = {
      ask: "🤔 _Reading the codebase…_",
      debug: "🔎 _Digging into the incident…_",
      spec_review: "📋 _Reviewing the spec…_",
      pr_review: "🧐 _Reviewing the PR — this can take a minute…_",
    };
    try {
      const posted = await slackApi("chat.postMessage", { channel, thread_ts: threadTs, text: placeholderLabels[intent] || "🤔 _Working on it…_" });
      placeholderTs = posted.ts;
    } catch (err) {
      logger.warn({ err: err.message }, "[ASSISTANT] Placeholder post failed — will post answer as a new message");
    }

    const handlers = { ask: answerQuestion, debug: debugIncident, spec_review: reviewSpec, pr_review: runPrReviewFromSlack };
    const result = await handlers[intent]({ text, thread });
    const modelUsed = result.modelUsed || ASSISTANT_MODEL;

    let answer = (result.answer || "").slice(0, MAX_ANSWER_CHARS) || "_I couldn't produce an answer — try rephrasing?_";
    const durationMs = Date.now() - startedAt;

    const interactionId = await recordInteraction({
      intent, channel, threadTs, requestedBy,
      repoFullName: result.repoFullName,
      requestText: text, responseText: answer,
      modelUsed, usage: result.usage, durationMs,
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
      recordTokenUsage(modelUsed, `assistant_${intent}`, totalTokens);
      recordCost(modelUsed, totalTokens * 0.000009);
    }
    logger.info({ channel, intent, durationMs, repo: result.repoFullName }, "[ASSISTANT] ✅ Answered");
  } catch (err) {
    logger.error({ channel, err: err.message }, "[ASSISTANT] Mention handling failed");
    recordAssistantRequest("error", false);
    await recordInteraction({ intent: "error", channel, threadTs, requestedBy, requestText: text, error: err.message, durationMs: Date.now() - startedAt });
    const errorText = `❌ Something went wrong: ${err.message}`;
    // Replace the "…working…" placeholder rather than orphaning it
    if (placeholderTs) {
      await slackApi("chat.update", { channel, ts: placeholderTs, text: errorText, blocks: [{ type: "section", text: { type: "mrkdwn", text: errorText } }] }).catch(() => {});
    } else {
      await slackApi("chat.postMessage", { channel, thread_ts: threadTs, text: errorText }).catch(() => {});
    }
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
  const reply = (text, threadTs) =>
    slackApi("chat.postMessage", { channel, thread_ts: threadTs || messageTs, text }).catch(() => {});

  // Assistant tasks land in the configured tracking folder's list
  // (Create a Task module), falling back to the Slack intake list.
  const listId = config.get("assistantTaskListId") || config.get("slackIntakeListId");
  if (!listId) {
    await reply("⚙️ Set *Assistant Task List ID* (or *Slack Intake List ID*) in the AutoShip dashboard settings to create tasks from Slack.");
    return;
  }

  // Atomically claim the interaction so a double-click can't create two tasks:
  // only one concurrent handler flips created_task_id from NULL to '__pending__'.
  let interaction;
  try {
    const claim = await pool.query(
      `UPDATE assistant_interactions SET created_task_id = '__pending__'
       WHERE id = $1 AND suggested_task IS NOT NULL AND created_task_id IS NULL
       RETURNING *`,
      [interactionId]
    );
    interaction = claim.rows[0];
  } catch (err) {
    logger.error({ interactionId, err: err.message }, "[ASSISTANT] Fix-task claim failed");
    await reply(`❌ Couldn't create the fix task right now: ${err.message}`);
    return;
  }

  if (!interaction) {
    await reply("⚠️ That analysis is unavailable or a fix task was already created for it.");
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
    await reply(`✅ Fix task created by ${userName}: <${result.url}|${suggested.title}>`, interaction.thread_ts);
    logger.info({ interactionId, taskId: result.taskId }, "[ASSISTANT] Fix task created from debug analysis");
  } catch (err) {
    // Release the claim so the user can retry
    await pool.query(`UPDATE assistant_interactions SET created_task_id = NULL WHERE id = $1`, [interactionId]).catch(() => {});
    logger.error({ interactionId, err: err.message }, "[ASSISTANT] Fix task creation failed");
    await reply(`❌ Task creation failed: ${err.message}`, interaction.thread_ts);
  }
}
