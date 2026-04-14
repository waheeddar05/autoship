// src/services/codebaseGraphService.js
// Semantic codebase graph: maps dependencies, call chains, and patterns.
// Provides richer context than flat file indexing for AI code generation.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";

// Cache graphs per repo (in-memory, 2-hour TTL)
const graphCache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000;

/**
 * Build or retrieve a semantic dependency graph for a repository.
 *
 * @param {string} repoPath - Absolute path to the repo
 * @param {string} projectType - From detectProjectType()
 * @returns {{ modules: Array, dependencies: Array, entryPoints: Array, patterns: object }}
 */
export async function buildCodebaseGraph(repoPath, projectType) {
  const cacheKey = repoPath;
  const cached = graphCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.graph;
  }

  try {
    let graph;
    if (projectType?.includes("spring") || projectType?.includes("kotlin")) {
      graph = await buildJvmGraph(repoPath, projectType);
    } else if (projectType?.includes("next") || projectType?.includes("react") || projectType?.includes("node")) {
      graph = await buildJsGraph(repoPath, projectType);
    } else {
      graph = await buildGenericGraph(repoPath);
    }

    graphCache.set(cacheKey, { graph, timestamp: Date.now() });
    logger.info({
      repoPath,
      projectType,
      modules: graph.modules.length,
      deps: graph.dependencies.length,
    }, "Codebase graph built");

    return graph;
  } catch (err) {
    logger.warn({ repoPath, err: err.message }, "Failed to build codebase graph");
    return { modules: [], dependencies: [], entryPoints: [], patterns: {} };
  }
}

/**
 * Format the graph into a context prompt section.
 */
export function formatGraphContext(graph) {
  if (!graph || graph.modules.length === 0) return "";

  const parts = ["\n## Codebase Dependency Graph"];

  // Entry points
  if (graph.entryPoints.length > 0) {
    parts.push("\n### Entry Points");
    for (const ep of graph.entryPoints.slice(0, 10)) {
      parts.push(`- ${ep.file}: ${ep.description}`);
    }
  }

  // Module summary
  parts.push("\n### Modules and Dependencies");
  const topModules = graph.modules.slice(0, 20);
  for (const mod of topModules) {
    const deps = graph.dependencies
      .filter(d => d.from === mod.file)
      .map(d => d.to)
      .slice(0, 5);
    const depStr = deps.length > 0 ? ` → imports [${deps.join(", ")}]` : "";
    parts.push(`- ${mod.file} (${mod.type})${depStr}`);
    if (mod.exports && mod.exports.length > 0) {
      parts.push(`  Exports: ${mod.exports.slice(0, 5).join(", ")}`);
    }
  }

  // Detected patterns
  if (graph.patterns && Object.keys(graph.patterns).length > 0) {
    parts.push("\n### Detected Patterns");
    for (const [pattern, details] of Object.entries(graph.patterns)) {
      parts.push(`- **${pattern}**: ${details}`);
    }
  }

  return parts.join("\n");
}

/**
 * Find which modules would be affected by changes to a given file.
 * Traces the reverse dependency tree.
 */
export function findAffectedModules(graph, targetFile) {
  const affected = new Set();
  const queue = [targetFile];

  while (queue.length > 0) {
    const current = queue.shift();
    const dependents = graph.dependencies
      .filter(d => d.to === current || d.to.endsWith(`/${current}`))
      .map(d => d.from);

    for (const dep of dependents) {
      if (!affected.has(dep)) {
        affected.add(dep);
        queue.push(dep);
      }
    }
  }

  return [...affected];
}

// ── JS/TS Graph Builder ──────────────────────────────────────────

async function buildJsGraph(repoPath, projectType) {
  const { globSync } = await import("glob");
  const modules = [];
  const dependencies = [];
  const entryPoints = [];
  const patterns = {};

  const files = globSync("**/*.{js,ts,jsx,tsx}", {
    cwd: repoPath,
    ignore: ["node_modules/**", "dist/**", "build/**", ".next/**", "coverage/**"],
  });

  for (const file of files) {
    const fullPath = path.join(repoPath, file);
    try {
      const content = readFileSync(fullPath, "utf-8");
      const mod = analyzeJsModule(file, content);
      modules.push(mod);

      // Extract imports
      const importRegex = /(?:import\s+.*?from\s+['"](.+?)['"]|require\(['"](.+?)['"]\))/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const imported = match[1] || match[2];
        if (imported.startsWith(".")) {
          const resolved = resolveRelativeImport(file, imported);
          dependencies.push({ from: file, to: resolved, type: "import" });
        }
      }

      // Detect entry points
      if (file.match(/^(src\/)?(index|main|app|server)\.(js|ts)$/)) {
        entryPoints.push({ file, description: "Application entry point" });
      }
      if (content.includes("app.listen") || content.includes("createServer")) {
        entryPoints.push({ file, description: "Server startup" });
      }
    } catch {
      // Skip files that can't be read
    }
  }

  // Detect patterns
  if (files.some(f => f.includes("/controllers/"))) patterns["MVC"] = "Controller/Service/Model pattern detected";
  if (files.some(f => f.includes("/middleware/"))) patterns["Middleware"] = "Express-style middleware pattern";
  if (files.some(f => f.includes("/hooks/"))) patterns["Custom Hooks"] = "React custom hooks pattern";
  if (files.some(f => f.match(/\.test\.|\.spec\./))) patterns["Testing"] = "Co-located test files";

  return { modules, dependencies, entryPoints, patterns };
}

function analyzeJsModule(file, content) {
  const exports = [];
  const exportRegex = /export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)/g;
  let match;
  while ((match = exportRegex.exec(content)) !== null) {
    exports.push(match[1]);
  }

  let type = "module";
  if (file.includes("/controllers/") || file.includes("/handlers/")) type = "controller";
  else if (file.includes("/services/")) type = "service";
  else if (file.includes("/models/") || file.includes("/entities/")) type = "model";
  else if (file.includes("/routes/")) type = "router";
  else if (file.includes("/middleware/")) type = "middleware";
  else if (file.includes("/components/")) type = "component";
  else if (file.match(/\.test\.|\.spec\./)) type = "test";

  return { file, type, exports, lines: content.split("\n").length };
}

