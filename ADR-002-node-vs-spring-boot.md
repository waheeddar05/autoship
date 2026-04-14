# ADR-002: Should AutoShip Migrate from Node.js to Spring Boot?

**Status:** Proposed
**Date:** 2026-02-28
**Deciders:** Waheed

## Context

AutoShip is a ~3,200 LOC Node.js (Express) application that automates the ClickUp → Claude Code → GitHub PR pipeline. The team's primary backend stack is Java/Spring Boot and Kotlin, and the `source-service` (already deployed) is a Spring Boot app with a mature Gradle build, profile-based configs, and OpenTelemetry.

The question: should we rewrite AutoShip in Spring Boot for stack consistency, or keep it in Node.js?

## Decision

**Keep Node.js.** The application's core workload — spawning CLI subprocesses (`claude-code`, `git`, `gh`), streaming their stdout/stderr in real-time, and managing SSE connections — is fundamentally better suited to Node.js. A Spring Boot rewrite would add complexity without meaningful benefit.

## Options Considered

### Option A: Keep Node.js (Recommended)

| Dimension | Assessment |
|-----------|------------|
| Complexity | **Low** — 15 files, 3.2K LOC, already working |
| Cost | **Zero** — no rewrite needed |
| Scalability | **Sufficient** — this is a single-team internal tool, not a high-RPS service |
| Team familiarity | **Medium** — not the primary stack, but JS is straightforward |
| Deployment alignment | **High** — Docker + nginx pattern matches source-service |

**Why this fits:**

1. **Subprocess orchestration is Node's sweet spot.** The execution engine spawns `claude-code` as a child process, streams stdout/stderr line-by-line, detects patterns in real-time, and manages concurrent sessions. Node's `child_process.spawn` with event-driven streams is purpose-built for this. In Java, you'd be fighting with `ProcessBuilder`, manually threading stdin/stdout readers, and bolting on reactive patterns.

2. **SSE (Server-Sent Events) for the dashboard** works natively in Express — just hold the response open and write. Spring Boot can do SSE via `SseEmitter` or WebFlux, but it's more ceremony for the same result.

3. **3,200 lines is not worth rewriting.** The app is small, stable, and already has PostgreSQL-backed state, graceful shutdown, Slack notifications, and Docker deployment. A rewrite would take 2-3 weeks and introduce new bugs for zero functional gain.

4. **Deployment infra is stack-agnostic.** Both apps use Docker + docker-compose + nginx. The Dockerfile differs (node:20-slim vs Temurin JDK 21), but the deployment pattern, env-var config, and CI/CD flow are identical.

**Cons:**
- Two languages in the org (Java + Node.js)
- Team needs to context-switch when maintaining this app

### Option B: Rewrite in Spring Boot

| Dimension | Assessment |
|-----------|------------|
| Complexity | **High** — full rewrite of 15 modules |
| Cost | **2-3 weeks** of engineering time |
| Scalability | **Overkill** — Spring's DI, AOP, and thread pool model add overhead for a simple pipeline tool |
| Team familiarity | **High** — primary stack |
| Deployment alignment | **High** — matches source-service exactly |

**Pros:**
- Single language across all backend services
- Can reuse source-service's Gradle build, CI/CD, monitoring, and deployment scripts verbatim
- Kotlin coroutines could handle async subprocess management cleanly
- Spring Boot Actuator gives you health checks, metrics, and Prometheus out of the box

**Cons:**
- `ProcessBuilder` for subprocess management is significantly worse than Node's `child_process`. You'd need manual thread management for stdout/stderr streaming, pattern detection, and timeout handling
- Spring Boot's cold start (~3-5s) vs Node.js (~200ms) — matters for Docker health checks and restarts
- JVM memory footprint (~256-512MB) vs Node (~80-120MB) — matters if you run this alongside other services on a small dev server
- SSE implementation requires WebFlux or manual `SseEmitter` management
- The rewrite itself is the biggest risk — introducing bugs in a working system

### Option C: Kotlin + Ktor (Lightweight JVM)

| Dimension | Assessment |
|-----------|------------|
| Complexity | **High** — still a full rewrite |
| Cost | **2 weeks** — Ktor is lighter than Spring |
| Scalability | **Good** — coroutines are excellent for async I/O |
| Team familiarity | **Medium** — Kotlin yes, Ktor probably no |

**Pros:** Lighter than Spring Boot, Kotlin coroutines handle async well, stays on JVM
**Cons:** Still a full rewrite, Ktor ecosystem is smaller, still has ProcessBuilder limitations

## Trade-off Analysis

The core tension is **stack consistency vs. right tool for the job.**

Stack consistency matters when: teams frequently rotate between services, shared libraries are reused, and onboarding cost is high. None of these strongly apply here — AutoShip is a single-purpose internal tool maintained by one person.

Right tool matters when: the workload has specific runtime characteristics. Spawning CLI processes, streaming their output, and managing SSE connections are all event-loop-native patterns where Node.js has a genuine ergonomic advantage.

**The subprocess argument is decisive.** Here's what the execution engine does on every task:

```
1. spawn("git", ["clone", ...])        → stream stdout, detect completion
2. spawn("git", ["checkout", "-b", ...]) → stream stdout, detect errors
3. spawn("claude-code", [...])          → stream stdout for 2-15 minutes, detect patterns
4. spawn("git", ["add", "."])           → wait for completion
5. spawn("git", ["commit", ...])        → stream stdout
6. spawn("git", ["push", ...])          → stream stdout, detect errors
7. spawn("gh", ["pr", "create", ...])   → capture stdout (PR URL)
```

Each of these is 3-5 lines in Node.js. In Java, each requires a `ProcessBuilder`, thread management for stdout/stderr, and explicit stream handling — roughly 3x the code for the same result.

## Consequences

**By keeping Node.js:**
- ✅ No rewrite cost or risk
- ✅ Subprocess handling stays clean and maintainable
- ✅ Low memory/startup footprint on dev server
- ⚠️ Team needs basic Node.js knowledge for maintenance
- ⚠️ Can't share Spring Boot libraries (but there's nothing to share — this app has no domain overlap with source-service)

**What would change the decision:**
- If AutoShip grows into a multi-service platform with shared domain models → consider JVM
- If the team hires more Java-only engineers who need to maintain it → consider migration
- If you need deep integration with Spring Cloud, Eureka, or other Spring ecosystem tools → consider migration

## Action Items

1. [x] Keep Node.js — no migration
2. [ ] Align deployment patterns (Docker, nginx, env-var config) — already done in ADR-001
3. [ ] Add OpenTelemetry tracing to Node.js app (matches source-service observability) — optional future enhancement
4. [ ] Document the Node.js maintenance basics for the team in README
