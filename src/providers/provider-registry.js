// src/providers/provider-registry.js
// Singleton registry for AI model providers.

import { AnthropicProvider } from "./anthropic-provider.js";
import { OpenAIProvider } from "./openai-provider.js";
import { logger } from "../logger.js";

class ProviderRegistry {
  constructor() {
    this.providers = new Map();
    this._modelCache = new Map(); // provider → { models, cachedAt }
    this._cacheTTL = 5 * 60 * 1000; // 5 minutes
  }

  /** Initialize providers from environment variables. Always creates both providers. */
  initialize() {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    // Always create both providers — even without keys they return curated model lists
    this.providers.set("anthropic", new AnthropicProvider(anthropicKey || null));
    if (anthropicKey) {
      logger.info("Anthropic provider configured");
    } else {
      logger.info("Anthropic provider registered (no ANTHROPIC_API_KEY — curated models only)");
    }

    this.providers.set("openai", new OpenAIProvider(openaiKey || null));
    if (openaiKey) {
      logger.info("OpenAI provider configured");
    } else {
      logger.info("OpenAI provider registered (no OPENAI_API_KEY — curated models only)");
    }
  }

  /** Get a provider by name. */
  getProvider(name) {
    return this.providers.get(name) || null;
  }

  /** Get all providers with status. */
  getConfiguredProviders() {
    const result = [];
    for (const [name, provider] of this.providers) {
      result.push({
        name,
        configured: provider.configured,
        envKey: name === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY",
      });
    }
    return result;
  }

  /**
   * List models for a specific provider (cached).
   * Returns curated fallback models even when provider has no API key.
   */
  async listModels(providerName) {
    const provider = this.providers.get(providerName);
    if (!provider) return [];

    // Check cache first
    const cached = this._modelCache.get(providerName);
    if (cached && (Date.now() - cached.cachedAt) < this._cacheTTL) {
      return cached.models;
    }

    try {
      // listModels() in each provider returns curated fallback when not configured
      const models = await provider.listModels();
      this._modelCache.set(providerName, { models, cachedAt: Date.now() });
      return models;
    } catch (err) {
      logger.error({ provider: providerName, err: err.message }, "Failed to list models");
      return cached?.models || [];
    }
  }

  /** List all models across all providers. */
  async listAllModels() {
    const allModels = [];
    for (const [name] of this.providers) {
      const models = await this.listModels(name);
      allModels.push(...models);
    }
    return allModels;
  }

  /**
   * Parse a model spec "provider:model" → { provider, modelId }.
   * If no colon, assumes "anthropic".
   */
  resolveModel(modelSpec) {
    if (!modelSpec) return { provider: "anthropic", modelId: "claude-sonnet-4-6" };
    const colonIdx = modelSpec.indexOf(":");
    if (colonIdx === -1) return { provider: "anthropic", modelId: modelSpec };
    return {
      provider: modelSpec.substring(0, colonIdx),
      modelId: modelSpec.substring(colonIdx + 1),
    };
  }

  /**
   * Send a chat message via the appropriate provider.
   * @param {string} modelSpec - "provider:model" format
   * @param {Array} messages
   * @param {Object} options - { temperature, maxTokens, systemPrompt, timeout }
   */
  async chat(modelSpec, messages, options = {}) {
    const { provider: providerName, modelId } = this.resolveModel(modelSpec);
    const provider = this.providers.get(providerName);

    if (!provider || !provider.configured) {
      throw new Error(`Provider "${providerName}" is not configured. Set ${providerName === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}.`);
    }

    const { timeout, ...chatOptions } = options;
    chatOptions.model = modelId;

    if (timeout) {
      return Promise.race([
        provider.chat(messages, chatOptions),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Model ${modelSpec} timed out after ${timeout}ms`)), timeout)
        ),
      ]);
    }

    return provider.chat(messages, chatOptions);
  }

  /** Convenience: get only Anthropic models (for execution model selection). */
  async getAnthropicModels() {
    return this.listModels("anthropic");
  }
}

export const providerRegistry = new ProviderRegistry();
