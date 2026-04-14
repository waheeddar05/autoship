// src/providers/openai-provider.js
// OpenAI provider for debate API calls.

import OpenAI from "openai";
import { BaseProvider } from "./base-provider.js";
import { logger } from "../logger.js";

const CHAT_MODEL_PREFIXES = ["gpt-4", "gpt-3.5", "o1", "o3", "o4", "chatgpt"];

// Curated fallback list when API key isn't available or API fails
const CURATED_OPENAI_MODELS = [
  { id: "gpt-4o", name: "GPT-4o", contextWindow: 128000, maxOutput: 16384 },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128000, maxOutput: 16384 },
  { id: "gpt-4-turbo", name: "GPT-4 Turbo", contextWindow: 128000, maxOutput: 4096 },
  { id: "o3-mini", name: "o3-mini", contextWindow: 200000, maxOutput: 100000 },
  { id: "o1-mini", name: "o1-mini", contextWindow: 128000, maxOutput: 65536 },
  { id: "o1-preview", name: "o1-preview", contextWindow: 128000, maxOutput: 32768 },
];

export class OpenAIProvider extends BaseProvider {
  constructor(apiKey) {
    super("openai", apiKey);
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
    }
  }

  async validateKey() {
    if (!this.client) return false;
    try {
      const resp = await this.client.models.list();
      // Just check we got a response
      for await (const _ of resp) { break; }
      return true;
    } catch (err) {
      logger.warn({ err: err.message }, "OpenAI key validation failed");
      return false;
    }
  }

  async listModels() {
    // Try live API first if configured
    if (this.client) {
      try {
        const resp = await this.client.models.list();
        const models = [];

        for await (const m of resp) {
          const id = m.id;
          if (!CHAT_MODEL_PREFIXES.some((p) => id.startsWith(p))) continue;

          models.push({
            id,
            name: id,
            provider: "openai",
            contextWindow: this._estimateContext(id),
            maxOutput: this._estimateMaxOutput(id),
          });
        }

        // Sort by name
        models.sort((a, b) => a.id.localeCompare(b.id));
        if (models.length > 0) return models;
      } catch (err) {
        logger.debug({ err: err.message }, "OpenAI models list API failed, using curated list");
      }
    }

    // Fallback to curated list
    return CURATED_OPENAI_MODELS.map((m) => ({ ...m, provider: "openai" }));
  }

  async chat(messages, options = {}) {
    if (!this.client) throw new Error("OpenAI provider not configured");

    const { model, temperature = 0.7, maxTokens = 4096, systemPrompt } = options;

    const chatMessages = [];
    if (systemPrompt) {
      chatMessages.push({ role: "system", content: systemPrompt });
    }
    chatMessages.push(...messages.map((m) => ({ role: m.role, content: m.content })));

    const params = {
      model: model || "gpt-4o",
      messages: chatMessages,
      max_completion_tokens: maxTokens,
    };

    // o1/o3 models don't support temperature
    const isReasoningModel = (model || "").startsWith("o1") || (model || "").startsWith("o3") || (model || "").startsWith("o4");
    if (!isReasoningModel) {
      params.temperature = temperature;
    }

    const response = await this.client.chat.completions.create(params);
    const choice = response.choices[0];

    return {
      content: choice.message.content || "",
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
      },
      model: response.model,
    };
  }

  async *chatStream(messages, options = {}) {
    if (!this.client) throw new Error("OpenAI provider not configured");

    const { model, temperature = 0.7, maxTokens = 4096, systemPrompt } = options;

    const chatMessages = [];
    if (systemPrompt) {
      chatMessages.push({ role: "system", content: systemPrompt });
    }
    chatMessages.push(...messages.map((m) => ({ role: m.role, content: m.content })));

    const params = {
      model: model || "gpt-4o",
      messages: chatMessages,
      max_completion_tokens: maxTokens,
      stream: true,
    };

    const isReasoningModel = (model || "").startsWith("o1") || (model || "").startsWith("o3") || (model || "").startsWith("o4");
    if (!isReasoningModel) {
      params.temperature = temperature;
    }

    const stream = await this.client.chat.completions.create(params);

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  _estimateContext(modelId) {
    if (modelId.includes("128k")) return 128000;
    if (modelId.startsWith("gpt-4o") || modelId.startsWith("gpt-4-turbo")) return 128000;
    if (modelId.startsWith("o1") || modelId.startsWith("o3") || modelId.startsWith("o4")) return 200000;
    if (modelId.startsWith("gpt-4")) return 8192;
    return 16384;
  }

  _estimateMaxOutput(modelId) {
    if (modelId.startsWith("o1") || modelId.startsWith("o3") || modelId.startsWith("o4")) return 100000;
    if (modelId.startsWith("gpt-4o")) return 16384;
    return 4096;
  }
}
