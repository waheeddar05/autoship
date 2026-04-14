// src/register-webhook.js
// Run ONCE to register the webhook with ClickUp, scoped to the Engineering space:
//   node src/register-webhook.js https://your-public-url/webhook/clickup
//
// The returned webhook secret should be saved to CLICKUP_WEBHOOK_SECRET in .env

import "dotenv/config";

const CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN;
const WORKSPACE_ID = process.env.CLICKUP_WORKSPACE_ID || "";
const SPACE_ID = process.env.CLICKUP_SPACE_ID || "3416896"; // Engineering space

const isListMode = process.argv.includes("--list");
const webhookUrl = process.argv.filter((a) => !a.startsWith("--"))[2];

if (!isListMode && !webhookUrl) {
  console.error("Usage: node src/register-webhook.js <your-public-webhook-url>");
  console.error("       node src/register-webhook.js --list");
  console.error("Example: node src/register-webhook.js https://abc123.ngrok.io/webhook/clickup");
  process.exit(1);
}

async function registerWebhook() {
  const events = [
    "taskCreated",
    "taskAssigneeUpdated",
    "taskStatusUpdated",
    "taskTagUpdated",
    "taskUpdated",
    "taskCommentPosted",
  ];

  console.log(`\nRegistering webhook for workspace ${WORKSPACE_ID}...`);
  console.log(`  Space:    Engineering (${SPACE_ID})`);
  console.log(`  Endpoint: ${webhookUrl}`);
  console.log(`  Events:   ${events.join(", ")}\n`);

  const res = await fetch(`https://api.clickup.com/api/v2/team/${WORKSPACE_ID}/webhook`, {
    method: "POST",
    headers: {
      Authorization: CLICKUP_API_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      endpoint: webhookUrl,
      events,
      space_id: SPACE_ID,
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error("Failed to register webhook:", data);
    process.exit(1);
  }

  const webhook = data.webhook || data;
  const webhookId = data.id || webhook.id;
  const secret = webhook.secret || data.secret || "";

  console.log("✅ Webhook registered successfully!\n");
  console.log(`   Webhook ID: ${webhookId}`);
  console.log(`   Space:      ${webhook.space_id || SPACE_ID}`);
  console.log(`   Events:     ${webhook.events?.join(", ")}`);
  console.log(`   Endpoint:   ${webhook.endpoint || webhookUrl}`);

  if (secret) {
    console.log(`\n🔑 Webhook Secret (add to .env as CLICKUP_WEBHOOK_SECRET):`);
    console.log(`   ${secret}`);
  }

  console.log(`\n💡 To delete this webhook later:`);
  console.log(`   curl -X DELETE "https://api.clickup.com/api/v2/webhook/${webhookId}" -H "Authorization: ${CLICKUP_API_TOKEN}"`);
}

async function listWebhooks() {
  console.log(`\nExisting webhooks for workspace ${WORKSPACE_ID}:\n`);

  const res = await fetch(`https://api.clickup.com/api/v2/team/${WORKSPACE_ID}/webhook`, {
    headers: { Authorization: CLICKUP_API_TOKEN },
  });

  const data = await res.json();
  const hooks = data.webhooks || [];

  if (hooks.length === 0) {
    console.log("  No webhooks registered.");
    return;
  }

  for (const hook of hooks) {
    console.log(`  ID: ${hook.id}`);
    console.log(`  Endpoint: ${hook.endpoint}`);
    console.log(`  Events: ${hook.events?.join(", ")}`);
    console.log(`  Space: ${hook.space_id || "(none)"} | Folder: ${hook.folder_id || "(none)"}`);
    console.log(`  Health: ${JSON.stringify(hook.health || {})}`);
    console.log("");
  }
}

// If --list flag is provided, list existing webhooks instead
if (isListMode) {
  listWebhooks().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
} else {
  registerWebhook().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
}
