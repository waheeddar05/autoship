// src/services/testRunnerService.js
// Run project test suites and report results.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import { detectProjectType } from "../project-context.js";

const TEST_TIMEOUT = Number(process.env.TEST_TIMEOUT_MS) || 300_000; // 5 minutes

/**
 * Determine the appropriate test command for a project.
 *
 * @param {string} repoPath - Path to the local repo clone
 * @returns {{ cmd: string, args: string[], label: string } | null}
 */
export function detectTestCommand(repoPath) {
  const projectInfo = detectProjectType(repoPath);

  if (projectInfo.buildTool === "maven") {
    return { cmd: "mvn", args: ["test", "-B", "--fail-at-end"], label: "mvn test" };
  }
  if (projectInfo.buildTool === "gradle") {
    const wrapper = existsSync(path.join(repoPath, "gradlew")) ? "./gradlew" : "gradle";
    return { cmd: wrapper, args: ["test"], label: "gradle test" };
  }
  if (projectInfo.buildTool === "yarn") {
    return { cmd: "yarn", args: ["test", "--passWithNoTests"], label: "yarn test" };
  }
  if (projectInfo.buildTool === "npm") {
    // Check if test script exists in package.json
    try {
      const pkgPath = path.join(repoPath, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
          return { cmd: "npm", args: ["test", "--", "--passWithNoTests"], label: "npm test" };
        }
      }
    } catch (_) {}
    return { cmd: "npm", args: ["test", "--", "--passWithNoTests"], label: "npm test" };
  }

  // Python
  if (existsSync(path.join(repoPath, "pytest.ini")) ||
      existsSync(path.join(repoPath, "setup.py")) ||
      existsSync(path.join(repoPath, "pyproject.toml"))) {
    return { cmd: "python", args: ["-m", "pytest", "-v", "--tb=short"], label: "pytest" };
  }

  return null;
}

/**
 * Run tests and return structured results.
 *
 * @param {string} repoPath - Path to the local repo clone
 * @returns {{ passed: boolean, output: string, summary: string, duration: number }}
 */
export async function runTests(repoPath) {
  const testCmd = detectTestCommand(repoPath);

  if (!testCmd) {
    logger.info({ repoPath }, "No test command detected, skipping tests");
    return { passed: true, output: "", summary: "No test suite detected — skipped.", duration: 0 };
  }

  logger.info({ repoPath, cmd: testCmd.label }, "Running test suite");
  const start = Date.now();

  try {
    const output = await executeTestCommand(testCmd.cmd, testCmd.args, repoPath);
    const duration = Date.now() - start;
    const summary = parseTestSummary(output, testCmd.label);

    logger.info({ repoPath, cmd: testCmd.label, duration, passed: true }, "Tests passed");
    return { passed: true, output, summary, duration };
  } catch (err) {
    const duration = Date.now() - start;
    const output = err.output || err.message;
    const summary = parseTestSummary(output, testCmd.label);

    logger.warn({ repoPath, cmd: testCmd.label, duration, passed: false }, "Tests failed");
    return { passed: false, output, summary, duration };
  }
}

/**
 * Execute a test command and return stdout.
 * Rejects if the command exits with non-zero code.
 */
function executeTestCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      shell: true,
      env: { ...process.env, CI: "true" },
      timeout: TEST_TIMEOUT,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (code !== 0) {
        const err = new Error(`Tests failed with exit code ${code}`);
        err.output = stdout + "\n" + stderr;
        reject(err);
      } else {
        resolve(stdout + "\n" + stderr);
      }
    });

    proc.on("error", (err) => {
      err.output = stdout + "\n" + stderr;
      reject(err);
    });
  });
}

/**
 * Parse test output to extract a human-readable summary.
 */
function parseTestSummary(output, label) {
  if (!output) return `${label}: No output captured.`;

  const lines = output.split("\n").filter(Boolean);

  // Jest / npm test patterns
  const jestMatch = output.match(
    /Tests:\s+(\d+)\s+failed,?\s*(\d+)\s+passed|Tests:\s+(\d+)\s+passed/
  );
  if (jestMatch) {
    return jestMatch[0];
  }

  // pytest patterns
  const pytestMatch = output.match(
    /(\d+)\s+passed(?:,\s+(\d+)\s+failed)?|FAILED.*(\d+)\s+failed/
  );
  if (pytestMatch) {
    return pytestMatch[0];
  }

  // Maven patterns
  const mvnMatch = output.match(
    /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)/
  );
  if (mvnMatch) {
    return mvnMatch[0];
  }

  // Gradle patterns
  const gradleMatch = output.match(
    /(\d+)\s+tests?\s+completed,\s+(\d+)\s+failed/
  );
  if (gradleMatch) {
    return gradleMatch[0];
  }

  // Fallback: last few meaningful lines
  const lastLines = lines
    .slice(-5)
    .filter((l) => l.trim().length > 0)
    .join("\n");
  return lastLines.substring(0, 300) || `${label}: completed.`;
}
