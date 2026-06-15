// src/weekly-digest.js
// Feature 17: Weekly Digest
// Generates and schedules weekly summary reports via Slack.

import cron from "node-cron";
import { pool } from "./db.js";
import { config } from "./config-manager.js";
import { logger } from "./logger.js";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

/**
 * Generate a weekly digest covering the last 7 days.
 */
export async function generateWeeklyDigest() {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    // Current week stats
    const { rows: weekStats } = await pool.query(
      `SELECT 
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE state = 'success')::int as success,
        COUNT(*) FILTER (WHERE state = 'failed')::int as failed,
        AVG(duration_ms) FILTER (WHERE state = 'success')::float as avg_duration
       FROM tasks
       WHERE completed_at >= $1`,
      [sevenDaysAgo]
    );

    // Previous week stats (for comparison)
    const { rows: prevWeekStats } = await pool.query(
      `SELECT 
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE state = 'success')::int as success,
        COUNT(*) FILTER (WHERE state = 'failed')::int as failed
       FROM tasks
       WHERE completed_at >= $1 AND completed_at < $2`,
      [fourteenDaysAgo, sevenDaysAgo]
    );

    const current = weekStats[0] || { total: 0, success: 0, failed: 0, avg_duration: 0 };
    const previous = prevWeekStats[0] || { total: 0, success: 0, failed: 0 };

    // Cost data
    const { rows: costRows } = await pool.query(
      `SELECT COALESCE(SUM(tc.estimated_cost), 0)::float as total_cost
       FROM task_costs tc
       JOIN tasks t ON t.id = tc.task_id
       WHERE t.completed_at >= $1`,
      [sevenDaysAgo]
    );
    const totalCost = costRows[0]?.total_cost || 0;

    // ROI estimation
    const devRate = config.get("developerHourlyRate") || 50;
    const simpleHours = config.get("simpleTaskHours") || 2;
    const mediumHours = config.get("mediumTaskHours") || 4;
    const complexHours = config.get("complexTaskHours") || 8;

    const { rows: complexityRows } = await pool.query(
      `SELECT complexity_level, COUNT(*)::int as count
       FROM tasks
       WHERE completed_at >= $1 AND state = 'success' AND complexity_level IS NOT NULL
       GROUP BY complexity_level`,
      [sevenDaysAgo]
    );

    let hoursSaved = 0;
    for (const row of complexityRows) {
      switch (row.complexity_level) {
        case "simple": hoursSaved += row.count * simpleHours; break;
        case "medium": hoursSaved += row.count * mediumHours; break;
        case "complex": hoursSaved += row.count * complexHours; break;
        case "critical": hoursSaved += row.count * complexHours * 1.5; break;
        default: hoursSaved += row.count * mediumHours;
      }
    }

    // If no complexity data, estimate based on count
    if (hoursSaved === 0 && current.success > 0) {
      hoursSaved = current.success * mediumHours;
    }

    const costSaved = hoursSaved * devRate - totalCost;
    const roi = totalCost > 0 ? Math.round((costSaved / totalCost) * 100) : 0;

    // Top repos
    const { rows: topRepos } = await pool.query(
      `SELECT repo_name, COUNT(*)::int as count
       FROM tasks
       WHERE completed_at >= $1 AND repo_name IS NOT NULL
       GROUP BY repo_name
       ORDER BY count DESC
       LIMIT 5`,
      [sevenDaysAgo]
    );

    // Failed tasks needing attention
    const { rows: failedTasks } = await pool.query(
      `SELECT id, name, clickup_task_id, error_message, repo_name
       FROM tasks
       WHERE completed_at >= $1 AND state = 'failed'
       ORDER BY completed_at DESC
       LIMIT 5`,
      [sevenDaysAgo]
    );

    // Per-user task completion leaderboard
    const { rows: userStats } = await pool.query(
      `SELECT
        ae.value->>'id' AS clickup_user_id,
        COALESCE(ae.value->>'username', ae.value->>'name', 'Unknown') AS username,
        COUNT(*) FILTER (WHERE t.state = 'success')::int AS completed,
        COUNT(*)::int AS total
       FROM tasks t, jsonb_array_elements(t.assignees) ae(value)
       WHERE t.completed_at >= $1 AND ae.value->>'id' IS NOT NULL
       GROUP BY ae.value->>'id', ae.value->>'username', ae.value->>'name'
       ORDER BY completed DESC
       LIMIT 10`,
      [sevenDaysAgo]
    );

    // Determine top contributor
    const topContributor = userStats.length > 0 ? userStats[0] : null;

    // Trend comparison
    const taskDelta = current.total - previous.total;
    const trendEmoji = taskDelta > 0 ? "📈" : taskDelta < 0 ? "📉" : "➡️";
    const successRate = current.total > 0 ? Math.round((current.success / current.total) * 100) : 0;

    // Build Slack Block Kit message
    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: "📊 AutoShip Weekly Digest", emoji: true },
      },
      { type: "divider" },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Tasks Completed*\n${current.success} ✅` },
          { type: "mrkdwn", text: `*Tasks Failed*\n${current.failed} ❌` },
          { type: "mrkdwn", text: `*Success Rate*\n${successRate}%` },
          { type: "mrkdwn", text: `*Avg Duration*\n${_formatDuration(current.avg_duration)}` },
        ],
      },
      { type: "divider" },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*💰 Cost*\n$${totalCost.toFixed(2)} spent` },
          { type: "mrkdwn", text: `*💵 Savings*\n$${costSaved.toFixed(0)} saved (ROI: ${roi}%)` },
          { type: "mrkdwn", text: `*⏱️ Dev Time Saved*\n${hoursSaved >= 8 ? '~' + (hoursSaved / 8).toFixed(1) + ' days' : hoursSaved.toFixed(1) + ' hrs'}` },
          { type: "mrkdwn", text: `*${trendEmoji} vs Last Week*\n${taskDelta >= 0 ? "+" : ""}${taskDelta} tasks` },
        ],
      },
    ];

    // Top repos section
    if (topRepos.length > 0) {
      blocks.push({ type: "divider" });
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Top Repos by Activity*\n" +
            topRepos.map((r, i) => `${i + 1}. \`${r.repo_name}\` — ${r.count} tasks`).join("\n"),
        },
      });
    }

    // Per-user leaderboard
    if (userStats.length > 0) {
      blocks.push({ type: "divider" });

      let leaderboardText = "*👥 Task Completion by User*\n";
      if (topContributor && topContributor.completed > 0) {
        leaderboardText += `🏆 *Top Contributor*: ${topContributor.username} — ${topContributor.completed} tasks completed!\n\n`;
      }
      leaderboardText += userStats
        .map((u, i) => {
          const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
          return `${medal} *${u.username}* — ${u.completed} completed / ${u.total} total`;
        })
        .join("\n");

      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: leaderboardText },
      });
    }

    // Failed tasks
    if (failedTasks.length > 0) {
      blocks.push({ type: "divider" });
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*🚨 Failed Tasks Needing Attention*\n" +
            failedTasks.map((t) =>
              `• *${t.name}*${t.repo_name ? ` (${t.repo_name})` : ""} — ${(t.error_message || "Unknown error").substring(0, 80)}`
            ).join("\n"),
        },
      });
    }

    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `_Generated ${new Date().toISOString()} | AutoShip Weekly Digest_` },
      ],
    });

    return {
      blocks,
      text: `AutoShip Weekly: ${current.success} completed, ${current.failed} failed, $${costSaved.toFixed(0)} saved`,
    };
  } catch (err) {
    logger.error({ err: err.message }, "Failed to generate weekly digest");
    return null;
  }
}

