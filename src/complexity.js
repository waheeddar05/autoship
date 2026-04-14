// src/complexity.js
// Feature 16: Task Complexity Scoring
// Scores tasks based on description, codebase index, and debate results.

import { logger } from "./logger.js";

const COMPLEXITY_KEYWORDS = {
  migration: { weight: 8, category: "infrastructure" },
  refactor: { weight: 7, category: "scope" },
  security: { weight: 8, category: "risk" },
  performance: { weight: 6, category: "scope" },
  authentication: { weight: 7, category: "risk" },
  authorization: { weight: 7, category: "risk" },
  database: { weight: 6, category: "infrastructure" },
  "breaking change": { weight: 9, category: "risk" },
  api: { weight: 4, category: "scope" },
  integration: { weight: 6, category: "scope" },
  "ci/cd": { weight: 4, category: "infrastructure" },
  deployment: { weight: 4, category: "infrastructure" },
  microservice: { weight: 7, category: "scope" },
  "real-time": { weight: 6, category: "scope" },
  caching: { weight: 4, category: "scope" },
  testing: { weight: 3, category: "quality" },
  "error handling": { weight: 3, category: "quality" },
};

/**
 * Score the complexity of a task.
 * @param {string} taskDescription 
 * @param {object|null} repoIndex - Codebase index from indexRepository()
 * @param {object|null} debateResult - Debate session result
 * @returns {{ score, level, estimatedFiles, estimatedTime, factors }}
 */
export function scoreComplexity(taskDescription, repoIndex = null, debateResult = null) {
  const factors = [];
  let totalScore = 0;

  if (!taskDescription) {
    return {
      score: 10,
      level: "simple",
      estimatedFiles: 1,
      estimatedTime: "< 30 min",
      factors: [{ name: "No description", weight: 1, value: 10 }],
    };
  }

  const desc = taskDescription.toLowerCase();

  // Factor 1: Description length (longer = more complex)
  const wordCount = desc.split(/\s+/).length;
  const lengthScore = Math.min(Math.round(wordCount / 10), 15);
  factors.push({ name: "Description length", weight: 0.3, value: lengthScore });
  totalScore += lengthScore * 0.3;

  // Factor 2: Keywords
  let keywordScore = 0;
  const matchedKeywords = [];
  for (const [keyword, info] of Object.entries(COMPLEXITY_KEYWORDS)) {
    if (desc.includes(keyword)) {
      keywordScore += info.weight;
      matchedKeywords.push(keyword);
    }
  }
  keywordScore = Math.min(keywordScore, 30);
  factors.push({ name: "Complexity keywords", weight: 1, value: keywordScore, matched: matchedKeywords });
  totalScore += keywordScore;

  // Factor 3: Estimated files affected (from codebase index)
  let estimatedFiles = 1;
  if (repoIndex) {
    const allFiles = [
      ...(repoIndex.controllers || []),
      ...(repoIndex.services || []),
      ...(repoIndex.models || []),
      ...(repoIndex.routes || []),
      ...(repoIndex.components || []),
    ];

    const descWords = desc.split(/\s+/).filter((w) => w.length > 3);
    let matchedFiles = 0;
    for (const item of allFiles) {
      const itemStr = ((item.file || "") + " " + (item.class || "") + " " + (item.name || "")).toLowerCase();
      for (const word of descWords) {
        if (itemStr.includes(word)) {
          matchedFiles++;
          break;
        }
      }
    }

    estimatedFiles = Math.max(matchedFiles, 1);
    const filesScore = Math.min(matchedFiles * 3, 20);
    factors.push({ name: "Estimated files affected", weight: 0.8, value: filesScore, files: estimatedFiles });
    totalScore += filesScore * 0.8;
  }

  // Factor 4: Number of services/components mentioned
  const servicePatterns = /(?:service|controller|api|endpoint|component|module|page|screen|view)/gi;
  const serviceMatches = (desc.match(servicePatterns) || []).length;
  const serviceScore = Math.min(serviceMatches * 3, 10);
  factors.push({ name: "Services/components mentioned", weight: 0.5, value: serviceScore, count: serviceMatches });
  totalScore += serviceScore * 0.5;

  // Factor 5: Debate risk assessment
  if (debateResult && debateResult.final_plan) {
    const plan = debateResult.final_plan.toLowerCase();
    let riskScore = 0;

    if (plan.includes("risk") || plan.includes("careful") || plan.includes("caution")) riskScore += 5;
    if (plan.includes("complex") || plan.includes("complicated")) riskScore += 5;
    if (plan.includes("multiple") || plan.includes("several")) riskScore += 3;

    riskScore = Math.min(riskScore, 15);
    factors.push({ name: "Debate risk assessment", weight: 1, value: riskScore });
    totalScore += riskScore;
  }

  // Normalize score to 1-100
  const score = Math.max(1, Math.min(100, Math.round(totalScore)));

  // Determine level
  let level;
  if (score <= 20) level = "simple";
  else if (score <= 60) level = "medium";
  else if (score <= 85) level = "complex";
  else level = "critical";

  // Estimate time
  let estimatedTime;
  if (level === "simple") estimatedTime = "< 30 min";
  else if (level === "medium") estimatedTime = "30 min - 2 hrs";
  else if (level === "complex") estimatedTime = "2 - 6 hrs";
  else estimatedTime = "6+ hrs";

  logger.debug({ score, level, estimatedFiles, factors: factors.length }, "Complexity scored");

  return { score, level, estimatedFiles, estimatedTime, factors };
}

/**
 * Get a Claude timeout based on complexity level.
 */
export function getTimeoutForComplexity(level, defaultTimeout) {
  switch (level) {
    case "simple": return Math.min(defaultTimeout, 600_000); // 10 min max
    case "medium": return defaultTimeout; // use configured default
    case "complex": return Math.max(defaultTimeout, 2_700_000); // at least 45 min
    case "critical": return Math.max(defaultTimeout, 3_600_000); // at least 60 min
    default: return defaultTimeout;
  }
}
