// src/codebase-index.js
// Feature 7: Codebase Indexing & RAG
// Scans repos for key files and provides relevant context for Claude prompts.

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

const INDEX_STALE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Index a repository, scanning for controllers, services, models, configs.
 * Stores the index as .autoship/codebase-index.json in the repo.
 */
export function indexRepository(repoPath) {
  if (!repoPath || !existsSync(repoPath)) return null;

  const indexDir = path.join(repoPath, ".autoship");
  const indexFile = path.join(indexDir, "codebase-index.json");

  // Check if index is fresh
  if (existsSync(indexFile)) {
    try {
      const stat = statSync(indexFile);
      if (Date.now() - stat.mtimeMs < INDEX_STALE_MS) {
        return JSON.parse(readFileSync(indexFile, "utf-8"));
      }
    } catch {}
  }

  logger.info({ repoPath }, "Indexing repository...");

  const index = {
    controllers: [],
    services: [],
    models: [],
    configs: [],
    routes: [],
    components: [],
    indexedAt: new Date().toISOString(),
  };

  const files = _collectFiles(repoPath, 5);

  for (const file of files) {
    const relPath = path.relative(repoPath, file);
    const ext = path.extname(file).toLowerCase();

    try {
      const content = readFileSync(file, "utf-8");

      // Java / Kotlin annotations
      if (ext === ".java" || ext === ".kt") {
        const className = _extractClassName(content, ext);

        if (content.includes("@RestController") || content.includes("@Controller")) {
          const endpoints = _extractJavaEndpoints(content);
          index.controllers.push({ file: relPath, class: className, endpoints });
        }

        if (content.includes("@Service")) {
          index.services.push({ file: relPath, class: className, methods: _extractMethods(content, ext) });
        }

        if (content.includes("@Repository")) {
          index.services.push({ file: relPath, class: className, type: "repository" });
        }

        if (content.includes("@Entity") || content.includes("@Table")) {
          index.models.push({ file: relPath, class: className, type: "entity" });
        }
      }

      // JS / TS files
      if (ext === ".js" || ext === ".ts" || ext === ".tsx" || ext === ".jsx") {
        // API routes
        if (relPath.includes("/api/") || relPath.includes("/routes/") || content.match(/router\.(get|post|put|delete|patch)\(/)) {
          const endpoints = _extractJSEndpoints(content);
          if (endpoints.length > 0) {
            index.routes.push({ file: relPath, endpoints });
          }
        }

        // React components
        if ((ext === ".tsx" || ext === ".jsx") && (content.includes("export default") || content.includes("export function"))) {
          const componentName = _extractComponentName(content, relPath);
          if (componentName) {
            index.components.push({ file: relPath, name: componentName });
          }
        }

        // Database models
        if (relPath.includes("/model") || relPath.includes("/schema") || relPath.includes("/entity")) {
          index.models.push({ file: relPath, class: path.basename(file, ext), type: "model" });
        }
      }

      // Config files
      if (
        relPath.match(/\.(yml|yaml|properties|toml|env\.example)$/) ||
        relPath.includes("config") ||
        file.endsWith("tsconfig.json") ||
        file.endsWith("next.config")
      ) {
        index.configs.push({ file: relPath });
      }
    } catch {
      // Skip files that can't be read
    }
  }

  // Write index
  try {
    if (!existsSync(indexDir)) mkdirSync(indexDir, { recursive: true });
    writeFileSync(indexFile, JSON.stringify(index, null, 2));
    
    // Add .autoship to .gitignore if not there
    const gitignorePath = path.join(repoPath, ".gitignore");
    if (existsSync(gitignorePath)) {
      const gitignore = readFileSync(gitignorePath, "utf-8");
      if (!gitignore.includes(".autoship")) {
        writeFileSync(gitignorePath, gitignore.trimEnd() + "\n.autoship/\n");
      }
    }
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to write codebase index");
  }

  logger.info({
    controllers: index.controllers.length,
    services: index.services.length,
    models: index.models.length,
    routes: index.routes.length,
  }, "Repository indexed");

  return index;
}

/**
 * Get relevant context files based on task description keyword matching.
 */
export function getRelevantContext(index, taskDescription, maxTokens = 4000) {
  if (!index || !taskDescription) return "";

  const keywords = taskDescription
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  // Score each indexed file by keyword relevance
  const scored = [];
  const allItems = [
    ...index.controllers.map((c) => ({ ...c, category: "controller" })),
    ...index.services.map((s) => ({ ...s, category: "service" })),
    ...index.models.map((m) => ({ ...m, category: "model" })),
    ...index.routes.map((r) => ({ ...r, category: "route" })),
    ...index.components.map((c) => ({ ...c, category: "component" })),
  ];

  for (const item of allItems) {
    const fileStr = (item.file + " " + (item.class || item.name || "")).toLowerCase();
    const endpointStr = (item.endpoints || []).map((e) => e.path || e.method || "").join(" ").toLowerCase();
    const searchStr = fileStr + " " + endpointStr;

    let score = 0;
    for (const kw of keywords) {
      if (searchStr.includes(kw)) score += 2;
      // Partial match
      if (searchStr.split(/[\s\/.-]/).some((part) => part.startsWith(kw))) score += 1;
    }

    if (score > 0) {
      scored.push({ ...item, score });
    }
  }

  // Sort by score, take top N
  scored.sort((a, b) => b.score - a.score);

  const contextParts = [];
  let totalChars = 0;
  const approxCharsPerToken = 4;
  const maxChars = maxTokens * approxCharsPerToken;

  for (const item of scored.slice(0, 10)) {
    const header = `### ${item.category}: ${item.file}${item.class ? ` (${item.class})` : ""}`;
    let detail = "";

    if (item.endpoints && item.endpoints.length > 0) {
      detail = item.endpoints.map((e) => `  ${e.method || "?"} ${e.path || ""}`).join("\n");
    }

    const block = header + (detail ? "\n" + detail : "");
    if (totalChars + block.length > maxChars) break;

    contextParts.push(block);
    totalChars += block.length;
  }

  if (contextParts.length === 0) return "";

  return "## Relevant Codebase Context\n" + contextParts.join("\n\n");
}

/**
 * Get a summary of the codebase index for debate agents.
 */
export function getIndexSummary(index) {
  if (!index) return "No codebase index available.";

  const lines = ["## Codebase Summary"];

  if (index.controllers.length > 0) {
    lines.push(`- **Controllers**: ${index.controllers.map((c) => c.class || c.file).join(", ")}`);
  }
  if (index.services.length > 0) {
    lines.push(`- **Services**: ${index.services.map((s) => s.class || s.file).join(", ")}`);
  }
  if (index.models.length > 0) {
    lines.push(`- **Models/Entities**: ${index.models.map((m) => m.class || m.file).join(", ")}`);
  }
  if (index.routes.length > 0) {
    lines.push(`- **API Routes**: ${index.routes.length} route files`);
  }
  if (index.components.length > 0) {
    lines.push(`- **Components**: ${index.components.length} React components`);
  }

  return lines.join("\n");
}

// ── Internal helpers ────────────────────────────────────────────

function _collectFiles(dir, maxDepth, depth = 0) {
  if (depth >= maxDepth) return [];

  const skipDirs = new Set([
    "node_modules", ".git", ".next", "dist", "build", "target",
    ".idea", ".vscode", "__pycache__", ".gradle", ".mvn", ".autoship",
    "vendor", "coverage",
  ]);

  let entries;
  try { entries = readdirSync(dir); } catch { return []; }

  const files = [];
  for (const entry of entries) {
    if (skipDirs.has(entry)) continue;
    const full = path.join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }

    if (stat.isDirectory()) {
      files.push(..._collectFiles(full, maxDepth, depth + 1));
    } else if (stat.isFile() && stat.size < 100_000) {
      const ext = path.extname(entry).toLowerCase();
      if ([".java", ".kt", ".js", ".ts", ".tsx", ".jsx", ".yml", ".yaml", ".properties", ".toml"].includes(ext)) {
        files.push(full);
      }
    }
  }
  return files;
}

