// src/services/repoAllowlistService.js
// Scopes the Slack assistant (and PR review) to a specific GitHub team's
// repositories. The team's repos are fetched live from the GitHub API and
// cached, so the allowlist auto-tracks repos added to / removed from the team
// (e.g. https://github.com/orgs/sarasanalytics-com/teams/daton/repositories).
//
// Fail-closed: when scoping is enabled and the team list can't be loaded (and
// nothing is cached), requests are denied rather than silently allowed — the
// whole point is to NOT touch repos outside the team.

import { logger } from "../logger.js";
import { config } from "../config-manager.js";

const CACHE_TTL_MS = Number(process.env.ASSISTANT_REPO_SCOPE_CACHE_MS) || 10 * 60 * 1000; // 10 min

// { names: string[] (original case), lower: Set<string>, fetchedAt: number }
let cache = null;
let inflight = null; // de-dupe concurrent refreshes

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "autoship-repo-allowlist",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Repos explicitly allowed via config, regardless of team membership. */
function staticAllowed() {
  return config.getList("assistantAllowedReposStatic").map((s) => s.trim()).filter(Boolean);
}

/** Fetch every repo in the configured team (paginated). Throws on API error. */
async function fetchTeamRepos() {
  const org = config.get("assistantTeamOrg");
  const team = config.get("assistantTeamSlug");
  if (!org || !team) throw new Error("assistantTeamOrg / assistantTeamSlug not configured");

  const names = [];
  for (let page = 1; page <= 20; page++) {
    const url = `https://api.github.com/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/repos?per_page=100&page=${page}`;
    const res = await fetch(url, { headers: githubHeaders() });
    if (!res.ok) {
      const hint =
        res.status === 403 || res.status === 401
          ? " (GITHUB_TOKEN likely needs read:org scope and team access)"
          : res.status === 404
            ? " (org/team slug wrong, or token can't see the team)"
            : "";
      throw new Error(`GitHub team repos ${org}/${team} → ${res.status} ${res.statusText}${hint}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const repo of batch) if (repo.full_name) names.push(repo.full_name);
    if (batch.length < 100) break;
  }
  return names;
}

/**
 * Return the current allow-set, using cache when fresh. On fetch failure,
 * falls back to the last good cache (even if stale). Returns { names, lower,
 * ok, error } — ok=false means the live list couldn't be loaded this call.
 */
async function getAllowSet({ force = false } = {}) {
  const staticNames = staticAllowed();
  const fresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (!force && fresh) {
    return { names: cache.names, lower: cache.lower, ok: true };
  }

  if (!inflight) {
    inflight = (async () => {
      const teamNames = await fetchTeamRepos();
      const names = [...new Set([...teamNames, ...staticAllowed()])];
      cache = { names, lower: new Set(names.map((n) => n.toLowerCase())), fetchedAt: Date.now() };
      logger.info({ count: names.length, org: config.get("assistantTeamOrg"), team: config.get("assistantTeamSlug") }, "[REPO-SCOPE] Team repo allowlist refreshed");
      return cache;
    })().finally(() => { inflight = null; });
  }

  try {
    const result = await inflight;
    return { names: result.names, lower: result.lower, ok: true };
  } catch (err) {
    logger.warn({ err: err.message }, "[REPO-SCOPE] Team repo fetch failed");
    if (cache) {
      // Serve stale cache (merged with any static entries) rather than break.
      const merged = [...new Set([...cache.names, ...staticNames])];
      return { names: merged, lower: new Set(merged.map((n) => n.toLowerCase())), ok: false, error: err.message };
    }
    if (staticNames.length > 0) {
      return { names: staticNames, lower: new Set(staticNames.map((n) => n.toLowerCase())), ok: false, error: err.message };
    }
    return { names: [], lower: new Set(), ok: false, error: err.message };
  }
}

/** Force a refresh of the cached allowlist (e.g. on startup or manual sync). */
export async function refreshAllowlist() {
  return getAllowSet({ force: true });
}

/** Original-case allowed repo names, for help/error messages. */
export async function listAllowedRepos() {
  const { names } = await getAllowSet();
  return names;
}

/**
 * Decide whether the assistant may act on a repo.
 * @returns {Promise<{allowed: boolean, reason: 'disabled'|'allowed'|'not_in_team'|'list_unavailable', sample: string[]}>}
 */
export async function isRepoAllowed(repoFullName) {
  if (!config.get("assistantRepoScopeEnabled")) {
    return { allowed: true, reason: "disabled", sample: [] };
  }
  if (!repoFullName) {
    return { allowed: false, reason: "not_in_team", sample: [] };
  }

  const { names, lower, ok, error } = await getAllowSet();

  if (lower.has(repoFullName.toLowerCase())) {
    return { allowed: true, reason: "allowed", sample: [] };
  }

  // Couldn't load the list and have nothing cached → fail closed, but say why.
  if (!ok && names.length === 0) {
    return { allowed: false, reason: "list_unavailable", sample: [], error };
  }

  return { allowed: false, reason: "not_in_team", sample: names.slice(0, 10) };
}
