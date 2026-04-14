// src/integrations/errors.js
// Custom error classes for the integrations module.

/**
 * Thrown when no integration token is available for a provider
 * (neither user-level nor org-level fallback).
 */
export class IntegrationNotConnectedError extends Error {
  /**
   * @param {string} provider - The provider name (e.g. 'clickup', 'github').
   * @param {string} [userId] - The user ID that was checked.
   */
  constructor(provider, userId) {
    const msg = userId
      ? `No ${provider} integration found for user ${userId} and no org fallback configured`
      : `No org-level ${provider} integration configured`;
    super(msg);
    this.name = "IntegrationNotConnectedError";
    this.provider = provider;
    this.userId = userId;
  }
}
