import { useState, useEffect, useCallback } from "react";

const COLORS = {
  bg: "#0a0e1a",
  bgCard: "#111827",
  bgCardHover: "#1a2236",
  accent: "#6366f1",
  accentGlow: "rgba(99, 102, 241, 0.3)",
  green: "#22c55e",
  greenGlow: "rgba(34, 197, 94, 0.2)",
  orange: "#f59e0b",
  red: "#ef4444",
  cyan: "#06b6d4",
  pink: "#ec4899",
  text: "#f1f5f9",
  textMuted: "#94a3b8",
  textDim: "#64748b",
  border: "#1e293b",
};

const flowSteps = [
  { icon: "📋", label: "ClickUp Task Created", detail: "New task in configured ClickUp folder", color: COLORS.cyan },
  { icon: "🔍", label: "Poller Detects Task", detail: "Every 2 min, reads 'repo' custom field", color: COLORS.orange },
  { icon: "📂", label: "Clone / Pull Repo", detail: "Resolves repo → clones to workspace", color: COLORS.accent },
  { icon: "🌿", label: "Create Branch", detail: "auto/<task-id>-<slug> from dev", color: COLORS.green },
  { icon: "🤖", label: "Claude Code (Opus 4.6)", detail: "Reads codebase, implements, writes tests", color: COLORS.pink },
  { icon: "📤", label: "Git Push + PR", detail: "Commits → pushes → creates PR to dev", color: COLORS.accent },
  { icon: "💬", label: "ClickUp Comment", detail: "Posts PR link back on the task", color: COLORS.cyan },
];

const archComponents = [
  { name: "Express Server", desc: "Port 3457 — webhooks, API, SSE dashboard", icon: "🌐" },
  { name: "Poller", desc: "ClickUp API polling every 2 minutes", icon: "🔄" },
  { name: "Execution Engine", desc: "Spawns Claude Code CLI, manages git ops", icon: "⚙️" },
  { name: "Task Queue", desc: "PostgreSQL-backed state machine", icon: "📊" },
  { name: "Debate System", desc: "Multi-model AI consensus for complex tasks", icon: "🧠" },
  { name: "Dashboard", desc: "Real-time SSE monitoring + approval UI", icon: "📺" },
];

const techStack = [
  { name: "Node.js 20", category: "Runtime" },
  { name: "Express 5", category: "Server" },
  { name: "PostgreSQL 16", category: "Database" },
  { name: "Claude Code CLI", category: "AI Engine" },
  { name: "Opus 4.6", category: "Model" },
  { name: "GitHub CLI", category: "PR Creation" },
  { name: "Docker", category: "Container" },
  { name: "GKE", category: "Orchestration" },
  { name: "ArgoCD", category: "GitOps" },
  { name: "Traefik", category: "Ingress" },
  { name: "Pino", category: "Logging" },
  { name: "Prometheus", category: "Metrics" },
];

const debateFeatures = [
  { title: "Multi-Model Participants", desc: "Multiple AI models collaborate on complex tasks — each with a defined role (engineer, reviewer, security analyst)", icon: "👥" },
  { title: "Free Debate Style", desc: "Models discuss, critique, and build on each other's solutions before a leader synthesizes the best approach", icon: "💬" },
  { title: "Degraded Mode", desc: "If a participant fails, the system gracefully falls back to the best individual response", icon: "🛡️" },
  { title: "Execution Model Selection", desc: "The debate leader picks the optimal model for final code execution based on task complexity", icon: "🎯" },
];

const deploymentSteps = [
  { phase: "Local Dev", detail: "Waheed's Mac → localhost:3457", status: "done" },
  { phase: "Docker", detail: "Containerized with docker-compose", status: "done" },
  { phase: "GKE Dev", detail: "autoship.your-domain.com", status: "done" },
  { phase: "CI/CD", detail: "GitHub Actions → ArgoCD → GKE", status: "done" },
  { phase: "QA / Prod", detail: "Queue mode, OAuth, Slack alerts", status: "next" },
];

