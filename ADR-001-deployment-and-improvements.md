# ADR-001: Deployment Strategy & Architecture Improvements for ClickUp-Claude Automation

**Status:** Proposed
**Date:** 2026-02-27
**Deciders:** Waheed

---

## Context

The `clickup-claude-automation` system automates the developer workflow: ClickUp ticket → Claude Code (Opus 4.6) → GitHub PR targeting `dev`. Currently running as a local Node.js process on Waheed's Mac with:

- Express server (port 3457) handling webhooks + polling
- PostgreSQL for task state machine (tasks, execution_logs, task_messages, pr_reviews)
- Claude Code CLI spawned as child process per task
- `gh` CLI for PR creation
- Git operations via `child_process.spawn`
- Dashboard UI (vanilla JS + SSE) for monitoring/approval

**The problem:** This runs locally — tied to one laptop, no HA, no team access, repos cloned to local disk. We need to deploy to a dev server first, then eventually QA → prod.

**Reference architecture:** The `source-service` repo (Java/Spring Boot) is already deployed to the same infrastructure, so we'll mirror its deployment patterns (Docker + reverse proxy + env-based config).

---

## Part 1: Deployment Strategy — Local → Dev Server

### What Needs to Change for Server Deployment

| Concern | Local (Current) | Dev Server (Target) |
|---------|----------------|---------------------|
| **Claude Code CLI** | Installed globally, authenticated via interactive login | Docker container with `ANTHROPIC_API_KEY` env var |
| **gh CLI** | Authenticated via `gh auth login` | `GITHUB_TOKEN` env var (already supported) |
| **Git** | SSH keys on Mac | Deploy key or PAT-based HTTPS clone |
| **Repos directory** | `/path/to/local/repos` | Docker volume `/app/repos` |
| **PostgreSQL** | Docker container on Mac | Dedicated PostgreSQL instance or Docker service |
| **Webhook URL** | ngrok / localhost | Real domain with reverse proxy (nginx) |
| **Process management** | `node src/server.js` | Docker container with health checks + restart policy |
| **Secrets** | `.env` file | Docker secrets / env injection / Vault |
| **Logs** | stdout (pino) | Centralized logging (stdout → Docker → log driver) |
| **Dashboard** | `localhost:3457` | Reverse-proxied with auth |

### Deployment Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Dev Server (VM)                          │
│                                                              │
│  ┌──────────────┐     ┌─────────────────────────────────┐   │
│  │   nginx       │────▶│  clickup-automation (Docker)     │   │
│  │  (reverse     │     │  ├─ Express server (:3457)       │   │
│  │   proxy +     │     │  ├─ Poller (ClickUp API)         │   │
│  │   SSL/TLS)    │     │  ├─ Webhook handler              │   │
│  └──────────────┘     │  ├─ Dashboard API + SSE           │   │
│         ▲              │  ├─ Execution engine              │   │
│         │              │  │   ├─ git (installed in image)  │   │
│         │              │  │   ├─ gh CLI (in image)         │   │
│         │              │  │   └─ claude CLI (in image)     │   │
│  HTTPS from            │  └─ /app/repos (volume mount)     │   │
│  ClickUp webhooks      └─────────────┬───────────────────┘   │
│  & GitHub webhooks                    │                       │
│                              ┌────────▼──────────┐           │
│                              │  PostgreSQL        │           │
│                              │  (Docker service   │           │
│                              │   or managed DB)   │           │
│                              └───────────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

### Docker Setup

#### Dockerfile

```dockerfile
FROM node:20-slim

# System dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# App setup
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY public/ ./public/

# Repos volume
RUN mkdir -p /app/repos
VOLUME ["/app/repos"]

# Git config (for commits)
RUN git config --global user.name "ClickUp Automation" \
    && git config --global user.email "automation@example.com"

EXPOSE 3457

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:3457/health || exit 1

CMD ["node", "src/server.js"]
```

#### docker-compose.yml

```yaml
version: "3.8"

services:
  automation:
    build: .
    container_name: clickup-automation
    restart: unless-stopped
    ports:
      - "3457:3457"
    env_file:
      - .env.dev
    volumes:
      - repos-data:/app/repos
      - ./logs:/app/logs
    depends_on:
      postgres:
        condition: service_healthy
    networks:
      - automation-net

  postgres:
    image: postgres:16-alpine
    container_name: clickup-automation-db
    restart: unless-stopped
    environment:
      POSTGRES_DB: clickup_automation
      POSTGRES_USER: automation
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U automation -d clickup_automation"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - automation-net

volumes:
  repos-data:
  pg-data:

networks:
  automation-net:
    driver: bridge
```

