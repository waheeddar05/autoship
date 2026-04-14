// src/clickup-client.js
import { logger } from "./logger.js";

const BASE_URL = "https://api.clickup.com/api/v2";

async function clickupFetch(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: process.env.CLICKUP_API_TOKEN,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ClickUp API error ${res.status}: ${body}`);
  }

  return res.json();
}

/**
 * Fetch full task details including description, custom fields, tags, subtasks
 */
export async function getTaskDetails(taskId) {
  logger.info({ taskId }, "Fetching task details from ClickUp");
  const task = await clickupFetch(`/task/${taskId}?include_subtasks=true`);
  return normalizeTask(task);
}

/**
 * Fetch tasks from a specific list, optionally filtered by assignee and statuses.
 * Used by the poller to discover new tasks in the configured ClickUp folder.
 */
export async function getListTasks(listId, { assigneeId, statuses = [] } = {}) {
  const params = new URLSearchParams();
  if (assigneeId) params.append("assignees[]", assigneeId);
  for (const s of statuses) params.append("statuses[]", s);
  params.append("include_closed", "false");
  params.append("subtasks", "true");

  const queryString = params.toString();
  const data = await clickupFetch(`/list/${listId}/task?${queryString}`);
  return (data.tasks || []).map(normalizeTask);
}

/**
 * Get custom fields defined on a list (useful for discovering the "repo" field ID)
 */
export async function getListCustomFields(listId) {
  const data = await clickupFetch(`/list/${listId}/field`);
  return data.fields || [];
}

/**
 * Post a comment on a ClickUp task
 */
export async function postTaskComment(taskId, commentText) {
  logger.info({ taskId }, "Posting comment to ClickUp task");
  return clickupFetch(`/task/${taskId}/comment`, {
    method: "POST",
    body: JSON.stringify({ comment_text: commentText, notify_all: false }),
  });
}

/**
 * Update task status
 */
export async function updateTaskStatus(taskId, status) {
  logger.info({ taskId, status }, "Updating task status");
  return clickupFetch(`/task/${taskId}`, {
    method: "PUT",
    body: JSON.stringify({ status }),
  });
}

/**
 * Update task assignees (replace all)
 */
export async function updateTaskAssignees(taskId, assigneeIds) {
  logger.info({ taskId, assigneeIds }, "Updating task assignees");
  return clickupFetch(`/task/${taskId}`, {
    method: "PUT",
    body: JSON.stringify({ assignees: { add: assigneeIds, rem: [] } }),
  });
}

/**
 * Add a tag to a task
 */
export async function addTagToTask(taskId, tagName) {
  // ClickUp stores tag names in lowercase — normalize to ensure consistency
  const normalizedTag = tagName.toLowerCase();
  logger.info({ taskId, tagName: normalizedTag }, "Adding tag to task");
  return clickupFetch(`/task/${taskId}/tag/${encodeURIComponent(normalizedTag)}`, {
    method: "POST",
  });
}

/**
 * Remove a tag from a task
 */
export async function removeTagFromTask(taskId, tagName) {
  // ClickUp stores tag names in lowercase — normalize before removing
  const normalizedTag = tagName.toLowerCase();
  logger.info({ taskId, tagName: normalizedTag }, "Removing tag from task");
  return clickupFetch(`/task/${taskId}/tag/${encodeURIComponent(normalizedTag)}`, {
    method: "DELETE",
  });
}

/**
 * Get comments on a task (paginated)
 */
export async function getTaskComments(taskId, { startId } = {}) {
  const params = new URLSearchParams();
  if (startId) params.append("start_id", startId);
  const query = params.toString();
  const data = await clickupFetch(`/task/${taskId}/comment${query ? `?${query}` : ""}`);
  return data.comments || [];
}

/**
 * Get raw task details (unnormalized) — includes creator field
 */
export async function getRawTaskDetails(taskId) {
  return clickupFetch(`/task/${taskId}?include_subtasks=true`);
}

/**
 * Normalize a raw ClickUp task into a consistent shape
 */
function normalizeTask(task) {
  return {
    id: task.id,
    customId: task.custom_id || task.id,
    name: task.name,
    description: task.description || "",
    markdownDescription: task.text_content || task.description || "",
    status: task.status?.status?.toLowerCase(),
    priority: task.priority?.priority,
    tags: task.tags?.map((t) => t.name) || [],
    assignees: task.assignees?.map((a) => ({ id: a.id, username: a.username })) || [],
    list: { id: task.list?.id, name: task.list?.name },
    folder: { id: task.folder?.id, name: task.folder?.name },
    space: { id: task.space?.id },
    customFields: task.custom_fields || [],
    subtasks: task.subtasks || [],
    url: task.url,
    dateCreated: task.date_created,
  };
}