const roadmapItems = [
  { title: "Multi-User Support", desc: "Team-wide automation, not just single user", priority: "High" },
  { title: "Cost Tracking", desc: "Per-task token usage and Anthropic API spend", priority: "High" },
  { title: "Auto-Review Loop", desc: "Second Claude pass as code reviewer before PR", priority: "Medium" },
  { title: "Test Execution", desc: "Run project test suite before pushing PR", priority: "Medium" },
  { title: "Task Priority Queue", desc: "Urgent ClickUp tickets jump the queue", priority: "Medium" },
  { title: "Context Injection", desc: "Pre-analyze codebase, inject relevant files into prompt", priority: "Low" },
];

const metrics = [
  { label: "Lines of Code", value: "~3,200", icon: "📝" },
  { label: "Source Files", value: "40+", icon: "📁" },
  { label: "Avg Task Time", value: "2-15 min", icon: "⏱️" },
  { label: "PR Success Rate", value: "High", icon: "✅" },
];

// ─── Slide Components ────────────────────────────────────

function SlideTitle({ children }) {
  return <h1 style={{ fontSize: 42, fontWeight: 700, color: COLORS.text, margin: "0 0 8px 0", letterSpacing: "-0.5px" }}>{children}</h1>;
}

function SlideSubtitle({ children }) {
  return <p style={{ fontSize: 20, color: COLORS.textMuted, margin: "0 0 40px 0", lineHeight: 1.5 }}>{children}</p>;
}

function Badge({ children, color = COLORS.accent }) {
  return (
    <span style={{
      display: "inline-block", padding: "4px 14px", borderRadius: 20,
      background: `${color}22`, color, fontSize: 13, fontWeight: 600,
      border: `1px solid ${color}44`, marginRight: 8, marginBottom: 6
    }}>{children}</span>
  );
}

function RevealItem({ visible, delay, children }) {
  return (
    <div style={{
      opacity: visible ? 1 : 0,
      transform: visible ? "translateY(0)" : "translateY(20px)",
      transition: `all 0.5s ease ${delay}ms`,
    }}>{children}</div>
  );
}

// ─── Individual Slides ───────────────────────────────────

function Slide0({ step }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", textAlign: "center" }}>
      <RevealItem visible={step >= 0} delay={0}>
        <div style={{ fontSize: 80, marginBottom: 16 }}>🚀</div>
      </RevealItem>
      <RevealItem visible={step >= 0} delay={200}>
        <h1 style={{ fontSize: 64, fontWeight: 800, color: COLORS.text, margin: "0 0 8px 0", letterSpacing: "-1px" }}>
          Auto<span style={{ color: COLORS.accent }}>Ship</span>
        </h1>
      </RevealItem>
      <RevealItem visible={step >= 1} delay={0}>
        <p style={{ fontSize: 24, color: COLORS.textMuted, margin: "0 0 32px 0", maxWidth: 600 }}>
          ClickUp → Claude Code → GitHub PR
        </p>
      </RevealItem>
      <RevealItem visible={step >= 2} delay={0}>
        <p style={{ fontSize: 18, color: COLORS.textDim, margin: 0 }}>
          Fully automated development pipeline powered by AI
        </p>
      </RevealItem>
      <RevealItem visible={step >= 2} delay={200}>
        <div style={{ marginTop: 48, display: "flex", gap: 12 }}>
          <Badge color={COLORS.cyan}>Saras Analytics</Badge>
          <Badge color={COLORS.green}>v2.0</Badge>
          <Badge>March 2026</Badge>
        </div>
      </RevealItem>
    </div>
  );
}

