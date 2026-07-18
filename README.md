# AutoShip — ClickUp → Claude Code → GitHub PR Automation

Automatically triggers Claude Code when a new ClickUp task is created in your configured folder and assigned to you. Claude implements the task, pushes changes, and creates a PR targeting `dev`.

## Flow

```
ClickUp (new task created in configured folder)
  → Webhook / Poller detects new task
    → Reads "repo" custom field from the ticket
    → Clones/pulls the repo locally
    → Creates branch from `dev`: auto/<task-id>-<slug>
    → Spawns Claude Code CLI
      → Claude reads codebase, implements full flow, writes tests
    → Git: commit → push
    → GitHub: creates PR targeting `dev`
      → PR title: #<ticketid>:<task name>
    → ClickUp: posts PR link as comment on the task
```

## Slack AI Assistant

Beyond building tasks, AutoShip is a full AI engineering assistant in Slack
(à la Razorpay's "Slash"). Mention the bot with anything:

| You say | It does |
|---|---|
| `@AutoShip how does auth work in acme/webapp?` | Clones/refreshes the repo, reads the codebase index + relevant files, answers in-thread with file citations |
| `@AutoShip debug: <stack trace or incident>` | Root-cause analysis against the code, dependency blast radius, suggested fix, and a one-click **Create fix task** button |
| `@AutoShip review this spec: …` | Structured design review — gaps, risks, edge cases, questions for the author |
| `@AutoShip review acme/webapp#123` | Runs an in-depth AI review and posts it on the PR |
| `@AutoShip add rate limiting to acme/api` | Existing task intake: draft → Create & Run → implementation → PR |
| `@AutoShip help` | Capability card |

Mention the bot again in the same thread to continue the conversation — it
remembers context per thread (`assistant_threads`). Every interaction is
audited in `assistant_interactions` and exposed at `GET /api/assistant/interactions`.

Enable with `SLACK_ASSISTANT_ENABLED=true` (default on when Slack is
configured). Set `ASSISTANT_DEFAULT_REPO` so bare questions have a codebase
to answer from.

### Team repo scope

The assistant is scoped to a single GitHub **team's** repositories: it only
answers questions, debugs, reviews, or implements for repos that belong to the
configured team, and hard-rejects any Slack request naming a repo outside it.
The team's repos are fetched live from the GitHub API and cached (10 min by
default), so the allowlist automatically tracks repos added to or removed from
the team — e.g.
`https://github.com/orgs/sarasanalytics-com/teams/daton/repositories`.

- `ASSISTANT_REPO_SCOPE_ENABLED=true` (default) — turn scoping on/off
- `ASSISTANT_TEAM_ORG` / `ASSISTANT_TEAM_SLUG` — the team (default `sarasanalytics-com` / `daton`)
- `ASSISTANT_ALLOWED_REPOS_STATIC` — extra always-allowed repos, and a fallback if `read:org` isn't available
- Requires `GITHUB_TOKEN` to have **`read:org`** scope and visibility into the team. If the list can't be loaded and nothing is cached, requests are denied (fail-closed) with a clear message.

### Tracking every build in ClickUp

When you ask the assistant to build something, it creates a **ClickUp task**
(via the same *Create a Task* module the dashboard uses) in your tracking
folder, so all assistant-driven work is trackable. Point it at a specific list
with `ASSISTANT_TASK_LIST_ID` (defaults to `SLACK_INTAKE_LIST_ID`). Debug
analyses also offer a one-click **Create fix task** button into the same list.

## Review Every PR

With `REVIEW_EVERY_PR_ENABLED=true`, every PR opened in a webhook-registered
repo (including human-authored PRs) gets an in-depth AI review posted as a PR
comment: verdict, 0–100 score, issues grouped by severity, and testing gaps.
Reviews are deduped per head commit, skip drafts and bot authors by default,
and are stored in `pr_agent_reviews` (`GET /api/pr-agent-reviews`). You can
also trigger one on demand from Slack (`@AutoShip review org/repo#123`).

## Prerequisites

- **Node.js 20+**
- **Claude Code CLI**: `npm install -g @anthropic-ai/claude-code`
  - Must be authenticated (run `claude` once to set up)
- **GitHub CLI**: `brew install gh`
  - Must be authenticated: `gh auth login`
- **ClickUp API token**: Settings → Apps → API Token
- Target repos cloned locally under `REPOS_BASE_DIR`

## Setup

### 1. Install dependencies

```bash
cd clickup-claude-automation
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your actual values (API token, GitHub token, etc.)
```

### 3. ClickUp ticket requirements

Each ticket in your configured ClickUp folder must have:
- A **"repo"** custom field (text type) containing the GitHub repository name
  - Examples: `pipelines`, `insights-service`, `your-org/pipelines`
- Be assigned to the configured user (set `CLICKUP_MY_USER_ID` in `.env`)
- Be in one of the configured trigger statuses (see `TRIGGER_STATUSES` in `.env`)

### 4. Start the automation

```bash
# Poller mode (recommended — no public URL needed)
npm run start:poller

# Or full mode with webhook + poller
npm start
```

### 5. Test with a real task

```bash
node src/test-trigger.js <clickup-task-id>
```

## How it works

### Repo resolution (via "repo" custom field)

Instead of hardcoded folder-to-repo mappings, each ticket declares its own repo:

| Custom field value | Resolved to |
|---|---|
| `pipelines` | `your-org/pipelines` |
| `your-org/insights-service` | `your-org/insights-service` |
| `https://github.com/org/repo` | `org/repo` |

The repo is cloned/pulled to `$REPOS_BASE_DIR/<repo-name>`.

### Branch and PR conventions

- **Base branch**: `dev`
- **Feature branch**: `auto/<task-id>-<slugified-task-name>`
- **PR title**: `#<ticketid>:<task name>`
- **Model**: Configurable (default: `claude-opus-4-6`)

### Modes

| Mode | Command | Description |
|------|---------|-------------|
| `poller` | `npm run start:poller` | Polls ClickUp every 2 min. No public URL needed. |
| `webhook` | `npm run start:webhook` | Listens for ClickUp webhook events (needs ngrok/public URL). |
| `both` | `npm start` | Runs both poller and webhook server. |

### Escape Hatches

- **Skip automation**: Add a `no-auto` or `manual` tag to the task
- **Re-trigger**: Remove the task ID from `.processed-tasks.json` and restart
- **Timeout**: Claude Code has a 15-minute timeout per task

## Folder Structure

```
clickup-claude-automation/
├── src/
│   ├── server.js                # Dual-mode: webhook + poller
│   ├── poller.js                # Polls configured ClickUp list for new tasks
│   ├── clickup-client.js        # ClickUp API client
│   ├── claude-orchestrator.js   # Core: repo resolve → git → Claude Code → PR
│   ├── logger.js                # Structured logging (pino)
│   ├── register-webhook.js      # One-time webhook registration
│   └── test-trigger.js          # Direct pipeline test
├── .env
├── .env.example
├── .processed-tasks.json        # Tracks already-processed task IDs
├── package.json
└── README.md
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "No repo custom field found" | Add a text custom field named "repo" to the task with the repo name |
| Claude Code auth error | Run `claude` in terminal to re-authenticate |
| Git push fails | Check `gh auth status` and SSH keys |
| No changes produced | Task may be too vague — add more detail to the description |
| Task not picked up | Check status is "to do"/"open" and assigned to you |
| Re-process a task | Remove its ID from `.processed-tasks.json` |
