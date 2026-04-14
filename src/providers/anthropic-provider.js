// src/providers/anthropic-provider.js
// Anthropic provider for debate API calls (not CLI execution).

import Anthropic from "@anthropic-ai/sdk";
import { BaseProvider } from "./base-provider.js";
import { logger } from "../logger.js";

// Curated fallback list when /v1/models is unavailable
const CURATED_MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 200000, maxOutput: 32000 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200000, maxOutput: 16000 },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", contextWindow: 200000, maxOutput: 8192 },
];

export class AnthropicProvider extends BaseProvider {
  constructor(apiKey) {
    super("anthropic", apiKey);
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  async validateKey() {
    if (!this.client) return false;
    try {
      await this.client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      });
      return true;
    } catch (err) {
      logger.warn({ err: err.message }, "Anthropic key validation failed");
      return false;
    }
  }

  async listModels() {
    try {
      if (this.client && typeof this.client.models?.list === "function") {
        const resp = await this.client.models.list();
        const models = [];
        for await (const m of resp) {
          models.push({
            id: m.id,
            name: m.display_name || m.id,
            provider: "anthropic",
            contextWindow: m.context_window || 200000,
            maxOutput: m.max_output || 8192,
          });
        }
        if (models.length > 0) return models;
      }
    } catch (err) {
      logger.debug({ err: err.message }, "Anthropic models list API failed, using curated list");
    }

    return CURATED_MODELS.map((m) => ({ ...m, provider: "anthropic" }));
  }

  async chat(messages, options = {}) {
    if (!this.client) throw new Error("Anthropic provider not configured");

    const { model, temperature = 0.7, maxTokens = 4096, systemPrompt } = options;

    const params = {
      model: model || "claude-sonnet-4-6",
      max_tokens: maxTokens,
      temperature,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };

    if (systemPrompt) {
      params.system = systemPrompt;
    }

    const response = await this.client.messages.create(params);

    return {
      content: response.content.map((c) => c.text).join(""),
      usage: {
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
      },
      model: response.model,
    };
  }

  async *chatStream(messages, options = {}) {
    if (!this.client) throw new Error("Anthropic provider not configured");

    const { model, temperature = 0.7, maxTokens = 4096, systemPrompt } = options;

    const params = {
      model: model || "claude-sonnet-4-6",
      max_tokens: maxTokens,
      temperature,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };

    if (systemPrompt) {
      params.system = systemPrompt;
    }

    const stream = this.client.messages.stream(params);

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta?.text) {
        yield event.delta.text;
      }
    }
  }
}