function Slide1({ step }) {
  const pains = [
    "Developer picks up ClickUp task manually",
    "Reads requirements, clones repo, creates branch",
    "Writes code, writes tests, commits, pushes",
    "Creates PR, links back to ClickUp, waits for review",
    "Repeat 5-10x per day across multiple repos",
  ];
  return (
    <div style={{ height: "100%" }}>
      <SlideTitle>The Problem</SlideTitle>
      <SlideSubtitle>Manual developer workflow is slow, repetitive, and error-prone</SlideSubtitle>
      <div style={{ display: "flex", gap: 40 }}>
        <div style={{ flex: 1 }}>
          {pains.map((p, i) => (
            <RevealItem key={i} visible={step >= i} delay={0}>
              <div style={{
                display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 20,
                padding: "14px 18px", borderRadius: 12,
                background: step >= i ? `${COLORS.red}11` : "transparent",
                border: `1px solid ${step >= i ? COLORS.red + "33" : "transparent"}`,
              }}>
                <span style={{ color: COLORS.red, fontSize: 20, marginTop: 2 }}>✗</span>
                <span style={{ color: COLORS.text, fontSize: 17, lineHeight: 1.5 }}>{p}</span>
              </div>
            </RevealItem>
          ))}
        </div>
        <RevealItem visible={step >= 5} delay={0}>
          <div style={{
            flex: "0 0 280px", padding: 28, borderRadius: 16,
            background: `linear-gradient(135deg, ${COLORS.red}15, ${COLORS.orange}10)`,
            border: `1px solid ${COLORS.red}33`, textAlign: "center"
          }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>⏰</div>
            <div style={{ fontSize: 32, fontWeight: 700, color: COLORS.orange }}>~30 min</div>
            <div style={{ color: COLORS.textMuted, fontSize: 15, marginTop: 8 }}>per routine task</div>
            <div style={{ color: COLORS.textDim, fontSize: 14, marginTop: 16, lineHeight: 1.5 }}>
              Context switching, boilerplate, and repetitive git operations eat into deep work time
            </div>
          </div>
        </RevealItem>
      </div>
    </div>
  );
}

function Slide2({ step }) {
  return (
    <div style={{ height: "100%" }}>
      <SlideTitle>The Solution: AutoShip</SlideTitle>
      <SlideSubtitle>Create a ClickUp task → get a GitHub PR. That's it.</SlideSubtitle>
      <div style={{ display: "flex", gap: 32, marginBottom: 32 }}>
        {[
          { icon: "📋", title: "Task In", desc: "Create a ClickUp task with a 'repo' field", color: COLORS.cyan },
          { icon: "🤖", title: "AI Works", desc: "Claude Opus 4.6 reads code, implements, tests", color: COLORS.accent },
          { icon: "🎉", title: "PR Out", desc: "PR created on GitHub, linked back to ClickUp", color: COLORS.green },
        ].map((item, i) => (
          <RevealItem key={i} visible={step >= i} delay={0}>
            <div style={{
              flex: 1, padding: 28, borderRadius: 16,
              background: COLORS.bgCard, border: `1px solid ${COLORS.border}`,
              textAlign: "center",
            }}>
              <div style={{ fontSize: 48, marginBottom: 14 }}>{item.icon}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: item.color, marginBottom: 8 }}>{item.title}</div>
              <div style={{ color: COLORS.textMuted, fontSize: 15, lineHeight: 1.5 }}>{item.desc}</div>
            </div>
          </RevealItem>
        ))}
      </div>
      <RevealItem visible={step >= 3} delay={0}>
        <div style={{
          display: "flex", gap: 24, padding: "20px 24px", borderRadius: 14,
          background: `${COLORS.green}0d`, border: `1px solid ${COLORS.green}33`,
        }}>
          {metrics.map((m, i) => (
            <div key={i} style={{ flex: 1, textAlign: "center" }}>
              <div style={{ fontSize: 28 }}>{m.icon}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.text, marginTop: 4 }}>{m.value}</div>
              <div style={{ fontSize: 13, color: COLORS.textDim }}>{m.label}</div>
            </div>
          ))}
        </div>
      </RevealItem>
    </div>
  );
}

