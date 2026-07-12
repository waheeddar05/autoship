# ADR-004: Deployment Control Plane — Artifact & Code Promotion Across dev → qa → prod

**Status:** Proposed
**Date:** 2026-07-12
**Deciders:** Engineering Team
**Supersedes/extends:** ADR-001 (deployment strategy), and the vision sketch in `cicd-flow-improved.mermaid`

---

## Context

AutoShip today is a ClickUp/GitHub → Claude Code → PR automation service. The
only "deployment" functionality that exists is the pipeline that deploys
**AutoShip itself** to a single environment:

```
push to dev
  → GitHub Actions Build: docker build → push to Artifact Registry (tag = run_id, latest)
  → GitHub Actions Deploy: clone → checkout argo-deployment → sed image tag in helm/dev-values.yaml → push
  → Argo CD auto-sync → GKE (dev namespace)
```

The goal of this ADR is much larger: make AutoShip the **entire deployment
control system** — a control plane that can deploy *any* artifact for *any*
registered repository, with two promotion strategies, a dev → qa → prod
environment model, and per-repository role-based permissions.

This is the target end state:

- **Register repositories** for artifact promotion or code promotion.
- **Maintain three branches** — `dev`, `qa`, `prod`.
- **Code promotion:** when code lands on `dev`, allow cherry-picking any commit
  and promoting it `dev → qa`, then optionally `qa → prod`.
- **Artifact promotion:** build once, promote the *same* build to every
  environment.
- **Per-repo mode:** each repository chooses artifact promotion *or* code
  promotion.
- **Per-repo roles:** assign users different roles per repository, with
  permissions scoped to that repo.

An honest assessment: the current deployment code is roughly **10–15%** of this
vision. The rest is specified below.

---

## Part 1: What exists today

### 1.1 The pipeline (`.github/workflows/deploy-dev.yml`)

A single workflow named "Pipeline", dev-only, no tests/scans/verification/rollback:

- **Build** — authenticates to GCP with a static SA-key JSON secret
  (`GKE_REGISTRY_KEY`), builds `linux/amd64`, pushes to
  `us-central1-docker.pkg.dev/$GCP_PROJECT_ID/autoship/<repo>-dev` tagged with
  `github.run_id` and `latest`. `BUILD_ENV: dev` is hardcoded — the environment
  name is baked into the image name.
- **Deploy** — runs in a `bitnami/git` container, clones with a PAT, checks out
  `argo-deployment`, runs `sed -i "s|tag:.*|tag: \"${VERSION}\"|"
  helm/dev-values.yaml`, commits, pushes. Argo CD picks it up asynchronously
  with no feedback loop.

> **Note:** the pipeline as committed cannot run against this repository —
> `git ls-remote` shows no `argo-deployment` branch, no branch carries a
> `helm/` directory, and there is no `qa` branch (only `main`, `dev`, and
> feature branches). The GitOps target must be created (or the workflow marked
> as a template) as part of Phase 0.

### 1.2 Runtime & docs

- `Dockerfile` (Node 20, non-root `autoship`, bundles git + gh + Claude Code
  CLI), `docker-compose.yml` + `docker-compose.dev.yml`, `deploy/nginx.conf`
  (TLS termination, SSE tuning, webhook passthrough).
- `ADR-001` (local → dev server strategy), `gke-deployment-runbook.md`, and
  `cicd-flow-improved.mermaid` — the last is already a vision sketch for
  dev → test → prod promotion of a single image with approvals, canary
  analysis, and auto-rollback. This ADR turns that sketch into a plan.

### 1.3 Reusable foundations already in `src/`

| Foundation | Location | Reuse in control plane |
|---|---|---|
| Hardened git executor (`runCommand`: no-shell spawn, timeouts, `GIT_TERMINAL_PROMPT=0`) | `execution-engine.js` | The primitive a promotion executor needs |
| Token-injected HTTPS clone + fetch, remote rewrite | `execution-engine.js` (`getCloneUrl`/`ensureRepoCloned`) | Per-env / per-role credential swap per operation |
| Token resolution chain: per-user → org-admin → env | `execution-engine.js` | Graft `(repo, environment, action)` resolution here |
| `gh` CLI patterns (PR create/comment/merge --squash, `gh api`) | `execution-engine.js` | Promotion PRs, labels, release APIs |
| Approval state-machine pattern | `workflow_approvals` table | Model for the promotions ledger |
| Multi-stage dependency ledger | `multi_pr_plans` table | Model for multi-env promotion chains |
| Google OAuth + Postgres sessions + auto-provision | `auth.js` | Authn reused as-is |
| Config audit trail + SSE `config:changed` broadcast | `dashboard-api.js`, `config_audit_log` | Live per-repo settings updates |

### 1.4 Structural facts that shape the plan

