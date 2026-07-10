// src/task-creator-api.js
// API routes for AI-powered ClickUp task creation.

import { Router } from "express";
import { requireRole } from "./rbac.js";
import { providerRegistry } from "./providers/provider-registry.js";
import { logger } from "./logger.js";
import { pool } from "./db.js";
import { getTaskDetails } from "./clickup-client.js";
import { handleTask } from "./claude-orchestrator.js";

const router = Router();
const guard = requireRole("DEVELOPER", "ADMIN");

const CLICKUP_BASE = "https://api.clickup.com/api/v2";
const GITHUB_API = "https://api.github.com";

// ── ClickUp fetch helper ────────────────────────────────────────
async function cuFetch(path) {
  const res = await fetch(`${CLICKUP_BASE}${path}`, {
    headers: {
      Authorization: process.env.CLICKUP_API_TOKEN,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ClickUp API ${res.status}: ${body}`);
  }
  return res.json();
}

async function cuPost(path, body) {
  const res = await fetch(`${CLICKUP_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: process.env.CLICKUP_API_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickUp API ${res.status}: ${text}`);
  }
  return res.json();
}

// ── GitHub fetch helper ─────────────────────────────────────────
async function ghFetch(path) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  return res.json();
}

// ── Build repo context (best-effort, all fetches wrapped in try/catch) ──
async function buildRepoContext(repoFullName) {
  let repoContext = "";
  if (!repoFullName) return repoContext;

  try {
    const [owner, repo] = repoFullName.split("/");
    const repoInfo = await ghFetch(`/repos/${owner}/${repo}`);
    const defaultBranch = repoInfo.default_branch || "main";
    repoContext += `\nRepository: ${repoFullName}`;
    if (repoInfo.description) repoContext += `\nDescription: ${repoInfo.description}`;
    if (repoInfo.default_branch) repoContext += `\nDefault branch: ${defaultBranch}`;
    if (repoInfo.language) repoContext += `\nPrimary language: ${repoInfo.language}`;

    // Languages
    try {
      const langs = await ghFetch(`/repos/${owner}/${repo}/languages`);
      if (Object.keys(langs).length > 0) {
        repoContext += `\nLanguages: ${Object.keys(langs).join(", ")}`;
      }
    } catch (_) {}

    // README content
    try {
      const readme = await ghFetch(`/repos/${owner}/${repo}/readme`);
      if (readme.content) {
        const decoded = Buffer.from(readme.content, "base64").toString("utf-8");
        const truncated = decoded.slice(0, 2000);
        repoContext += `\n\nREADME (first 2000 chars):\n${truncated}`;
      }
    } catch (_) {}

    // Directory structure
    try {
      const tree = await ghFetch(`/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`);
      if (tree.tree) {
        const entries = tree.tree.slice(0, 80);
        const lines = entries.map(e => `${e.type === "tree" ? "📁" : "  "} ${e.path}`);
        repoContext += `\n\nDirectory structure (${entries.length}/${tree.tree.length} entries):\n${lines.join("\n")}`;
      }
    } catch (_) {}

    // Build config / dependencies
    const buildFiles = ["package.json", "pom.xml", "build.gradle", "requirements.txt", "go.mod", "Cargo.toml"];
    for (const file of buildFiles) {
      try {
        const f = await ghFetch(`/repos/${owner}/${repo}/contents/${file}`);
        if (f.content) {
          const decoded = Buffer.from(f.content, "base64").toString("utf-8");
          repoContext += `\n\n${file}:\n${decoded.slice(0, 3000)}`;
          break; // Only include the first build config found
        }
      } catch (_) { continue; }
    }

    // Recent commits
    try {
      const commits = await ghFetch(`/repos/${owner}/${repo}/commits?per_page=10`);
      if (commits.length > 0) {
        const commitLines = commits.map(c =>
          `- ${c.sha.slice(0, 7)} ${c.commit.message.split("\n")[0]} (${c.commit.author?.name || "unknown"})`
        );
        repoContext += `\n\nRecent commits:\n${commitLines.join("\n")}`;
      }
    } catch (_) {}

    // .autoship config
    try {
      const configFile = await ghFetch(`/repos/${owner}/${repo}/contents/.autoship`);
      if (configFile.content) {
        const decoded = Buffer.from(configFile.content, "base64").toString("utf-8");
        repoContext += `\n\n.autoship config:\n${decoded}`;
      }
    } catch (_) {}
  } catch (err) {
    logger.warn({ err: err.message, repo: repoFullName }, "Failed to fetch repo context");
  }

  return repoContext;
}

// ── Parse LLM JSON response (handles markdown fences & surrounding prose) ──
function parseLLMJson(raw) {
  let text = raw;
  if (typeof text !== "string") text = JSON.stringify(text);
  // Strip markdown code fences
  text = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  // If the response doesn't start with '{', try to extract JSON object
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      text = text.slice(start, end + 1);
    }
  }
  return JSON.parse(text);
}

// ── GET /api/task-creator/spaces ────────────────────────────────
router.get("/api/task-creator/spaces", guard, async (req, res) => {
  try {
    const teamId = process.env.CLICKUP_WORKSPACE_ID;
    if (!teamId) return res.status(400).json({ error: "CLICKUP_WORKSPACE_ID not configured" });
    const data = await cuFetch(`/team/${teamId}/space`);
    res.json(data.spaces || []);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to fetch ClickUp spaces");
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/task-creator/spaces/:spaceId/folders ───────────────
router.get("/api/task-creator/spaces/:spaceId/folders", guard, async (req, res) => {
  try {
    const data = await cuFetch(`/space/${req.params.spaceId}/folder`);
    res.json(data.folders || []);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to fetch ClickUp folders");
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/task-creator/folders/:folderId/lists ───────────────
router.get("/api/task-creator/folders/:folderId/lists", guard, async (req, res) => {
  try {
    const data = await cuFetch(`/folder/${req.params.folderId}/list`);
    res.json(data.lists || []);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to fetch ClickUp lists");
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/task-creator/repos ─────────────────────────────────
router.get("/api/task-creator/repos", guard, async (req, res) => {
  try {
    const org = process.env.GITHUB_ORG;
    if (!org) return res.status(400).json({ error: "GITHUB_ORG not configured" });

    // Paginate through all org repos (GitHub API max 100 per page)
    const allRepos = [];
    let page = 1;
    while (true) {
      const batch = await ghFetch(`/orgs/${org}/repos?per_page=100&sort=updated&page=${page}`);
      allRepos.push(...batch);
      if (batch.length < 100) break;
      page++;
    }

    res.json(allRepos.map(r => ({ fullName: r.full_name, name: r.name, description: r.description, language: r.language })));
  } catch (err) {
    logger.error({ err: err.message }, "Failed to fetch GitHub repos");
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/task-creator/models ────────────────────────────────
router.get("/api/task-creator/models", guard, async (req, res) => {
  try {
    const models = await providerRegistry.listAllModels();
    res.json(models);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to list models");
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/task-creator/generate ─────────────────────────────
/**
 * Generate a structured task draft from a freeform prompt. Shared by the
 * dashboard task creator and Slack intake.
 */
export async function generateTaskDraft({ prompt, repoFullName, modelSpec }) {
  // Build repo context (best-effort)
  const repoContext = await buildRepoContext(repoFullName);

  const systemPrompt = `You are a technical project manager creating a ClickUp task from a user request.
Generate a well-structured task with:
- A clear, concise title (max 80 chars)
- A detailed markdown description with:
  - Summary section
  - Acceptance criteria (checkbox list)
  - Implementation hints / technical details
  - Any relevant context from the repository
- Relevant tags (lowercase, hyphenated, e.g. "backend", "bug-fix", "ui")
- Priority: 1 (urgent), 2 (high), 3 (normal), 4 (low)
- Estimated complexity: "simple", "moderate", or "complex"

${repoContext ? `\nRepository context:\n${repoContext}` : ""}

Respond ONLY with valid JSON in this exact format:
{
  "title": "...",
  "description": "...",
  "tags": ["..."],
  "priority": 3,
  "estimatedComplexity": "moderate"
}`;

  const messages = [{ role: "user", content: prompt }];
  const result = await providerRegistry.chat(modelSpec, messages, {
    systemPrompt,
    temperature: 0.3,
    maxTokens: 4000,
    timeout: 60000,
  });

  return parseLLMJson(result.content || result);
}

router.post("/api/task-creator/generate", guard, async (req, res) => {
  try {
    const { prompt, repoFullName, modelSpec } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt is required" });
    if (!modelSpec) return res.status(400).json({ error: "modelSpec is required" });

    const task = await generateTaskDraft({ prompt, repoFullName, modelSpec });
    res.json(task);
  } catch (err) {
    logger.error({ err: err.message }, "Task generation failed");
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/task-creator/refine ────────────────────────────────
router.post("/api/task-creator/refine", guard, async (req, res) => {
  try {
    const { currentTask, refinementPrompt, modelSpec, repoFullName, conversationHistory } = req.body;
    if (!currentTask) return res.status(400).json({ error: "currentTask is required" });
    if (!refinementPrompt) return res.status(400).json({ error: "refinementPrompt is required" });
    if (!modelSpec) return res.status(400).json({ error: "modelSpec is required" });

    // Build repo context (best-effort)
    const repoContext = await buildRepoContext(repoFullName);

    const systemPrompt = `You are a technical project manager refining a ClickUp task based on user feedback.

Current task state:
${JSON.stringify(currentTask, null, 2)}

${repoContext ? `\nRepository context:\n${repoContext}` : ""}

The user wants to refine this task. Apply their requested changes while preserving the overall structure.
Return the COMPLETE updated task (not just the changes).

Respond ONLY with valid JSON in this exact format:
{
  "title": "...",
  "description": "...",
  "tags": ["..."],
  "priority": 3,
  "estimatedComplexity": "moderate"
}`;

    // Build messages with conversation history for multi-turn context
    const messages = [];
    if (conversationHistory && Array.isArray(conversationHistory)) {
      for (const msg of conversationHistory) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
    messages.push({ role: "user", content: refinementPrompt });

    const result = await providerRegistry.chat(modelSpec, messages, {
      systemPrompt,
      temperature: 0.3,
      maxTokens: 4000,
      timeout: 60000,
    });

    const task = parseLLMJson(result.content || result);
    res.json(task);
  } catch (err) {
    logger.error({ err: err.message }, "Task refinement failed");
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/task-creator/members ────────────────────────────────
router.get("/api/task-creator/members", guard, async (req, res) => {
  try {
    const teamId = process.env.CLICKUP_WORKSPACE_ID;
    if (!teamId) return res.status(400).json({ error: "CLICKUP_WORKSPACE_ID not configured" });
    const data = await cuFetch(`/team/${teamId}`);
    const members = (data.members || (data.team && data.team.members) || []).map(m => {
      const u = m.user || m;
      const name = u.username || u.email || "";
      const initials = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
      return { id: u.id, username: u.username, email: u.email, initials, profilePicture: u.profilePicture || null };
    });
    res.json(members);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to fetch workspace members");
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/task-creator/my-clickup-id ─────────────────────────
router.get("/api/task-creator/my-clickup-id", guard, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT provider_user_id FROM user_integrations WHERE user_id = $1 AND provider = 'clickup'",
      [req.user.id]
    );
    res.json({ clickupUserId: rows[0]?.provider_user_id || null });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to fetch user ClickUp ID");
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/task-creator/stats ─────────────────────────────────
router.get("/api/task-creator/stats", guard, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        ae.value->>'id' AS clickup_user_id,
        ae.value->>'username' AS username,
        COUNT(*) AS task_count,
        COUNT(*) FILTER (WHERE t.state = 'running') AS running,
        COUNT(*) FILTER (WHERE t.state = 'success') AS completed,
        COUNT(*) FILTER (WHERE t.state = 'failed') AS failed,
        COUNT(*) FILTER (WHERE t.state = 'queued') AS queued
      FROM tasks t, jsonb_array_elements(t.assignees) ae(value)
      WHERE ae.value->>'id' IS NOT NULL
      GROUP BY ae.value->>'id', ae.value->>'username'
    `);
    res.json(rows.map(r => ({
      clickupUserId: r.clickup_user_id,
      username: r.username,
      taskCount: parseInt(r.task_count),
      running: parseInt(r.running),
      completed: parseInt(r.completed),
      failed: parseInt(r.failed),
      queued: parseInt(r.queued),
    })));
  } catch (err) {
    logger.error({ err: err.message }, "Failed to fetch task stats");
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/task-creator/create ───────────────────────────────
/**
 * Create a ClickUp task (with repo/Execution Mode custom fields and optional
 * immediate pipeline trigger). Shared by the dashboard and Slack intake.
 */
export async function createClickUpTask({ listId, title, description, tags, priority, repoFullName, assignees, triggerImplementation, source = "task_creator" }) {
  if (!listId || !title) throw new Error("listId and title are required");

  {
    const taskBody = {
      name: title,
      markdown_description: description || "",
      priority: priority || 3,
      tags: (tags || []).map(t => t.trim()).filter(Boolean),
    };

    // Set assignees if provided
    if (assignees && Array.isArray(assignees) && assignees.length > 0) {
      taskBody.assignees = assignees.map(Number);
    }

    const created = await cuPost(`/list/${listId}/task`, taskBody);

    // Best-effort: set repo custom field if it exists
    if (repoFullName && created.id) {
      try {
        const customFields = created.custom_fields || [];
        const repoField = customFields.find(
          f => f.name && f.name.toLowerCase() === "repo"
        );
        if (repoField) {
          let fieldValue = repoFullName;

          // Helper: match option name against full name ("org/repo") or short name ("repo")
          const repoShortName = repoFullName.includes("/") ? repoFullName.split("/").pop() : repoFullName;
          const matchesRepo = (optionName) => {
            const lower = (optionName || "").toLowerCase();
            return lower === repoFullName.toLowerCase() || lower === repoShortName.toLowerCase();
          };

          // Dropdown fields require the orderindex of the matching option, not the raw string
          if (repoField.type === "drop_down" && repoField.type_config?.options) {
            const matchedOption = repoField.type_config.options.find(o => matchesRepo(o.name));
            if (matchedOption) {
              fieldValue = matchedOption.orderindex;
            } else {
              logger.warn({ repoFullName, repoShortName, taskId: created.id }, "Repo option not found in dropdown; skipping field set");
              fieldValue = null;
            }
          }

          // Labels/multiselect fields require the option id
          if (repoField.type === "labels" && repoField.type_config?.options) {
            const matchedOption = repoField.type_config.options.find(o => matchesRepo(o.label || o.name));
            if (matchedOption) {
              fieldValue = [matchedOption.id];
            } else {
              logger.warn({ repoFullName, repoShortName, taskId: created.id }, "Repo option not found in labels field; skipping field set");
              fieldValue = null;
            }
          }

          if (fieldValue !== null) {
            await fetch(`${CLICKUP_BASE}/task/${created.id}/field/${repoField.id}`, {
              method: "POST",
              headers: {
                Authorization: process.env.CLICKUP_API_TOKEN,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ value: fieldValue }),
            });
            logger.info({ repoFullName, repoShortName, taskId: created.id }, "Repo custom field set successfully");
          }
        }
      } catch (err) {
        logger.warn({ err: err.message, taskId: created.id }, "Could not set repo custom field");
      }
    }

    // Best-effort: set Execution Mode custom field to 'autoship' only when trigger is enabled
    // When triggerImplementation is off, skip setting the field so the task won't auto-execute
    if (created.id && triggerImplementation) {
      try {
        const customFields = created.custom_fields || [];
        const execField = customFields.find(
          f => f.name && f.name.toLowerCase() === "execution mode"
        );
        if (execField && execField.type_config && execField.type_config.options) {
          const autoshipOption = execField.type_config.options.find(
            o => o.name && o.name.toLowerCase() === "autoship"
          );
          if (autoshipOption) {
            await fetch(`${CLICKUP_BASE}/task/${created.id}/field/${execField.id}`, {
              method: "POST",
              headers: {
                Authorization: process.env.CLICKUP_API_TOKEN,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ value: autoshipOption.orderindex }),
            });
            logger.info({ taskId: created.id }, "Execution Mode set to autoship");
          }
        }
      } catch (_) { /* ignore custom field errors */ }
    } else if (created.id && !triggerImplementation) {
      logger.info({ taskId: created.id }, "Execution Mode not set (trigger not enabled)");
    }

    // Trigger implementation pipeline if requested
    let implementationTriggered = false;
    if (triggerImplementation && created.id) {
      try {
        const fullTask = await getTaskDetails(created.id);
        await handleTask(fullTask, { source });
        implementationTriggered = true;
      } catch (implErr) {
        logger.error({ err: implErr.message, taskId: created.id }, "Implementation trigger failed");
      }
    }

    return { ok: true, taskId: created.id, url: created.url, implementationTriggered };
  }
}

router.post("/api/task-creator/create", guard, async (req, res) => {
  try {
    const { listId, title, description, tags, priority, repoFullName, assignees, triggerImplementation } = req.body;
    if (!listId || !title) return res.status(400).json({ error: "listId and title are required" });

    const result = await createClickUpTask({ listId, title, description, tags, priority, repoFullName, assignees, triggerImplementation });
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message }, "ClickUp task creation failed");
    res.status(500).json({ error: err.message });
  }
});

export { router as taskCreatorRouter };