function Slide3({ step }) {
  return (
    <div style={{ height: "100%" }}>
      <SlideTitle>How It Works — The Pipeline</SlideTitle>
      <SlideSubtitle>End-to-end automation in 7 steps</SlideSubtitle>
      <div style={{ position: "relative" }}>
        {flowSteps.map((s, i) => (
          <RevealItem key={i} visible={step >= i} delay={0}>
            <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 12 }}>
              <div style={{
                width: 52, height: 52, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center",
                background: `${s.color}1a`, border: `2px solid ${s.color}55`, fontSize: 26,
                boxShadow: step === i ? `0 0 20px ${s.color}33` : "none",
              }}>{s.icon}</div>
              {i < flowSteps.length - 1 && (
                <div style={{
                  position: "absolute", left: 25, top: 52 + i * 64, width: 2, height: 12,
                  background: step > i ? s.color + "66" : COLORS.border,
                }} />
              )}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 17, fontWeight: 600, color: s.color }}>{s.label}</div>
                <div style={{ fontSize: 14, color: COLORS.textDim }}>{s.detail}</div>
              </div>
              {step >= i && (
                <div style={{ color: COLORS.green, fontSize: 14, fontWeight: 600 }}>✓</div>
              )}
            </div>
          </RevealItem>
        ))}
      </div>
    </div>
  );
}

function Slide4({ step }) {
  return (
    <div style={{ height: "100%" }}>
      <SlideTitle>Architecture Overview</SlideTitle>
      <SlideSubtitle>Six core components working together</SlideSubtitle>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20 }}>
        {archComponents.map((c, i) => (
          <RevealItem key={i} visible={step >= Math.floor(i / 3)} delay={(i % 3) * 100}>
            <div style={{
              padding: 24, borderRadius: 14,
              background: COLORS.bgCard, border: `1px solid ${COLORS.border}`,
              transition: "border-color 0.3s",
            }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>{c.icon}</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: COLORS.text, marginBottom: 6 }}>{c.name}</div>
              <div style={{ fontSize: 14, color: COLORS.textMuted, lineHeight: 1.5 }}>{c.desc}</div>
            </div>
          </RevealItem>
        ))}
      </div>
    </div>
  );
}

function Slide5({ step }) {
  return (
    <div style={{ height: "100%" }}>
      <SlideTitle>Tech Stack</SlideTitle>
      <SlideSubtitle>Built with the right tools for subprocess orchestration</SlideSubtitle>
      <RevealItem visible={step >= 0} delay={0}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 32 }}>
          {techStack.map((t, i) => (
            <div key={i} style={{
              padding: "12px 20px", borderRadius: 12,
              background: COLORS.bgCard, border: `1px solid ${COLORS.border}`,
              display: "flex", flexDirection: "column", alignItems: "center", minWidth: 120,
            }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: COLORS.text }}>{t.name}</div>
              <div style={{ fontSize: 12, color: COLORS.textDim, marginTop: 4 }}>{t.category}</div>
            </div>
          ))}
        </div>
      </RevealItem>
      <RevealItem visible={step >= 1} delay={0}>
        <div style={{
          padding: 24, borderRadius: 14,
          background: `${COLORS.accent}0d`, border: `1px solid ${COLORS.accent}33`,
        }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: COLORS.accent, marginBottom: 10 }}>
            Why Node.js over Spring Boot? (ADR-002)
          </div>
          <div style={{ color: COLORS.textMuted, fontSize: 15, lineHeight: 1.7 }}>
            The core workload — spawning CLI subprocesses (claude-code, git, gh), streaming stdout/stderr in real-time, and managing SSE — is fundamentally better in Node.js. Each subprocess operation is 3-5 lines vs ~3x in Java. Plus lower memory (80-120MB vs 256-512MB) and instant startup (200ms vs 3-5s).
          </div>
        </div>
      </RevealItem>
    </div>
  );
}