#### .env.dev (template)

```bash
# ClickUp
CLICKUP_API_TOKEN=pk_xxx
CLICKUP_MY_USER_ID=your-user-id
CLICKUP_WORKSPACE_ID=your-workspace-id
CLICKUP_LIST_ID=your-list-id
CLICKUP_FOLDER_ID=your-folder-id
CLICKUP_WEBHOOK_SECRET=xxx

# GitHub
GITHUB_TOKEN=ghp_xxx
GITHUB_ORG=your-github-org
GITHUB_WEBHOOK_SECRET=xxx

# Database (internal Docker network)
DATABASE_URL=postgresql://automation:${DB_PASSWORD}@postgres:5432/clickup_automation

# Server
PORT=3457
NODE_ENV=production
MODE=webhook

# Claude Code
ANTHROPIC_API_KEY=sk-ant-xxx
CLAUDE_CODE_PATH=claude
MAX_CONCURRENT_SESSIONS=1
CLAUDE_TIMEOUT_MS=1800000

# Repos
REPOS_BASE_DIR=/app/repos

# Trigger
TRIGGER_STATUSES=backlog,ready,to do,open,todo,planning
```

#### nginx config (reverse proxy)

```nginx
server {
    listen 443 ssl;
    server_name autoship.your-domain.com;

    ssl_certificate     /etc/ssl/certs/dev.crt;
    ssl_certificate_key /etc/ssl/private/dev.key;

    # Webhook endpoints (ClickUp + GitHub)
    location /webhook/ {
        proxy_pass http://localhost:3457;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Dashboard + API (add basic auth or IP whitelist)
    location / {
        auth_basic "Automation Dashboard";
        auth_basic_user_file /etc/nginx/.htpasswd;
        proxy_pass http://localhost:3457;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        # SSE support
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }

    # Health check (no auth)
    location /health {
        proxy_pass http://localhost:3457/health;
    }
}
```

### Dev Server Prerequisites Checklist

- [ ] Docker + Docker Compose installed
- [ ] nginx installed and configured with SSL
- [ ] DNS record: `autoship.your-domain.com` → dev server IP
- [ ] Firewall: allow 443 inbound (for webhooks from ClickUp/GitHub)
- [ ] ClickUp webhook re-registered with new URL: `https://autoship.your-domain.com/webhook/clickup`
- [ ] GitHub webhook configured on repos: `https://autoship.your-domain.com/webhook/github`
- [ ] `ANTHROPIC_API_KEY` provisioned (for Claude Code in headless mode)
- [ ] `GITHUB_TOKEN` with repo scope (PAT or fine-grained)
- [ ] `.env.dev` file created with all secrets
- [ ] Basic auth password set for dashboard access

### Deployment Commands

```bash
# Initial deploy
scp -r . dev-server:/opt/clickup-automation/
ssh dev-server "cd /opt/clickup-automation && docker compose up -d --build"

# Check health
curl https://autoship.your-domain.com/health

# View logs
ssh dev-server "docker logs -f clickup-automation"

# Redeploy after code changes
ssh dev-server "cd /opt/clickup-automation && git pull && docker compose up -d --build"
```

---

## Part 2: Code Changes Required for Server Deployment

### 1. Claude Code Authentication (Critical)

Currently the CLI relies on interactive browser-based auth. On a server, it needs `ANTHROPIC_API_KEY`:

**File: `src/execution-engine.js` — `runClaudeCode()` function**

```javascript
// Add to the spawn environment:
const env = {
    ...process.env,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    // Prevent interactive prompts
    CI: 'true',
};

const child = spawn(claudePath, [...args], {
    cwd,
    env,  // <-- pass explicit env
    stdio: ['pipe', 'pipe', 'pipe'],
});
```

### 2. Git Authentication (Critical)

Replace SSH with HTTPS + token for server:

**File: `src/execution-engine.js` — git clone/push**

```javascript
// Instead of: git clone git@github.com:org/repo.git
// Use: git clone https://x-access-token:TOKEN@github.com/org/repo.git

const cloneUrl = `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${repoFullName}.git`;
```