/**
 * Schedule the weekly digest using node-cron.
 */
export function scheduleWeeklyDigest() {
  if (!config.get("weeklyDigestEnabled")) {
    logger.info("Weekly digest disabled");
    return;
  }

  if (!SLACK_BOT_TOKEN && !SLACK_WEBHOOK_URL) {
    logger.warn("Weekly digest enabled but no Slack credentials configured");
    return;
  }

  const dayMap = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };

  const day = dayMap[(config.get("weeklyDigestDay") || "monday").toLowerCase()] ?? 1;
  const hour = config.get("weeklyDigestHour") || 9;

  // Cron: minute hour * * dayOfWeek
  const cronExpr = `0 ${hour} * * ${day}`;

  cron.schedule(cronExpr, async () => {
    logger.info("Running weekly digest...");
    const digest = await generateWeeklyDigest();
    if (!digest) return;

    await _sendDigestToSlack(digest);
  });

  const dayName = Object.keys(dayMap).find((k) => dayMap[k] === day) || "monday";
  logger.info({ day: dayName, hour, cron: cronExpr }, "Weekly digest scheduled");
}

async function _sendDigestToSlack(digest) {
  const channelId = config.get("slackChannel") || process.env.SLACK_CHANNEL_ID;

  try {
    if (SLACK_BOT_TOKEN && channelId) {
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        },
        body: JSON.stringify({
          channel: channelId,
          blocks: digest.blocks,
          text: digest.text,
          unfurl_links: false,
        }),
      });
    } else if (SLACK_WEBHOOK_URL) {
      await fetch(SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocks: digest.blocks, text: digest.text }),
      });
    }
    logger.info("Weekly digest sent to Slack");
  } catch (err) {
    logger.error({ err: err.message }, "Failed to send weekly digest to Slack");
  }
}

function _formatDuration(ms) {
  if (!ms) return "N/A";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
