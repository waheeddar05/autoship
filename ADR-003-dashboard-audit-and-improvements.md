# ADR-003: Autoship Dashboard — Comprehensive Audit & Improvement Plan

**Status:** Proposed
**Date:** 2026-03-01
**Author:** Waheed (via Architecture Review)
**Scope:** Frontend (Dashboard UI), Backend API, UX, Debate System

---

## 1. Executive Summary

After a thorough review of `the AutoShip dashboard`, the codebase (`public/index.html`, `src/dashboard-api.js`, `src/debate/debate-orchestrator.js`), and all dashboard pages (Overview, Live Queue, All Tasks, Settings, AI Providers, Server Logs), the following critical issues and improvements have been identified.

---

## 2. Critical Issues Found

### 2.1 FAILED Task — Root Cause

The latest task "Expose CRUD Endpoints for `dbtGraphQLConfig` Entity" failed because **a PR already exists** for that branch:

```
gh pr create --base dev --head feature/86d21z5z4-expose-crud-endpoints-for-dbtgraphqlconfig-entity
failed (code 1): a pull request for branch already exists:
https://github.com/your-org/source-service/pull/1164
```

**Fix Applied:** Each execution now generates a unique `{runId}` (6-char alphanumeric suffix) appended to the branch name. This ensures every retry/re-run of the same ClickUp task gets its own branch and PR — no collisions.

- `format-helpers.js` — Added `generateRunId()` and `{runId}` template variable
- `execution-engine.js` — Generates `runId` per fresh run, passes to `formatBranchName()`
- `config-manager.js` — Default branch format changed to `feature/{taskId}-{slug}-{runId}`

Example: Same task retried 3 times →
- `feature/86d21z5z4-expose-crud-endpoints-...-a7k2m9`
- `feature/86d21z5z4-expose-crud-endpoints-...-x3p8n1`
- `feature/86d21z5z4-expose-crud-endpoints-...-f2q5w7`

### 2.2 Missing Dashboard Actions (Retry, Delete, Cancel)

**Current state (line 1451–1467 of `index.html`):**
- `queued`/`received` → Shows "Approve & Start" + "Dismiss" ✅
- `failed` → Shows only "Retry Execution" ✅ (already exists)
- `active`/`running` → Shows **nothing** ❌
- **No "Delete" button exists anywhere** ❌
- **No "Cancel" button for running tasks** ❌
- **No bulk actions on list views** ❌

**Backend gap:** There is no `DELETE /api/queue/:id` or `POST /api/queue/:id/cancel` endpoint.

**Required additions:**

| State | Actions Needed |
|-------|---------------|
| `queued`/`received` | Approve, Dismiss, **Delete** |
| `active`/`running` | **Cancel Execution**, View Logs |
| `failed` | Retry, **Delete**, View Error |
| `success` | View PR, **Archive/Delete** |
| Any state | **Delete from history** |

**Backend endpoints to add:**
```
DELETE /api/queue/:id          — Soft-delete/archive a task
POST   /api/queue/:id/cancel  — Cancel a running task (kill Claude Code process)
```

### 2.3 Guidance Feature — Not Broken, But Misleading

The Guidance tab shows "No specific guidance messages provided yet." — this is **correct behavior** when no messages have been sent. However:

**UX Issues:**
- The placeholder "Add instructions for Claude..." is vague
- No indication whether guidance is sent to an active session or queued for next run
- The "Update" button label is unclear — should be "Send Guidance" or "Send Instructions"
- No confirmation or feedback after sending (the `flashToast` only fires on success)
- For **failed** tasks, the guidance input is still shown, which is confusing — you can't guide a dead session

**Fix:** Contextually adapt the Guidance UI based on task state:
- `active` → "Send live guidance to Claude" with real-time indicator
- `queued` → "Pre-set instructions for when Claude starts"
- `failed` → Disable input, show "Task has failed. Retry to apply new guidance."
- `success` → Read-only history of past guidance

### 2.4 "Exec: claude-sonnet-4-20250514 Degraded" in Debate Section

**What it means:** The debate orchestrator marks a session as `degraded` when one or more participants **fail to respond** (line 149 of `debate-orchestrator.js`). In the free_debate style, if the leader's synthesis call fails, it falls back to the best individual response (line 274).

**The issue is cosmetic + informational:**
- `claude-sonnet-4-20250514` is the **execution model** selected by the leader — NOT a participant
- "Degraded" is shown in yellow (line 1834) next to the exec model, making it look like the **model itself** is degraded
- Users will think the AI model is broken, not that a debate participant dropped out

**Fixes:**
1. **Separate the display:** Show execution model and degraded status independently
2. **Add context:** Instead of just "Degraded", show "1 participant failed during debate" or similar
3. **Tooltip/expand:** Show which participant failed and at which round
4. The model string `claude-sonnet-4-20250514` is the old identifier — the AI Providers page now shows `Claude Sonnet 4.6`. These should be consistent.

---

## 3. UX/Design Critique

### 3.1 Dashboard Overview Page

**Good:**
- Clean dark theme, glassmorphism sidebar ✅
- Status indicators (ClickUp, GitHub, Claude) in header ✅
- Key metrics (System Uptime, Pending Approval, Active Tasks, Successfully Merged) ✅

**Issues:**
- **No way to interact with activity cards from the list** — no right-click menu, no hover actions, no swipe
- **All 4 activity items show the same task name** — no visual differentiation between runs
- **"Successfully Merged: 1"** but the actual task is failed — this stat may be stale/misleading
- **No pagination or "Load More"** on Recent Activity
- **No empty state design** for when there are no tasks
- **No search/filter** on the dashboard

### 3.2 Task Queue (Live Queue)

**Good:**
- Filter tabs (All, Pending, Active, Attention) ✅