function Slide6({ step }) {
  return (
    <div style={{ height: "100%" }}>
      <SlideTitle>The Dashboard</SlideTitle>
      <SlideSubtitle>Real-time monitoring, approval workflow, and live logs</SlideSubtitle>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {[
          { title: "Overview", desc: "System uptime, pending approvals, active tasks, success rate — key metrics at a glance", icon: "📊", color: COLORS.accent },
          { title: "Live Queue", desc: "Filter by All, Pending, Active, Attention. Approve or dismiss incoming tasks", icon: "📋", color: COLORS.cyan },
          { title: "Task History", desc: "All past tasks with status, timing, and PR links. Full execution audit trail", icon: "📜", color: COLORS.green },
          { title: "AI Providers", desc: "Configure debate participants — multiple models with defined roles collaborate on tasks", icon: "🤖", color: COLORS.pink },
          { title: "Settings", desc: "Execution config, ClickUp/GitHub integration, PR review settings, trigger statuses", icon: "⚙️", color: COLORS.orange },
          { title: "Server Logs", desc: "Live streaming logs with color-coded levels via SSE connection", icon: "📝", color: COLORS.red },
        ].map((page, i) => (
          <RevealItem key={i} visible={step >= Math.floor(i / 2)} delay={(i % 2) * 150}>
            <div style={{
              padding: 20, borderRadius: 14,
              background: COLORS.bgCard, border: `1px solid ${COLORS.border}`,
              display: "flex", gap: 16, alignItems: "flex-start",
            }}>
              <div style={{
                width: 44, height: 44, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center",
                background: `${page.color}1a`, fontSize: 22, flexShrink: 0,
              }}>{page.icon}</div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: page.color, marginBottom: 4 }}>{page.title}</div>
                <div style={{ fontSize: 14, color: COLORS.textMuted, lineHeight: 1.5 }}>{page.desc}</div>
              </div>
            </div>
          </RevealItem>
        ))}
      </div>
    </div>
  );
}

function Slide7({ step }) {
  return (
    <div style={{ height: "100%" }}>
      <SlideTitle>AI Debate System</SlideTitle>
      <SlideSubtitle>Multi-model consensus for higher quality code</SlideSubtitle>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24 }}>
        {debateFeatures.map((f, i) => (
          <RevealItem key={i} visible={step >= i} delay={0}>
            <div style={{
              padding: 22, borderRadius: 14,
              background: COLORS.bgCard, border: `1px solid ${COLORS.border}`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                <span style={{ fontSize: 28 }}>{f.icon}</span>
                <span style={{ fontSize: 16, fontWeight: 700, color: COLORS.text }}>{f.title}</span>
              </div>
              <div style={{ fontSize: 14, color: COLORS.textMuted, lineHeight: 1.6 }}>{f.desc}</div>
            </div>
          </RevealItem>
        ))}
      </div>
      <RevealItem visible={step >= 4} delay={0}>
        <div style={{
          padding: 18, borderRadius: 12, textAlign: "center",
          background: `${COLORS.pink}0d`, border: `1px solid ${COLORS.pink}33`,
        }}>
          <span style={{ color: COLORS.pink, fontSize: 15, fontWeight: 600 }}>
            Result: Multiple AI perspectives → fewer bugs, better architecture decisions
          </span>
        </div>
      </RevealItem>
    </div>
  );
}

function Slide8({ step }) {
  return (
    <div style={{ height: "100%" }}>
      <SlideTitle>Deployment Journey</SlideTitle>
      <SlideSubtitle>From local laptop to GKE with full CI/CD</SlideSubtitle>
      <div style={{ marginBottom: 32 }}>
        {deploymentSteps.map((s, i) => (
          <RevealItem key={i} visible={step >= i} delay={0}>
            <div style={{
              display: "flex", alignItems: "center", gap: 20, marginBottom: 16,
              padding: "16px 20px", borderRadius: 14,
              background: s.status === "done" ? `${COLORS.green}0a` : `${COLORS.orange}0a`,
              border: `1px solid ${s.status === "done" ? COLORS.green + "33" : COLORS.orange + "33"}`,
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                background: s.status === "done" ? COLORS.green : COLORS.orange,
                color: "#fff", fontWeight: 700, fontSize: 14,
              }}>{s.status === "done" ? "✓" : "→"}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 17, fontWeight: 700, color: COLORS.text }}>{s.phase}</div>
                <div style={{ fontSize: 14, color: COLORS.textMuted }}>{s.detail}</div>
              </div>
              <Badge color={s.status === "done" ? COLORS.green : COLORS.orange}>
                {s.status === "done" ? "Complete" : "Next"}
              </Badge>
            </div>
          </RevealItem>
        ))}
      </div>
      <RevealItem visible={step >= 5} delay={0}>
        <div style={{
          padding: 18, borderRadius: 12,
          background: COLORS.bgCard, border: `1px solid ${COLORS.border}`,
          fontSize: 14, color: COLORS.textMuted, lineHeight: 1.7,
        }}>
          <strong style={{ color: COLORS.cyan }}>Infrastructure:</strong> GCP Project → GKE cluster → Namespace → Traefik ingress → DNS → autoship.your-domain.com
        </div>
      </RevealItem>
    </div>
  );
}

