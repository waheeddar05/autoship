# Handoff: Slash-style Slack AI Assistant → migrate to `sarasanalytics-com/autoship`

This document lets a fresh Claude Code session (or a human) port the complete
"Slash"-style AI assistant feature set from this repo (`waheeddar05/autoship`)
into `sarasanalytics-com/autoship`, **adapting to whatever already exists there**
rather than blindly overwriting.

## Why this exists

The feature work below was accidentally developed and merged into
`waheeddar05/autoship` (this repo). The intended target is
`sarasanalytics-com/autoship`, which has diverged and contains substantial
additional work. A remote-session restriction prevents the original session
from reading the org repo, so this kit packages everything needed to redo the
migration from a session started on the org repo.

## The feature set (from the original inspiration)

Razorpay's "Slash" internal AI assistant (tweet by @shashank_kr): an AI
assistant that lives in Slack and

1. **Answers tech/codebase questions** — reads the codebase and replies in-thread with file citations
2. **Debugs production incidents** — root-cause analysis from stack traces, blast radius, suggested fix
3. **Reviews specs/designs** — structured gap/risk/edge-case review
4. **Reviews every PR** — in-depth AI review posted automatically on each opened PR
5. **Writes code / raises PRs for small features** — build requests become tracked tasks that run through the existing ClickUp → Claude Code → PR pipeline
6. **Team-scoped** — only operates on repos belonging to the GitHub team `sarasanalytics-com/daton` (live-fetched allowlist, fail-closed)
7. **ClickUp tracking** — every assistant-driven build creates a ClickUp task via the existing *Create a Task* module, in a configurable list (`ASSISTANT_TASK_LIST_ID`, falls back to `SLACK_INTAKE_LIST_ID`)

## What was built (file inventory)

The complete diff is in `docs/migration/slash-assistant.patch`
(base commit `c323e0d`, head `98709bb` of `waheeddar05/autoship` main).

**New files (self-contained, portable as-is):**

| File | Purpose |
|---|---|
| `src/services/slackAssistantService.js` (~830 lines) | Core assistant: intent classification (ask/debug/spec_review/pr_review/task/help — deterministic rules then Haiku fallback), per-thread memory (`assistant_threads`), audit trail (`assistant_interactions`), dedicated read-only shallow clones for Q&A (`ASSISTANT_REPOS_DIR`), debug intent with one-click **Create fix task** button (atomic double-click-safe claim), repo scope enforcement, ClickUp task creation for build requests |
| `src/services/prReviewService.js` (~340 lines) | Review-every-PR: GitHub `pull_request` webhook → team-scope gate → dedupe per head SHA (partial unique index + `ON CONFLICT`) → diff fetch → LLM review JSON (verdict/score/issues/testing gaps) → PR comment. Also callable on demand from Slack (`review org/repo#123`) |
| `src/services/repoAllowlistService.js` (137 lines) | Team allowlist: paginated live fetch of `GET /orgs/{org}/teams/{team}/repos`, 10-min TTL cache, in-flight dedupe, stale-cache + static-list fallback, fail-closed. Exports `isRepoAllowed()`, `listAllowedRepos()`, `refreshAllowlist()`. Needs `GITHUB_TOKEN` with `read:org` |