Or configure git credential helper globally in the Dockerfile:

```dockerfile
RUN git config --global credential.helper store
# At runtime, write credentials
# echo "https://x-access-token:${GITHUB_TOKEN}@github.com" > ~/.git-credentials
```

### 3. REPOS_BASE_DIR Portability

Already uses env var — just ensure `/app/repos` in Docker. No code change needed.

### 4. Graceful Shutdown

Add signal handlers to cleanly stop active Claude sessions:

```javascript
// src/server.js
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down gracefully');
    // Stop accepting new tasks
    // Wait for active sessions to complete (with timeout)
    // Close DB pool
    process.exit(0);
});
```

---

## Part 3: Architecture Improvements

### A. Immediate Improvements (Pre-Deploy)

#### 1. Task Deduplication Race Condition

**Problem:** The unique index on `(clickup_task_id, state)` WHERE state NOT IN terminal states prevents duplicates at DB level, but the poller + webhook can both try to enqueue simultaneously.

**Fix:** Use `INSERT ... ON CONFLICT DO NOTHING` and check the returned row count:

```javascript
// task-queue.js — enqueueTask()
const result = await pool.query(
    `INSERT INTO tasks (clickup_task_id, ...) VALUES ($1, ...)
     ON CONFLICT ON CONSTRAINT idx_tasks_active DO NOTHING
     RETURNING id`,
    [taskId, ...]
);
if (result.rowCount === 0) return { duplicate: true };
```

#### 2. Structured Error Handling

**Problem:** Errors in the 10-step pipeline are caught generically. If step 6 (Claude Code) fails, it's unclear if the branch was already created/pushed.

**Fix:** Add a `lastCompletedStep` column to the tasks table and record progress:

```javascript
await taskQueue.updateStep(taskId, 'git_branch_created');
// ... run claude ...
await taskQueue.updateStep(taskId, 'claude_completed');
```

This enables smart retries — skip steps that already succeeded.

#### 3. Webhook Signature Validation

**Problem:** `CLICKUP_WEBHOOK_SECRET` and `GITHUB_WEBHOOK_SECRET` are optional. On dev/prod, they MUST be required.

**Fix:** In production mode, refuse to start without webhook secrets:

```javascript
if (process.env.NODE_ENV === 'production' && config.get('mode') !== 'poller') {
    if (!process.env.CLICKUP_WEBHOOK_SECRET) {
        throw new Error('CLICKUP_WEBHOOK_SECRET required in production');
    }
}
```

#### 4. Health Check Enhancement

Add dependency checks to `/health`:

```javascript
app.get('/health', async (req, res) => {
    const checks = {
        db: await checkDb(),
        disk: checkDiskSpace(config.get('reposBaseDir')),
        uptime: process.uptime(),
    };
    const healthy = checks.db && checks.disk;
    res.status(healthy ? 200 : 503).json(checks);
});
```

### B. Feature Improvements (Post-Deploy)

#### 5. Slack Notifications (High Priority)

**Status:** Env vars exist (`SLACK_CHANNEL_ID`, `SLACK_WEBHOOK_URL`) but no implementation.

**Implement:** Notify on task started, PR created, task failed, PR review processed.

```javascript
// src/slack-notifier.js
async function notify(event, data) {
    if (!process.env.SLACK_WEBHOOK_URL) return;
    const messages = {
        task_started: `🔧 Starting: *${data.taskName}* (${data.repo})`,
        pr_created: `✅ PR created: <${data.prUrl}|#${data.prNumber}> for *${data.taskName}*`,
        task_failed: `❌ Failed: *${data.taskName}* — ${data.error}`,
    };
    await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        body: JSON.stringify({ text: messages[event], channel: process.env.SLACK_CHANNEL_ID }),
    });
}
```

#### 6. Multi-Repo Workspace Support

**Problem:** Each task clones a full repo. For monorepo setups or frequent tasks on the same repo, this wastes disk and time.

**Fix:** Implement persistent repo cache with lock file:

```javascript
// src/repo-manager.js
class RepoManager {
    async acquireRepo(repoFullName) {
        const repoDir = path.join(REPOS_BASE_DIR, repoFullName.replace('/', '-'));
        const lockFile = `${repoDir}.lock`;

        await acquireLock(lockFile);

        if (await exists(repoDir)) {
            await runCommand('git', ['fetch', 'origin'], repoDir);
            await runCommand('git', ['checkout', config.get('baseBranch')], repoDir);
            await runCommand('git', ['pull', 'origin', config.get('baseBranch')], repoDir);
        } else {
            await runCommand('git', ['clone', cloneUrl, repoDir]);
        }

        return { repoDir, release: () => releaseLock(lockFile) };
    }
}
```

#### 7. Task Priority Queue

**Problem:** All tasks are FIFO. Urgent tickets should jump the queue.

**Fix:** Read ClickUp priority field and map to queue priority:

```javascript
// Extend tasks table:
// ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 3;
// 1=urgent, 2=high, 3=normal, 4=low