function Slide9({ step }) {
  return (
    <div style={{ height: "100%" }}>
      <SlideTitle>CI/CD Pipeline</SlideTitle>
      <SlideSubtitle>GitHub Actions → Docker → ArgoCD → GKE</SlideSubtitle>
      {[
        { icon: "📝", label: "Push to main", detail: "Developer merges PR to main branch", color: COLORS.text },
        { icon: "🏗️", label: "GitHub Actions Build", detail: "Self-hosted k8s-runner builds Docker image", color: COLORS.orange },
        { icon: "🐳", label: "Push to Artifact Registry", detail: "us-central1-docker.pkg.dev/your-project/autoship", color: COLORS.cyan },
        { icon: "🔄", label: "ArgoCD Sync", detail: "Detects new image tag, updates Helm values", color: COLORS.accent },
        { icon: "☸️", label: "GKE Rolling Deploy", detail: "Zero-downtime deployment to your namespace", color: COLORS.green },
        { icon: "✅", label: "Health Check Pass", detail: "Traefik routes traffic, app live at autoship.your-domain.com", color: COLORS.green },
      ].map((s, i) => (
        <RevealItem key={i} visible={step >= i} delay={0}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 10 }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center",
              background: `${s.color}1a`, fontSize: 22, flexShrink: 0,
              border: step === i ? `2px solid ${s.color}` : `1px solid ${COLORS.border}`,
            }}>{s.icon}</div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 600, color: s.color }}>{s.label}</div>
              <div style={{ fontSize: 13, color: COLORS.textDim }}>{s.detail}</div>
            </div>
          </div>
        </RevealItem>
      ))}
    </div>
  );
}

function Slide10({ step }) {
  const improvements = [
    { title: "Unique Branch per Run", desc: "Added {runId} suffix — no more 'PR already exists' failures on retry", status: "Done", color: COLORS.green },
    { title: "Dashboard Actions", desc: "Delete, Cancel, and Retry buttons for all task states", status: "Done", color: COLORS.green },
    { title: "Contextual Guidance", desc: "Live guidance UI adapts based on task state (active/failed/success)", status: "Done", color: COLORS.green },
    { title: "Google OAuth", desc: "Dashboard authentication via passport-google-oauth20", status: "Done", color: COLORS.green },
    { title: "Slack Notifications", desc: "Real-time alerts for task started, PR created, failures", status: "Done", color: COLORS.green },
    { title: "Prometheus Metrics", desc: "prom-client integration for monitoring and alerting", status: "Done", color: COLORS.green },
  ];
  return (
    <div style={{ height: "100%" }}>
      <SlideTitle>Key Improvements (v2.0)</SlideTitle>
      <SlideSubtitle>What we shipped since the initial build</SlideSubtitle>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {improvements.map((item, i) => (
          <RevealItem key={i} visible={step >= Math.floor(i / 2)} delay={(i % 2) * 120}>
            <div style={{
              padding: 18, borderRadius: 12,
              background: COLORS.bgCard, border: `1px solid ${COLORS.border}`,
              display: "flex", gap: 14, alignItems: "flex-start",
            }}>
              <div style={{ color: item.color, fontSize: 18, marginTop: 2 }}>✓</div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.text, marginBottom: 3 }}>{item.title}</div>
                <div style={{ fontSize: 13, color: COLORS.textMuted, lineHeight: 1.5 }}>{item.desc}</div>
              </div>
            </div>
          </RevealItem>
        ))}
      </div>
    </div>
  );
}