- **No repository registry.** The set of managed repos is literally
  `SELECT DISTINCT repo_full_name FROM tasks`. Repos are known only
  transiently, per task.
- **All config is global.** `config_overrides` is a flat key/value store whose
  `ConfigManager.set()` rejects any key outside a hardcoded schema
  (`config-manager.js:1143`); `admin_workflow_config` is constrained to a
  single row by `CHECK (id = 1)` (`db.js:203`). Nothing is keyed by repo.
- **RBAC is one global role per user.** `ADMIN` / `DEVELOPER` / `READ_ONLY` in a
  single `users.role` column, enforced by a resource-blind
  `requireRole(...roles)` (`rbac.js:13`). `repo_full_name` appears on many
  tables purely as work-item data, never as an authorization boundary.
- **The git engine has no promotion primitives.** No `cherry-pick`, `merge`,
  `tag`, or `release`, and **no conflict handling** — its philosophy is
  "discard and recreate" (stash-drop, `branch -D`, `push --force-with-lease`),
  safe for throwaway feature branches, dangerous for promotion branches.
- **`baseBranch` is a single global config value** (default `dev`), not a
  per-repo, per-environment mapping.

---

## Part 2: Review findings on the existing deployment code

A multi-agent review (map → dimensioned review → adversarial verification) was
run over the deployment assets. 37 raw findings were challenged; 17 survived
verification (20 were refuted as unreachable or as missing-feature complaints).
The survivors, to be addressed in Phase 0:

### High

1. **`Dockerfile:24` — remote script piped to a root shell at build time.**
   `curl -sSL https://usegitai.com/install.sh | bash || true` is unpinned,
   unverified, and failure-suppressed. A compromise of that domain is a
   root-level backdoor baked into every pushed image, next to
   `ANTHROPIC_API_KEY` / `GITHUB_TOKEN`. The `|| true` also silently drops the
   git-ai feature from builds. **Fix:** pin a release, verify a SHA-256
   checksum, drop `|| true`.
2. **`docker-compose.dev.yml:14` — dev override disables all auth while still
   published on 0.0.0.0.** Blanking `GOOGLE_CLIENT_ID/SECRET` makes `auth.js`
   stamp every request with a synthetic ADMIN user (`auth.js:178-191`); the
   override inherits the base `0.0.0.0:3457` publish. On any reachable dev VM
   the dashboard and admin API are open as ADMIN. **Fix:** override ports to
   `127.0.0.1:3457:3457` in the dev file.

### Medium

3. **`deploy-dev.yml:17` — GCP SA-key JSON and GitHub PAT exported as
   workflow-level env**, visible to every step including third-party actions and
   the `bitnami/git` container; `service_account_key` is never even consumed.
   **Fix:** scope secrets to the single steps that use them.
4. **`deploy-dev.yml:33` — deprecated `setup-gcloud@v0` + static SA key**, and
   `export_default_credentials: true` writes the key JSON into
   `$GITHUB_WORKSPACE` — the Docker build context — with no `.dockerignore`
   coverage. **Fix:** move to `google-github-actions/auth@v2` with Workload
   Identity Federation (already sketched in the mermaid v2), SHA-pin, delete the
   static key.
5. **`deploy-dev.yml:12` — over-broad `permissions`** (`contents: write`,
   `id-token: write`) granted but never legitimately used; a compromised action
   could push to `dev`, which self-triggers this pipeline and auto-deploys.
   **Fix:** `contents: read`.
6. **`deploy-dev.yml:20` — `VERSION=github.run_id` is constant across re-runs.**
   Re-running overwrites the mutable tag with different bytes, the sed becomes a
   no-op, and Argo CD sees no diff — the cluster runs a stale binary while the
   tag points at new bytes. **Fix:** use `github.sha` or `run_id-run_attempt`;
   never overwrite a pushed tag.
7. **`docker-compose.yml:9` — two issues.** (a) App published on all interfaces,
   bypassing the nginx TLS/auth layer — bind to loopback. (b) `PORT=8080` in
   `.env` breaks the container: the host mapping changes but `env_file` also
   injects `PORT` inward, so the app listens on 8080 while the mapping and
   healthcheck target 3457. **Fix:** loopback bind + pin `PORT: 3457` in the
   service `environment:`.
8. **`deploy/nginx.conf:6` — instructs creating an htpasswd file but never
   applies `auth_basic`.** Proxy-layer auth the operator believes exists does
   not. **Fix:** add the directives to `location /` (excluding `/webhook/`,
   `/health`), or delete the misleading comment.
9. **`gke-deployment-runbook.md:97` — instructs an over-scoped classic PAT**
   (`repo` + `workflow`) for a single-branch, single-repo push. **Fix:**
   fine-grained PAT with Contents: read/write on this one repo; drop `workflow`.