**Edits to existing files (these are the integration points — adapt to the org repo's versions):**

| File | What was added |
|---|---|
| `src/server.js` | Slack `event_id` dedup map (5-min TTL); route `app_mention` → `handleAssistantMention` when `slackAssistantEnabled`, else legacy `handleAppMention`; `assistant_` action-id prefix branch in interactive handler; GitHub webhook branch for `pull_request` `opened/ready_for_review/synchronize` → `handlePrOpened`; startup allowlist warm-up |
| `src/db.js` | 3 migrations: `assistant_threads` (channel+thread_ts unique, repo, last_intent, messages JSONB), `assistant_interactions` (full audit incl. tokens/duration/suggested_task/created_task_id), `pr_agent_reviews` (verdict/score/issues/state + partial unique index `uq_pr_agent_reviews_active` on (repo, pr, head_sha) where trigger_source='webhook' and state in ('running','completed')) |
| `src/config-manager.js` | SCHEMA entries: `slackAssistantEnabled`, `assistantDefaultRepo`, `assistantMaxContextTokens`, `assistantTaskListId`, `assistantRepoScopeEnabled`, `assistantTeamOrg` (default `sarasanalytics-com`), `assistantTeamSlug` (default `daton`), `assistantAllowedReposStatic`, `reviewEveryPrEnabled`, `prReviewSkipDrafts`, `prReviewOnSync`, `prReviewPostComment` |
| `src/prometheus.js` | `recordAssistantRequest(intent, success)` and `recordPrAgentReview(success, verdict)` counters |
| `src/dashboard-api.js` | `GET /api/assistant/interactions`, `GET /api/pr-agent-reviews` (limit clamped ≤ 200) |
| `src/services/staleTaskCleanupService.js` | Sweep: `pr_agent_reviews` stuck in `running` > 10 min → `failed` |
| `.env.example`, `README.md` | All new knobs + docs |

**Dependencies the new code expects from the host repo** (verify equivalents exist in the org repo; adjust imports if names differ):

- `providerRegistry.chat(modelSpec, messages, opts)` → `{content, usage}` — LLM calls
- `config.get(key)` / config-manager SCHEMA pattern — feature flags
- `pool.query(...)` from `db.js` — raw Postgres
- Slack helpers in `server.js` (signature verification, `chat.postMessage`) — the assistant posts via the bot token
- Codebase-knowledge services: `indexRepository` / `getRelevantContext` (keyword RAG), `detectProjectType`, `buildCodebaseGraph` / `findAffectedModules` (blast radius) — used by ask/debug intents
- `task-creator-api.js` → `createClickUpTask({listId, ...})` — the *Create a Task* module used for tracked builds
- Slack task-intake service (`handleAppMention`) — build requests delegate to it after the scope gate

## Migration procedure (for the new session on the org repo)

1. **Survey first** — the org repo has diverged. Before applying anything, map
   its `src/` tree: does it already have a Slack assistant, PR-review
   automation, or a repo allowlist? Do the integration-point files above exist
   with the same names/APIs? Note any renames (e.g. different config-manager
   or provider-registry shape).
2. **Fetch this kit** — this repo is public:
   `git remote add donor https://github.com/waheeddar05/autoship && git fetch donor main`
   or grab raw files from
   `https://raw.githubusercontent.com/waheeddar05/autoship/main/...`.
3. **Apply** on a new branch (e.g. `claude/slack-assistant`):
   - Try `git apply --3way docs/migration/slash-assistant.patch` for the whole diff, **or**
   - Copy the 3 new service files verbatim (they're self-contained), then hand-port the 8 edited files' hunks into the org repo's versions — this is the safer route if those files diverged.
4. **Reconcile** anything the survey flagged (duplicate functionality, renamed helpers, existing migrations table numbering).
5. **Verify**: `node --check` each touched file, load the module graph, run the repo's tests if any.
6. **Push the branch and open a PR** against the org repo's default branch. Do not push to main directly.

## Configuration quick reference

```
SLACK_ASSISTANT_ENABLED=true
ASSISTANT_MODEL=anthropic:claude-sonnet-4-6
ASSISTANT_INTENT_MODEL=anthropic:claude-haiku-4-5-20251001
ASSISTANT_DEFAULT_REPO=            # repo for bare questions
ASSISTANT_TASK_LIST_ID=            # ClickUp list for assistant-created tasks
ASSISTANT_REPO_SCOPE_ENABLED=true
ASSISTANT_TEAM_ORG=sarasanalytics-com
ASSISTANT_TEAM_SLUG=daton
ASSISTANT_ALLOWED_REPOS_STATIC=    # fallback/extra repos
REVIEW_EVERY_PR_ENABLED=false      # opt-in
GITHUB_WEBHOOK_SECRET=             # REQUIRED for PR reviews (fails closed)
```

`GITHUB_TOKEN` needs `read:org` scope for the live team allowlist.

## Known hardening already baked in (don't re-fix)

14 adversarial-review findings were already fixed in the packaged code:
repo-reference hijack/path traversal, stale shared working tree (assistant
uses dedicated clones), create-task double-click race, duplicate webhook
review race, forged-webhook fail-closed, orphaned Slack placeholders, LLM
input caps, `line: null` coercion, stale `running` rows sweep, and more.
See commit `c45d0ef` in this repo for the full list.
