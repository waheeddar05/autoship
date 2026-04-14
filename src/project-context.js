// src/project-context.js
// Feature 3: Spring Boot / Java / Project Awareness
// Detects project type and generates context prompts for Claude Code.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

/**
 * Detect the project type by scanning for build files and framework indicators.
 */
export function detectProjectType(repoPath) {
  const result = {
    type: "unknown",
    buildTool: null,
    hasDocker: false,
    hasFlyway: false,
    hasLiquibase: false,
    frameworks: [],
  };

  if (!repoPath || !existsSync(repoPath)) return result;

  const exists = (f) => existsSync(path.join(repoPath, f));
  const readSafe = (f) => {
    try { return readFileSync(path.join(repoPath, f), "utf-8"); } catch { return ""; }
  };

  // Docker
  result.hasDocker = exists("Dockerfile") || exists("docker-compose.yml") || exists("docker-compose.yaml");

  // Flyway / Liquibase
  result.hasFlyway = exists("src/main/resources/db/migration") || exists("flyway.conf");
  result.hasLiquibase = exists("src/main/resources/db/changelog") || exists("liquibase.properties");

  // Java / Spring Boot / Kotlin
  if (exists("pom.xml")) {
    result.buildTool = "maven";
    const pom = readSafe("pom.xml");
    if (pom.includes("spring-boot")) {
      result.frameworks.push("spring-boot");
      if (pom.includes("kotlin") || exists("src/main/kotlin")) {
        result.type = "kotlin-spring";
        result.frameworks.push("kotlin");
      } else {
        result.type = "spring-boot";
      }
    } else {
      result.type = exists("src/main/kotlin") ? "kotlin-spring" : "spring-boot";
    }
  } else if (exists("build.gradle") || exists("build.gradle.kts")) {
    result.buildTool = "gradle";
    const gradle = readSafe("build.gradle") || readSafe("build.gradle.kts");
    if (gradle.includes("spring-boot") || gradle.includes("org.springframework")) {
      result.frameworks.push("spring-boot");
      if (gradle.includes("kotlin") || exists("src/main/kotlin")) {
        result.type = "kotlin-spring";
        result.frameworks.push("kotlin");
      } else {
        result.type = "spring-boot";
      }
    }
  }

  // Node.js / JS / TS projects
  if (exists("package.json")) {
    const pkg = readSafe("package.json");
    let pkgJson = {};
    try { pkgJson = JSON.parse(pkg); } catch {}

    const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };

    if (!result.buildTool) {
      result.buildTool = exists("yarn.lock") ? "yarn" : "npm";
    }

    if (allDeps["next"]) {
      result.type = "nextjs";
      result.frameworks.push("nextjs");
      if (exists("app") || exists("src/app")) result.frameworks.push("app-router");
      if (exists("pages") || exists("src/pages")) result.frameworks.push("pages-router");
    } else if (allDeps["react"]) {
      result.type = "react";
      result.frameworks.push("react");
    } else if (result.type === "unknown") {
      result.type = "node";
    }

    if (allDeps["express"]) result.frameworks.push("express");
    if (allDeps["nestjs"] || allDeps["@nestjs/core"]) result.frameworks.push("nestjs");
    if (allDeps["prisma"] || allDeps["@prisma/client"]) result.frameworks.push("prisma");
    if (allDeps["typeorm"]) result.frameworks.push("typeorm");
    if (allDeps["sequelize"]) result.frameworks.push("sequelize");
    if (allDeps["typescript"]) result.frameworks.push("typescript");
  }

  return result;
}

/**
 * Generate a context prompt block to prepend to Claude Code prompts.
 */