// ── JVM Graph Builder ────────────────────────────────────────────

async function buildJvmGraph(repoPath, projectType) {
  const { globSync } = await import("glob");
  const modules = [];
  const dependencies = [];
  const entryPoints = [];
  const patterns = {};

  const ext = projectType?.includes("kotlin") ? "kt" : "java";
  const files = globSync(`**/*.${ext}`, {
    cwd: repoPath,
    ignore: ["build/**", "target/**", ".gradle/**"],
  });

  for (const file of files) {
    const fullPath = path.join(repoPath, file);
    try {
      const content = readFileSync(fullPath, "utf-8");
      const mod = analyzeJvmModule(file, content, ext);
      modules.push(mod);

      // Extract imports
      const importRegex = /import\s+([\w.]+)/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const imported = match[1];
        // Only track project-internal imports
        if (!imported.startsWith("java.") && !imported.startsWith("kotlin.") &&
            !imported.startsWith("org.springframework") && !imported.startsWith("javax.")) {
          dependencies.push({ from: file, to: imported, type: "import" });
        }
      }

      if (content.includes("@SpringBootApplication") || content.includes("fun main")) {
        entryPoints.push({ file, description: "Application entry point" });
      }
    } catch {
      // Skip
    }
  }

  // Detect patterns
  if (files.some(f => f.includes("Controller"))) patterns["Spring MVC"] = "Controller/Service/Repository layers";
  if (files.some(f => f.includes("Repository"))) patterns["Spring Data"] = "Repository pattern for data access";
  const hasFlywayDir = existsSync(path.join(repoPath, "src/main/resources/db/migration"));
  if (hasFlywayDir) patterns["Flyway"] = "Database migrations in db/migration";

  return { modules, dependencies, entryPoints, patterns };
}

function analyzeJvmModule(file, content, ext) {
  const exports = [];
  const classRegex = ext === "kt"
    ? /(?:class|object|interface|enum class)\s+(\w+)/g
    : /(?:class|interface|enum)\s+(\w+)/g;
  let match;
  while ((match = classRegex.exec(content)) !== null) {
    exports.push(match[1]);
  }

  let type = "class";
  if (file.includes("Controller") || content.includes("@RestController")) type = "controller";
  else if (file.includes("Service") || content.includes("@Service")) type = "service";
  else if (file.includes("Repository") || content.includes("@Repository")) type = "repository";
  else if (file.includes("Entity") || content.includes("@Entity")) type = "entity";
  else if (file.includes("Config") || content.includes("@Configuration")) type = "config";
  else if (file.includes("Test") || file.includes("Spec")) type = "test";

  return { file, type, exports, lines: content.split("\n").length };
}

// ── Generic Graph Builder ────────────────────────────────────────

async function buildGenericGraph(repoPath) {
  const { globSync } = await import("glob");
  const modules = [];
  const files = globSync("**/*.{py,go,rs,rb}", {
    cwd: repoPath,
    ignore: ["venv/**", "vendor/**", "target/**", "__pycache__/**", "node_modules/**"],
  });

  for (const file of files) {
    modules.push({ file, type: "module", exports: [], lines: 0 });
  }

  return { modules, dependencies: [], entryPoints: [], patterns: {} };
}

// ── Helpers ──────────────────────────────────────────────────────

function resolveRelativeImport(fromFile, importPath) {
  const dir = path.dirname(fromFile);
  let resolved = path.normalize(path.join(dir, importPath));
  // Remove leading ./
  resolved = resolved.replace(/^\.\//, "");
  // Add extension if missing
  if (!path.extname(resolved)) {
    resolved += ".js";
  }
  return resolved;
}

/**
 * Invalidate the cached graph for a repo.
 */
export function invalidateGraphCache(repoPath) {
  graphCache.delete(repoPath);
}