**Issues:**
- **"Attention" tab meaning is unclear** — what triggers it?
- **No inline actions** (retry/delete) visible on cards — user must click to open panel
- **No sorting** (by date, status, repo)
- **No task count** shown per tab
- **Cards are not distinguishable** — repeated same task name with no unique identifier visible

### 3.3 Task History (All Tasks)

- Same issues as Task Queue
- **No date range filter**
- **No export capability** (CSV/JSON)
- **No way to clear old failed tasks**

### 3.4 Settings/Configuration Page

**Good:**
- Well-organized sections (Execution, ClickUp, GitHub, PR Review) ✅
- ENV Override badges clearly indicate source ✅

**Issues:**
- **"Apply Changes" button is at the top** — for a long settings page, it should also be at the bottom (or be sticky)
- **No validation feedback** — what happens if you enter invalid values?
- **No "Reset to defaults" option**
- **Trigger Statuses field** (`backlog,ready,to do,open,todo,planning`) is a raw comma-separated string — should be tag pills
- **No confirmation dialog** for applying changes

### 3.5 AI Providers Page

**Good:**
- Clean participant management with + Add / × Remove ✅
- Model dropdowns with provider prefix ✅

**Issues:**
- **No health check** for configured models — can't tell if API keys are valid
- **Role field is free text** — should offer presets (Software Engineer, Code Reviewer, Security Analyst, etc.)
- **No drag-to-reorder** for participant priority
- **No model version info** — "Claude Sonnet 4.6" vs backend "claude-sonnet-4-20250514" mismatch

### 3.6 Server Logs Page

**Good:**
- Live streaming, color-coded levels ✅

**Issues:**
- **No log level filter** (show only errors, warnings)
- **No search** within logs
- **No auto-scroll toggle** — hard to read when new logs push content down
- **No download/export** option
- **No timestamp date** — only shows time (22:25:06), not the date

---

## 4. Missing Features (Priority Order)

### P0 — Must Fix

| # | Feature | Effort |
|---|---------|--------|
| 1 | Add Delete endpoint + UI button for all task states | Backend: 2h, Frontend: 1h |
| 2 | Add Cancel endpoint for running tasks | Backend: 3h (process kill), Frontend: 1h |
| 3 | Fix PR creation to handle existing PRs | Backend: 1h |
| 4 | Add inline action buttons on task cards (hover/kebab menu) | Frontend: 2h |
| 5 | Contextual Guidance UI based on task state | Frontend: 2h |

### P1 — Should Fix

| # | Feature | Effort |
|---|---------|--------|
| 6 | Improve "Degraded" display with participant failure details | Frontend: 1h, Backend: 1h |
| 7 | Add task counts per filter tab | Frontend: 30m |
| 8 | Add pagination on task lists | Frontend: 1h, Backend: 1h |
| 9 | Log level filter + search on Server Logs | Frontend: 2h |
| 10 | Sticky/dual "Apply Changes" button on Settings | Frontend: 30m |

### P2 — Nice to Have

| # | Feature | Effort |
|---|---------|--------|
| 11 | Bulk actions (select multiple → retry/delete) | Frontend: 3h, Backend: 2h |
| 12 | Task card differentiation (run # badge, unique identifier) | Frontend: 1h |
| 13 | Date range filter on Task History | Frontend: 2h |
| 14 | Role presets dropdown on AI Providers | Frontend: 1h |
| 15 | Model health check / validation on AI Providers | Backend: 2h, Frontend: 1h |

---

## 5. Architecture Observations

### 5.1 Single-File Frontend Anti-Pattern

The entire dashboard is a **2006-line single HTML file** with inline CSS + JS. This will become unmaintainable.

**Recommendation:** If the scope grows beyond ~10 more features, migrate to a lightweight React/Next.js app or at minimum split into separate files:
- `styles.css` — all CSS
- `app.js` — all JS logic
- `index.html` — markup only

For now, the single file is acceptable for a dev-internal tool, but add a TODO to refactor.

### 5.2 No Authentication

The dashboard has **zero authentication**. Anyone with the URL can access settings, retry tasks, and view sensitive repo/ClickUp data.

**Recommendation:** Add at minimum:
- Basic auth via environment variable (`DASHBOARD_USER` / `DASHBOARD_PASS`)
- Or Google OAuth for the Saras team

### 5.3 Debate Model Identifier Mismatch

The AI Providers UI shows friendly names (`Claude Sonnet 4.6`) but the debate session stores the raw API identifier (`claude-sonnet-4-20250514`). The dashboard should normalize these for display.

### 5.4 Error Recovery Gap

The execution engine doesn't handle the "PR already exists" scenario, which is a **common idempotency issue**. The retry logic should be smarter:
1. Check if branch exists → reuse or create
2. Check if PR exists → update or create
3. Check if PR is merged → skip PR step

---

## 6. Recommended Action Items

1. [ ] **Backend:** Add `DELETE /api/queue/:id` and `POST /api/queue/:id/cancel` endpoints
2. [ ] **Backend:** Fix execution engine to handle existing PRs gracefully
3. [ ] **Frontend:** Add kebab menu (⋮) on task cards with Retry / Delete / Cancel actions
4. [ ] **Frontend:** Make Guidance tab state-aware (active vs failed vs success)
5. [ ] **Frontend:** Improve Degraded label to show "X participant(s) failed" with details
6. [ ] **Frontend:** Add log level filter + search on Server Logs page
7. [ ] **Frontend:** Add pagination on task lists
8. [ ] **Backend:** Add basic authentication to dashboard
9. [ ] **Frontend:** Normalize model display names across the app
10. [ ] **Infra:** Consider splitting `index.html` as feature count grows

---

*Generated from live audit of the AutoShip dashboard on 2026-03-01*