10. **`Dockerfile:64` — Claude Code onboarding flag written to a path the CLI
    does not read** (`~/.claude/.claude.json` instead of `~/.claude.json`), a
    dead config that defeats its own stated purpose. **Fix:** write to
    `~/.claude.json` and smoke-test a headless `claude -p`.

### Low

11. **`deploy-dev.yml:81` — no non-fast-forward handling on the
    `argo-deployment` push.** The per-ref concurrency group does not cover a
    `workflow_dispatch` from another branch, which can race a dev push and abort
    after its image already shipped, or silently deploy feature-branch code.
    **Fix:** fixed `deploy-dev` concurrency group + a fetch/rebase-retry loop
    (mermaid v2 already specifies "yq + retry-rebase").
12. **`deploy-dev.yml:65` — unpinned `bitnami/git :latest`** from a
    legacy-status catalog; the job doesn't need a container (ubuntu-latest ships
    git). **Fix:** drop `container:` or pin by digest.
13. **`docker-compose.yml:35` — DB password defaults to `changeme`** if
    `DB_PASSWORD` is unset, and persists in the pg volume thereafter. **Fix:**
    `${DB_PASSWORD:?DB_PASSWORD must be set}`.
14. **`gke-deployment-runbook.md:114` — troubleshooting row points to
    self-hosted runners** the pipeline doesn't use (both jobs are
    `ubuntu-latest`), extending incident MTTR. **Fix:** replace with the real
    failure modes (concurrency cancellation, registry auth, push rejection,
    image pull).

---

## Part 3: Gap analysis — vision vs. today

| Requirement | Current state |
|---|---|
| Register repos for promotion | No repository registry; repos known only via `DISTINCT repo_full_name FROM tasks` |
| Three branches: dev / qa / prod | Single global `baseBranch` (default `dev`); no per-repo env→branch map; no `qa` branch |
| Cherry-pick promotion dev → qa → prod | No `cherry-pick`/`merge`/`tag`, no conflict handling anywhere |
| Artifact promotion (build once, deploy everywhere) | Images rebuilt per env (`-dev` baked into image name); no artifact tracking; mutable tags |
| Per-repo mode (artifact vs code) | No per-repo settings store to attach a flag to |
| Per-repo user roles | One global role per user; `repo_full_name` never an auth boundary |

---

## Part 4: The plan for the remaining ~85–90%

Phases are ordered by dependency; each ships something usable on its own.

### Phase 0 — Harden the substrate

Fix the 17 findings in Part 2 before building on the pipeline: WIF instead of
SA keys, immutable SHA tags, `yq` + rebase-retry instead of blind `sed`, scoped
secrets/permissions, loopback binds. Create the missing `argo-deployment`
branch + `helm/` chart (or mark the workflow as a template). This matters
doubly: in the target architecture AutoShip's promotion engine becomes the
*writer* to GitOps branches, so the write path must be trustworthy first.

### Phase 1 — Control-plane domain model (load-bearing)

Three schema additions, following the migration patterns already in `db.js`:

- **`repositories`** — `repo_full_name` UNIQUE,
  `promotion_mode CHECK (IN ('artifact','code'))`, per-environment branch map
  (`{dev, qa, prod}` as JSONB), artifact settings (registry path, values-file
  paths, Argo CD app name), enabled flag. Seed from the existing implicit
  registry (`DISTINCT repo_full_name FROM tasks` — the query
  `register-github-webhook.js` already uses) plus the org listing in
  `task-creator-api.js`. Neither existing config store fits: `config_overrides`
  rejects unknown keys; `admin_workflow_config` is single-row.
- **`user_repo_roles`** — `(user_id, repo_id, role)` with deployment roles:
  `VIEWER`, `DEVELOPER`, `PROMOTER` (dev→qa), `PROD_APPROVER` (qa→prod),
  `REPO_ADMIN`. Add a `requireRepoRole(minRole)` companion to `requireRole()`
  that resolves the target repo from route/body/task row, with global ADMIN as
  override. The assignment API follows the `admin-api.js` PATCH pattern
  (including its self-demotion guard). Two backdoors must respect the new model:
  the auth-disabled mock-ADMIN mode (`auth.js:178`) and the `manage-users.js`
  direct-DB CLI.
- **Repo settings API + dashboard page** — register a repo, pick its mode, map
  branches, assign roles. Reuse `config_audit_log` (add a repo column) and the
  SSE `config:changed` broadcast.

### Phase 2 — Code promotion engine (cherry-pick dev → qa → prod)

- **`promotions` table** — repo, source/target env, selected commit SHAs, state
  machine (`requested → approved → in_progress → succeeded | failed |
  conflict`), requested_by / approved_by, PR URL. Model on `workflow_approvals`
  (approval state) + `multi_pr_plans` (multi-stage ledger).