function _extractClassName(content, ext) {
  const pattern = ext === ".kt"
    ? /class\s+(\w+)/
    : /(?:public\s+)?class\s+(\w+)/;
  const match = content.match(pattern);
  return match ? match[1] : null;
}

function _extractJavaEndpoints(content) {
  const endpoints = [];
  const mappings = content.matchAll(/@(?:Get|Post|Put|Delete|Patch|Request)Mapping\((?:[^)]*value\s*=\s*)?["']([^"']*)/g);
  for (const m of mappings) {
    const method = m[0].includes("Get") ? "GET" :
                   m[0].includes("Post") ? "POST" :
                   m[0].includes("Put") ? "PUT" :
                   m[0].includes("Delete") ? "DELETE" :
                   m[0].includes("Patch") ? "PATCH" : "REQUEST";
    endpoints.push({ method, path: m[1] });
  }
  return endpoints;
}

function _extractJSEndpoints(content) {
  const endpoints = [];
  const routePatterns = content.matchAll(/(?:router|app)\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)/g);
  for (const m of routePatterns) {
    endpoints.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  return endpoints;
}

function _extractMethods(content, ext) {
  const methods = [];
  const pattern = ext === ".kt"
    ? /fun\s+(\w+)\s*\(/g
    : /(?:public|private|protected)?\s+\w+\s+(\w+)\s*\(/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    methods.push(match[1]);
  }
  return methods.slice(0, 20); // Cap at 20
}

function _extractComponentName(content, relPath) {
  const match = content.match(/export\s+(?:default\s+)?function\s+(\w+)/);
  if (match) return match[1];
  // Fallback to filename
  return path.basename(relPath, path.extname(relPath));
}