export function generateContextPrompt(projectInfo, repoPath) {
  const lines = [];

  // Include CLAUDE.md if it exists
  const claudeMdPath = path.join(repoPath, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    try {
      const content = readFileSync(claudeMdPath, "utf-8").trim();
      lines.push("## Project Instructions (from CLAUDE.md)");
      lines.push(content);
      lines.push("");
    } catch {}
  }

  // Project type context
  lines.push("## Project Context");

  switch (projectInfo.type) {
    case "spring-boot":
      lines.push(`This is a Spring Boot project using ${projectInfo.buildTool === "maven" ? "Maven" : "Gradle"}.`);
      lines.push("Follow these conventions:");
      lines.push("- REST controllers in src/main/java/**/controller/ with @RestController");
      lines.push("- Service layer in src/main/java/**/service/ with @Service");
      lines.push("- Repository layer in src/main/java/**/repository/ with @Repository");
      lines.push("- DTOs in src/main/java/**/dto/");
      lines.push("- Entity classes with @Entity in src/main/java/**/model/ or **/entity/");
      if (projectInfo.hasFlyway) {
        lines.push("- Database migrations: Flyway migrations in src/main/resources/db/migration/");
        lines.push("  Use V{timestamp}__{description}.sql naming convention");
      }
      if (projectInfo.hasLiquibase) {
        lines.push("- Database migrations: Liquibase changelogs in src/main/resources/db/changelog/");
      }
      lines.push("- Configuration in src/main/resources/application.yml or application.properties");
      lines.push("- Tests in src/test/java/ following same package structure");
      break;

    case "kotlin-spring":
      lines.push(`This is a **Kotlin** Spring Boot project using ${projectInfo.buildTool === "maven" ? "Maven" : "Gradle"}.`);
      lines.push("**CRITICAL — Language & Path Rules:**");
      lines.push("- ALL source files use the `.kt` extension — NEVER `.java`");
      lines.push("- Source root is `src/main/kotlin/` — NEVER `src/main/java/`");
      lines.push("- Test root is `src/test/kotlin/` — NEVER `src/test/java/`");
      lines.push("");
      lines.push("Follow Kotlin + Spring conventions:");
      lines.push("- REST controllers in src/main/kotlin/**/controller/ with @RestController");
      lines.push("- Service layer in src/main/kotlin/**/service/ with @Service");
      lines.push("- Repository layer in src/main/kotlin/**/repository/ with @Repository");
      lines.push("- DTOs and request/response models as Kotlin data classes in src/main/kotlin/**/dto/");
      lines.push("- Entity classes with @Entity in src/main/kotlin/**/model/ or **/entity/");
      lines.push("- Use data classes for DTOs and request/response models");
      lines.push("- Prefer val over var, use immutable collections where possible");
      lines.push("- Use extension functions for utility methods");
      lines.push("- Use Kotlin coroutines for async operations where applicable");
      lines.push("- Configuration in src/main/resources/application.yml or application.properties");
      lines.push("- Tests in src/test/kotlin/ following same package structure");
      if (projectInfo.hasFlyway) {
        lines.push("- Flyway migrations in src/main/resources/db/migration/");
      }
      if (projectInfo.hasLiquibase) {
        lines.push("- Liquibase changelogs in src/main/resources/db/changelog/");
      }
      break;

    case "nextjs":
      lines.push("This is a Next.js project.");
      if (projectInfo.frameworks.includes("app-router")) {
        lines.push("Follow App Router patterns:");
        lines.push("- Pages in app/ directory with page.tsx files");
        lines.push("- Layouts in layout.tsx, loading states in loading.tsx");
        lines.push("- Server Components by default, use 'use client' directive for client components");
        lines.push("- API routes in app/api/ with route.ts files");
        lines.push("- Use server actions for form mutations");
      }
      if (projectInfo.frameworks.includes("pages-router")) {
        lines.push("Uses Pages Router: pages in pages/ directory");
      }
      break;

    case "react":
      lines.push("This is a React project.");
      lines.push("- Use functional components with hooks");
      lines.push("- Follow component composition patterns");
      break;

    case "node":
      lines.push("This is a Node.js project.");
      if (projectInfo.frameworks.includes("express")) lines.push("- Uses Express.js for HTTP server");
      if (projectInfo.frameworks.includes("nestjs")) lines.push("- Uses NestJS framework — follow module/controller/service patterns");
      break;

    default:
      lines.push("Project type could not be automatically determined.");
  }

  if (projectInfo.frameworks.includes("prisma")) lines.push("- Uses Prisma ORM — update schema.prisma for DB changes");
  if (projectInfo.frameworks.includes("typeorm")) lines.push("- Uses TypeORM — create migrations for schema changes");
  if (projectInfo.frameworks.includes("typescript")) lines.push("- TypeScript project — ensure proper typing");
  if (projectInfo.hasDocker) lines.push("- Has Docker configuration — ensure changes work in containerized environment");

  // Repo structure summary
  const structure = getRepoStructureSummary(repoPath);
  if (structure) {
    lines.push("");
    lines.push("## Repository Structure");
    lines.push("```");
    lines.push(structure);
    lines.push("```");
  }

  return lines.join("\n");
}

/**
 * Get a tree summary of src/ directories, max 3 levels deep.
 */
export function getRepoStructureSummary(repoPath) {
  const srcDir = path.join(repoPath, "src");
  if (!existsSync(srcDir)) {
    // Try root level for projects without src/
    return _buildTree(repoPath, 0, 2, true);
  }
  return _buildTree(srcDir, 0, 3, false);
}

function _buildTree(dir, depth, maxDepth, skipNodeModules) {
  if (depth >= maxDepth) return "";
  
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return "";
  }

  const lines = [];
  const indent = "  ".repeat(depth);
  const skipDirs = new Set([
    "node_modules", ".git", ".next", "dist", "build", "target",
    ".idea", ".vscode", "__pycache__", ".gradle", ".mvn",
  ]);

  for (const entry of entries.sort()) {
    if (entry.startsWith(".") && depth === 0 && skipNodeModules) continue;
    if (skipDirs.has(entry)) continue;

    const fullPath = path.join(dir, entry);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }

    if (stat.isDirectory()) {
      lines.push(`${indent}${entry}/`);
      const sub = _buildTree(fullPath, depth + 1, maxDepth, skipNodeModules);
      if (sub) lines.push(sub);
    } else if (depth < 2) {
      // Only show files at shallow depth
      lines.push(`${indent}${entry}`);
    }
  }

  return lines.join("\n");
}
