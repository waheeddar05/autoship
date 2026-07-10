// src/task-source-router.js
// Task-source abstraction: routes task operations (comments, status, tags)
// to the right backend based on the task id. ClickUp is the default;
// GitHub-issue tasks (ids starting with "gh-") route to the GitHub API,
// which lets the whole pipeline run unmodified on GitHub Issues.

import * as clickup from "./clickup-client.js";
import * as githubIssues from "./sources/github-issues-source.js";

export function isGitHubTask(taskId) {
  return typeof taskId === "string" && taskId.startsWith("gh-");
}

function backend(taskId) {
  return isGitHubTask(taskId) ? githubIssues : clickup;
}

export async function postTaskComment(taskId, commentText) {
  return backend(taskId).postTaskComment(taskId, commentText);
}

export async function updateTaskStatus(taskId, status) {
  return backend(taskId).updateTaskStatus(taskId, status);
}

export async function updateTaskAssignees(taskId, assigneeIds) {
  return backend(taskId).updateTaskAssignees(taskId, assigneeIds);
}

export async function addTagToTask(taskId, tag) {
  return backend(taskId).addTagToTask(taskId, tag);
}

export async function removeTagFromTask(taskId, tag) {
  return backend(taskId).removeTagFromTask(taskId, tag);
}

export async function getTaskDetails(taskId) {
  return backend(taskId).getTaskDetails(taskId);
}

export async function getTaskComments(taskId) {
  return backend(taskId).getTaskComments(taskId);
}

export async function getRawTaskDetails(taskId) {
  return backend(taskId).getRawTaskDetails(taskId);
}