function Slide11({ step }) {
  return (
    <div style={{ height: "100%" }}>
      <SlideTitle>Roadmap</SlideTitle>
      <SlideSubtitle>What's next for AutoShip</SlideSubtitle>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {roadmapItems.map((item, i) => (
          <RevealItem key={i} visible={step >= i} delay={0}>
            <div style={{
              padding: "16px 20px", borderRadius: 12,
              background: COLORS.bgCard, border: `1px solid ${COLORS.border}`,
              display: "flex", alignItems: "center", gap: 16,
            }}>
              <Badge color={item.priority === "High" ? COLORS.red : item.priority === "Medium" ? COLORS.orange : COLORS.textDim}>
                {item.priority}
              </Badge>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: COLORS.text }}>{item.title}</div>
                <div style={{ fontSize: 13, color: COLORS.textMuted }}>{item.desc}</div>
              </div>
            </div>
          </RevealItem>
        ))}
      </div>
    </div>
  );
}

function Slide12({ step }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", textAlign: "center" }}>
      <RevealItem visible={step >= 0} delay={0}>
        <div style={{ fontSize: 72, marginBottom: 20 }}>🚀</div>
      </RevealItem>
      <RevealItem visible={step >= 0} delay={200}>
        <h1 style={{ fontSize: 52, fontWeight: 800, color: COLORS.text, margin: "0 0 12px 0" }}>
          Demo Time
        </h1>
      </RevealItem>
      <RevealItem visible={step >= 1} delay={0}>
        <p style={{ fontSize: 22, color: COLORS.textMuted, margin: "0 0 40px 0", maxWidth: 500, lineHeight: 1.6 }}>
          Let's create a ClickUp task and watch AutoShip turn it into a PR
        </p>
      </RevealItem>
      <RevealItem visible={step >= 2} delay={0}>
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{
            padding: "14px 28px", borderRadius: 12,
            background: `${COLORS.accent}1a`, border: `1px solid ${COLORS.accent}55`,
            color: COLORS.accent, fontWeight: 600, fontSize: 16,
          }}>autoship.your-domain.com</div>
        </div>
      </RevealItem>
      <RevealItem visible={step >= 2} delay={300}>
        <div style={{ marginTop: 48, display: "flex", gap: 24 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 14, color: COLORS.textDim, marginBottom: 4 }}>Built by</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: COLORS.text }}>Waheed</div>
          </div>
          <div style={{ width: 1, background: COLORS.border }} />
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 14, color: COLORS.textDim, marginBottom: 4 }}>Team</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: COLORS.text }}>Saras Analytics</div>
          </div>
        </div>
      </RevealItem>
    </div>
  );
}

// ─── Main Presentation ───────────────────────────────────

const SLIDES = [
  { component: Slide0, title: "AutoShip", maxStep: 2 },
  { component: Slide1, title: "The Problem", maxStep: 5 },
  { component: Slide2, title: "The Solution", maxStep: 3 },
  { component: Slide3, title: "Pipeline", maxStep: 6 },
  { component: Slide4, title: "Architecture", maxStep: 1 },
  { component: Slide5, title: "Tech Stack", maxStep: 1 },
  { component: Slide6, title: "Dashboard", maxStep: 2 },
  { component: Slide7, title: "AI Debate", maxStep: 4 },
  { component: Slide8, title: "Deployment", maxStep: 5 },
  { component: Slide9, title: "CI/CD", maxStep: 5 },
  { component: Slide10, title: "Improvements", maxStep: 2 },
  { component: Slide11, title: "Roadmap", maxStep: 5 },
  { component: Slide12, title: "Demo", maxStep: 2 },
];