// execution ordering:
SELECT * FROM tasks WHERE state = 'approved'
ORDER BY priority ASC, received_at ASC LIMIT 1;
```

#### 8. Cost Tracking per Task

**Problem:** No visibility into Anthropic API costs.

**Fix:** Capture Claude Code's token usage from its output:

```javascript
// Parse Claude Code output for usage stats
const usageMatch = claudeOutput.match(/Total tokens: (\d+)/);
if (usageMatch) {
    await taskQueue.updateCost(taskId, {
        tokens: parseInt(usageMatch[1]),
        estimatedCost: parseInt(usageMatch[1]) * 0.000015, // opus pricing
    });
}
```

Add columns: `tokens_used INTEGER`, `estimated_cost_usd NUMERIC(10,4)`.

#### 9. Subtask Awareness

**Problem:** Current implementation reads subtasks but doesn't use them in the prompt strategically.

**Fix:** Structure the Claude prompt to handle subtasks as acceptance criteria:

```javascript
function buildPrompt(task) {
    let prompt = `## Task: ${task.name}\n\n${task.description}\n`;

    if (task.subtasks?.length) {
        prompt += `\n## Acceptance Criteria (Subtasks):\n`;
        task.subtasks.forEach((st, i) => {
            prompt += `${i + 1}. [${st.status === 'complete' ? 'x' : ' '}] ${st.name}\n`;
        });
        prompt += `\nEnsure ALL unchecked items are completed.\n`;
    }
    return prompt;
}
```

#### 10. Test Execution Before PR

**Problem:** Claude generates code but no automated test verification before pushing.

**Fix:** Add a post-Claude step that runs the project's test suite:

```javascript
// Step 6.5: Run tests
const testResult = await runCommand('npm', ['test'], repoDir, { timeout: 120000 });
if (testResult.exitCode !== 0) {
    // Feed test failures back to Claude for a fix pass
    await runClaudeCode(`Tests failed. Fix these failures:\n${testResult.stderr}`, repoDir);
}
```

### C. Advanced Features (Roadmap)

#### 11. Multi-User Support

Currently supports a single user via `CLICKUP_MY_USER_ID`. Extend to support multiple developers:

- Config: `CLICKUP_ASSIGNEE_IDS=user1,user2,user3`
- Each user's PRs tagged with their name
- Dashboard filtering by user

#### 12. Context Injection from Codebase

Before running Claude, pre-analyze the codebase and inject relevant context:

```javascript
// Identify related files based on ticket description keywords
const relatedFiles = await findRelatedFiles(repoDir, task.description);
prompt += `\n## Key files to review:\n${relatedFiles.map(f => `- ${f}`).join('\n')}`;
```

#### 13. Auto-Review (Self-Review Loop)

After Claude generates code, run a second Claude pass as a reviewer:

```javascript
// Step 6.5: Self-review
const diffOutput = await runCommand('git', ['diff', '--staged'], repoDir);
const review = await runClaudeCode(
    `Review this diff for bugs, security issues, and best practices:\n${diffOutput}`,
    repoDir
);
// If issues found, run fix pass
```

#### 14. Rollback Mechanism

Track the base commit SHA before Claude makes changes. If the PR is rejected or the task fails, auto-revert:

```javascript
const baseSha = await runCommand('git', ['rev-parse', 'HEAD'], repoDir);
// ... run claude ...
// On failure:
await runCommand('git', ['reset', '--hard', baseSha], repoDir);
```

#### 15. Webhook Replay / Dead Letter Queue

If webhook processing fails, store the raw event and allow replay:

```sql
CREATE TABLE webhook_events (
    id SERIAL PRIMARY KEY,
    source VARCHAR(20),      -- 'clickup' or 'github'
    event_type VARCHAR(100),
    payload JSONB,
    processed BOOLEAN DEFAULT FALSE,
    error TEXT,
    received_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 16. Dashboard Authentication

Currently no auth on the dashboard. Add JWT-based or basic auth:

- Option A: nginx basic auth (quick, sufficient for dev)
- Option B: API key in header for API calls
- Option C: OAuth via GitHub (best for multi-user)

---

## Part 4: Environment Progression Strategy

### Dev → QA → Prod Pipeline

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│   Dev    │───▶│   QA     │───▶│   Prod   │
│          │    │          │    │          │
│ webhook  │    │ webhook  │    │ webhook  │
│ mode:auto│    │ mode:que │    │ mode:que │
│ 1 session│    │ 2 session│    │ 3 session│
│ all stat │    │ selected │    │ approved │
│ no auth  │    │ basic    │    │ oauth    │
└──────────┘    └──────────┘    └──────────┘
```

| Setting | Dev | QA | Prod |
|---------|-----|-----|------|
| `EXECUTION_MODE` | auto | queue | queue |
| `MAX_CONCURRENT_SESSIONS` | 1 | 2 | 3 |
| `CLAUDE_MODEL` | opus-4-6 | opus-4-6 | opus-4-6 |
| `CLAUDE_TIMEOUT_MS` | 1800000 | 1800000 | 900000 |
| `BASE_BRANCH` | dev | dev | dev |
| Dashboard auth | none/basic | basic | OAuth |
| Webhook secrets | required | required | required |
| Slack notifications | optional | enabled | enabled |
| Auto-retry | true | true | false |

### CI/CD (Future)

```yaml
# .github/workflows/deploy.yml
name: Deploy Automation
on:
  push:
    branches: [main]

jobs:
  deploy-dev:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build & Push Docker Image
        run: |
          docker build -t automation:${{ github.sha }} .
          docker tag automation:${{ github.sha }} registry/automation:dev
          docker push registry/automation:dev
      - name: Deploy to Dev
        run: |
          ssh dev-server "cd /opt/clickup-automation && \
            docker pull registry/automation:dev && \
            docker compose up -d"
```

---

## Part 5: Immediate Action Items

### Phase 1: Prepare for Dev Deployment (This Week)

1. [ ] Create `Dockerfile` (as above)
2. [ ] Create `docker-compose.yml` (as above)
3. [ ] Create `.env.dev` template (no secrets committed)
4. [ ] Add `.dockerignore` (node_modules, .env, repos, .git)
5. [ ] Fix git auth to use HTTPS + token (execution-engine.js)
6. [ ] Ensure Claude Code CLI works with `ANTHROPIC_API_KEY` env var
7. [ ] Add graceful shutdown handlers (server.js)
8. [ ] Add webhook secret validation in production mode

### Phase 2: Deploy to Dev Server (Next Week)

9. [ ] Set up DNS record for automation subdomain
10. [ ] Install Docker + nginx on dev server
11. [ ] Configure nginx with SSL + reverse proxy
12. [ ] Deploy with `docker compose up -d`
13. [ ] Re-register ClickUp webhook with new URL
14. [ ] Configure GitHub webhook on target repos
15. [ ] Test end-to-end: create ClickUp task → verify PR created
16. [ ] Set up basic auth on dashboard

### Phase 3: Improvements (Weeks 3-4)

17. [ ] Implement Slack notifications
18. [ ] Add cost tracking per task
19. [ ] Implement test execution before PR
20. [ ] Add task priority queue
21. [ ] Implement webhook dead letter queue
22. [ ] Enhance health check with DB + disk checks

---

## Consequences

**What becomes easier:**
- Always-on automation (not tied to laptop being open)
- Team can view dashboard and monitor tasks
- Webhook delivery is reliable (real URL, not ngrok)
- Database is persistent and backed up
- Deployments are reproducible (Docker)

**What becomes harder:**
- Debugging requires SSH + docker logs (not just local terminal)
- Claude Code CLI updates need image rebuild
- Repo disk usage needs monitoring on server
- Need to manage secrets securely (not just local .env)

**What we'll need to revisit:**
- Multi-user support when team grows
- Scaling beyond 1 server (task queue → Redis/SQS)
- Cost optimization (model selection per task complexity)
- PR auto-merge policies for production