- **Git executor extensions** — reuse `runCommand`, `ensureRepoCloned`, and the
  token chain, but add: `git worktree add` per promotion (the shared
  clone-per-repo directory has no locking and corrupts under concurrency; also
  fix name-only directory keying to org/name), `cherry-pick -x` onto a
  `promote/qa/<id>` branch, conflict detection with `--abort` and surfaced
  details, PR to the target branch via existing gh plumbing, and
  **fast-forward-only pushes for environment branches** — the engine's
  force-with-lease habit must never touch qa/prod.
- **The squash-merge trap** — `gh pr merge --squash` rewrites SHAs, so the
  commit picker must list commits from the *dev branch itself*
  (`git log qa..dev` / `git cherry`), not feature-branch SHAs, and track
  promoted commits (the `-x` trailer gives traceability).
- **Commit picker API/UI** — commits on dev not yet in qa, joined to tasks/PRs
  (the `tasks` table already carries `repo_full_name` and `pr_url`),
  multi-select, promote. Same flow qa→prod, gated by `PROD_APPROVER` with
  optional N-of-M approval.
- **Optional** — AI-assisted conflict resolution as opt-in, reusing the
  existing build-fix/test-fix retry loop pattern; keep manual resolution the
  default.

### Phase 3 — Artifact promotion engine (build once, promote many)

- **`artifacts` table** — repo, commit SHA, image *digest* (not tag), CI run
  ID/URL, build time, test/scan status. Populated via a `POST /api/artifacts`
  callback from Actions (or a `workflow_run` webhook handler — AutoShip already
  receives GitHub webhooks).
- **Build once** — restructure CI to build a single env-agnostic image tagged by
  SHA (drop `-dev` from image names); environments differ only in values files.
  This is the mermaid v2 design ("same image, tested in dev").
- **Promotion = values-file write** — AutoShip's engine updates
  `<env>-values.yaml` on the GitOps branch via yq + rebase-retry, gated by the
  same per-repo roles and approval flow as Phase 2. AutoShip becomes the only
  writer to `argo-deployment`, replacing manual dispatch.
- **`deployments` table + verification loop** — after the values push, poll
  Argo CD app health / rollout status, record state per (artifact,
  environment), and implement rollback as "revert the values commit" — which
  also enables one-click redeploy of any previous artifact.

### Phase 4 — Control-plane UX & operations

- **Environment matrix dashboard** — per repo: which SHA/artifact is in
  dev/qa/prod, drift ("14 commits in dev not in qa"), promotion history,
  one-click promote with approval, live via SSE.
- **Slack-native promotions** — request/approve from Slack;
  `slackInteractiveService` + the assistant already provide the plumbing.
  Per-env channels (mermaid v2's `#deployments` / `#releases` / `#incidents`).
- **Guardrails** — full audit trail for every promotion action, per-repo
  promotion locks (Postgres advisory locks), freeze windows, scheduled deploys.

### Phase 5 — Advanced (mermaid v2 backlog)

Trivy scan gating with PR comments, changelog auto-generation on promotion,
GitHub Release tagging on prod deploys, progressive rollout via Argo Rollouts
with metric-based canary analysis and auto-rollback, External Secrets Operator,
the shared reusable `service-deploy.yml` workflow parameterized by language and
env, and Cloud Monitoring dashboards/alerts.

---

## Decision

Adopt the phased plan above. Two cross-cutting design principles:

1. **Promotion is an AutoShip domain object, not a CI feature.** GitHub
   Environment protection rules are useful defense in depth, but the
   requirements (per-repo roles, either promotion mode, any artifact) need the
   approval and audit logic to live in AutoShip itself.
2. **Key everything by digest/SHA, never mutable tags.** Half the confirmed
   pipeline findings trace back to mutable state (`latest`, `run_id` reuse,
   unpinned images).

---

## Consequences

**Easier:**
- One control plane deploys any registered artifact to any environment with a
  consistent approval and audit model.
- Per-repo roles let teams self-serve promotions without global admin rights.
- Artifact promotion guarantees the bytes tested in dev are the bytes shipped to
  prod.

**Harder:**
- AutoShip becomes a critical path for deployments — its own availability and
  the trustworthiness of its GitOps write path now matter a great deal (hence
  Phase 0 first).
- Cherry-pick promotion introduces merge-conflict handling, a class of failure
  the current "discard and recreate" engine never had to reason about.
- Per-repo RBAC adds a second authorization axis that every existing
  `requireRole` call site must be audited against.

**To revisit:**
- Whether code promotion and artifact promotion should ever coexist for one
  repo (currently mutually exclusive per the requirements).
- Scaling the promotion executor beyond a single host (worktrees + advisory
  locks assume shared local disk).
- Multi-cluster / multi-region targets once single-cluster dev/qa/prod is solid.
