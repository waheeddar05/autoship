// src/providers/base-provider.js
// Abstract base class for AI model providers.

export class BaseProvider {
  constructor(name, apiKey) {
    this.name = name;
    this.apiKey = apiKey;
    this.configured = !!apiKey;
  }

  /** Validate the API key with a lightweight call. Returns boolean. */
  async validateKey() {
    throw new Error("validateKey() not implemented");
  }

  /** List available models. Returns [{ id, name, provider, contextWindow, maxOutput }] */
  async listModels() {
    throw new Error("listModels() not implemented");
  }

  /**
   * Send a chat completion request.
   * @param {Array<{role: string, content: string}>} messages
   * @param {Object} options - { model, temperature, maxTokens, systemPrompt }
   * @returns {{ content: string, usage: { inputTokens, outputTokens }, model: string }}
   */
  async chat(messages, options = {}) {
    throw new Error("chat() not implemented");
  }

  /**
   * Stream a chat completion. Yields content chunks.
   * @param {Array<{role: string, content: string}>} messages
   * @param {Object} options - { model, temperature, maxTokens, systemPrompt }
   * @yields {string} content chunks
   */
  async *chatStream(messages, options = {}) {
    throw new Error("chatStream() not implemented");
  }
}
