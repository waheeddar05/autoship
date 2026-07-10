// src/services/visualVerificationService.js
// Visual verification for frontend tasks: boot the repo's dev server after
// code generation, capture Playwright screenshots of configured routes, and
// return files + PR-body markdown so reviewers see the UI change.
//
// Playwright is an optional peer — when it isn't installed (or the project
// isn't a frontend), verification silently skips.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import { config } from "../config-manager.js";

const FRONTEND_TYPES = new Set(["nextjs", "react"]);
const DEV_PORT = Number(process.env.VISUAL_VERIFY_PORT) || 34611;
const BOOT_TIMEOUT_MS = Number(process.env.VISUAL_VERIFY_BOOT_TIMEOUT_MS) || 90_000;

/**
 * Whether visual verification applies to this project.
 */
export function isFrontendProject(projectInfo) {
  return FRONTEND_TYPES.has(projectInfo?.type);
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    try {
      return await import("playwright-core");
    } catch {
      return null;
    }
  }
}

function detectDevCommand(repoPath) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(repoPath, "package.json"), "utf8"));
    const scripts = pkg.scripts || {};
    if (scripts.dev) return ["run", "dev"];
    if (scripts.start) return ["run", "start"];
  } catch (_) {}
  return null;
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.status < 500) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

/**
 * Boot the dev server, screenshot configured paths, and return
 * { screenshots: [{ file, route }], markdown } or null when skipped.
 * Screenshot files land in <repoPath>/.autoship/screenshots/.
 */
export async function captureScreenshots({ repoPath, projectInfo, taskId }) {
  if (!isFrontendProject(projectInfo)) return null;

  const playwright = await loadPlaywright();
  if (!playwright) {
    logger.info({ taskId }, "Visual verification skipped — playwright not installed");
    return null;
  }

  const devArgs = detectDevCommand(repoPath);
  if (!devArgs) {
    logger.info({ taskId }, "Visual verification skipped — no dev/start script");
    return null;
  }

  const routes = config.getList("visualVerificationRoutes");
  const paths = routes.length > 0 ? routes : ["/"];
  const baseUrl = `http://localhost:${DEV_PORT}`;

  logger.info({ taskId, devArgs, port: DEV_PORT, paths }, "Visual verification: booting dev server");

  const devProc = spawn("npm", devArgs, {
    cwd: repoPath,
    shell: false,
    detached: true, // own process group so the whole tree can be killed
    env: { ...process.env, PORT: String(DEV_PORT), BROWSER: "none", CI: "true" },
    stdio: "ignore",
  });

  const killDevServer = () => {
    try {
      process.kill(-devProc.pid, "SIGTERM"); // negative pid = process group
    } catch (_) {
      try { devProc.kill("SIGTERM"); } catch (_) {}
    }
  };

  let browser = null;
  try {
    const up = await waitForServer(baseUrl, BOOT_TIMEOUT_MS);
    if (!up) {
      logger.warn({ taskId, baseUrl }, "Visual verification: dev server did not come up in time");
      return null;
    }

    const outDir = path.join(repoPath, ".autoship", "screenshots");
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    browser = await playwright.chromium.launch({
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    const screenshots = [];
    for (const route of paths) {
      try {
        await page.goto(`${baseUrl}${route.startsWith("/") ? route : `/${route}`}`, {
          waitUntil: "networkidle",
          timeout: 30_000,
        });
        const name = `${route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home"}.png`;
        const file = path.join(outDir, name);
        await page.screenshot({ path: file, fullPage: false });
        screenshots.push({ file: path.relative(repoPath, file), route });
      } catch (err) {
        logger.warn({ taskId, route, err: err.message }, "Visual verification: route screenshot failed");
      }
    }

    return screenshots.length > 0 ? { screenshots } : null;
  } catch (err) {
    logger.warn({ taskId, err: err.message }, "Visual verification failed (non-fatal)");
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
    killDevServer();
  }
}

/**
 * PR-body markdown embedding the screenshots via raw.githubusercontent URLs
 * (the files are committed to the PR branch).
 */
export function formatScreenshotsMarkdown(screenshots, repoFullName, branchName) {
  if (!screenshots || screenshots.length === 0) return "";
  const lines = ["## Visual Verification", "Screenshots captured from the dev server after implementation:", ""];
  for (const shot of screenshots) {
    const rawUrl = `https://raw.githubusercontent.com/${repoFullName}/${branchName}/${shot.file}`;
    lines.push(`### \`${shot.route}\``, `![${shot.route}](${rawUrl})`, "");
  }
  return lines.join("\n");
}