export default function AutoShipPresentation() {
  const [slideIndex, setSlideIndex] = useState(0);
  const [step, setStep] = useState(0);
  const [transitioning, setTransitioning] = useState(false);

  const currentSlide = SLIDES[slideIndex];
  const SlideComponent = currentSlide.component;

  const goNext = useCallback(() => {
    if (transitioning) return;
    if (step < currentSlide.maxStep) {
      setStep(s => s + 1);
    } else if (slideIndex < SLIDES.length - 1) {
      setTransitioning(true);
      setTimeout(() => {
        setSlideIndex(i => i + 1);
        setStep(0);
        setTransitioning(false);
      }, 200);
    }
  }, [step, slideIndex, currentSlide.maxStep, transitioning]);

  const goBack = useCallback(() => {
    if (transitioning) return;
    if (step > 0) {
      setStep(s => s - 1);
    } else if (slideIndex > 0) {
      setTransitioning(true);
      setTimeout(() => {
        const prevSlide = SLIDES[slideIndex - 1];
        setSlideIndex(i => i - 1);
        setStep(prevSlide.maxStep);
        setTransitioning(false);
      }, 200);
    }
  }, [step, slideIndex, transitioning]);

  const goToSlide = useCallback((i) => {
    if (transitioning) return;
    setTransitioning(true);
    setTimeout(() => {
      setSlideIndex(i);
      setStep(0);
      setTransitioning(false);
    }, 200);
  }, [transitioning]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowLeft" || e.key === "Backspace") {
        e.preventDefault();
        goBack();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [goNext, goBack]);

  const progress = ((slideIndex + (step / (currentSlide.maxStep || 1))) / (SLIDES.length - 1)) * 100;

  return (
    <div style={{
      width: "100%", height: "100vh", background: COLORS.bg,
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      display: "flex", flexDirection: "column", overflow: "hidden", userSelect: "none",
    }}>
      {/* Progress bar */}
      <div style={{ height: 3, background: COLORS.border, flexShrink: 0 }}>
        <div style={{
          height: "100%", background: `linear-gradient(90deg, ${COLORS.accent}, ${COLORS.cyan})`,
          width: `${progress}%`, transition: "width 0.4s ease",
        }} />
      </div>

      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 28px", flexShrink: 0, borderBottom: `1px solid ${COLORS.border}`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 20 }}>🚀</span>
          <span style={{ fontSize: 15, fontWeight: 700, color: COLORS.text }}>AutoShip</span>
          <span style={{ fontSize: 13, color: COLORS.textDim }}>Showcase</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {SLIDES.map((s, i) => (
            <div
              key={i}
              onClick={() => goToSlide(i)}
              title={s.title}
              style={{
                width: i === slideIndex ? 28 : 8, height: 8, borderRadius: 4,
                background: i === slideIndex ? COLORS.accent : i < slideIndex ? COLORS.accent + "66" : COLORS.border,
                cursor: "pointer", transition: "all 0.3s",
              }}
            />
          ))}
        </div>
        <div style={{ fontSize: 13, color: COLORS.textDim }}>
          {slideIndex + 1} / {SLIDES.length}
        </div>
      </div>

      {/* Slide area */}
      <div
        style={{ flex: 1, padding: "36px 56px 24px", overflow: "auto", cursor: "pointer",
          opacity: transitioning ? 0 : 1,
          transform: transitioning ? "translateY(10px)" : "translateY(0)",
          transition: "opacity 0.2s, transform 0.2s",
        }}
        onClick={goNext}
      >
        <SlideComponent step={step} />
      </div>

      {/* Footer nav */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 28px", borderTop: `1px solid ${COLORS.border}`, flexShrink: 0,
      }}>
        <button
          onClick={(e) => { e.stopPropagation(); goBack(); }}
          disabled={slideIndex === 0 && step === 0}
          style={{
            padding: "8px 24px", borderRadius: 8, border: `1px solid ${COLORS.border}`,
            background: "transparent", color: COLORS.textMuted, cursor: "pointer",
            fontSize: 14, fontWeight: 600, opacity: (slideIndex === 0 && step === 0) ? 0.3 : 1,
          }}
        >
          ← Back
        </button>
        <div style={{ fontSize: 12, color: COLORS.textDim }}>
          Click anywhere, press → or Space to advance
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); goNext(); }}
          disabled={slideIndex === SLIDES.length - 1 && step >= currentSlide.maxStep}
          style={{
            padding: "8px 24px", borderRadius: 8, border: "none",
            background: COLORS.accent, color: "#fff", cursor: "pointer",
            fontSize: 14, fontWeight: 600,
            opacity: (slideIndex === SLIDES.length - 1 && step >= currentSlide.maxStep) ? 0.3 : 1,
          }}
        >
          Next →
        </button>
      </div>
    </div>
  );
}