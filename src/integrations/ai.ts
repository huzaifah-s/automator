import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export interface AiClient {
  /** One-shot prompt to Claude. Returns the text of the response. */
  claude(prompt: string, opts?: ClaudeOptions): Promise<string>;
  /** One-shot prompt to OpenAI. Returns the text of the response. */
  openai(prompt: string, opts?: OpenAiOptions): Promise<string>;
  /** The underlying SDK clients, for anything the helpers don't cover. */
  clients: { anthropic: () => Anthropic; openai: () => OpenAI };
}

export interface ClaudeOptions {
  model?: string;
  system?: string;
  maxTokens?: number;
  /** Thinking depth and overall token spend. Default "high". */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface OpenAiOptions {
  model?: string;
  system?: string;
  maxTokens?: number;
}

let anthropicClient: Anthropic | undefined;
let openaiClient: OpenAI | undefined;

export function createAi(signal: AbortSignal): AiClient {
  const anthropic = () => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    anthropicClient ??= new Anthropic();
    return anthropicClient;
  };

  const openai = () => {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    openaiClient ??= new OpenAI();
    return openaiClient;
  };

  return {
    clients: { anthropic, openai },

    async claude(prompt, opts = {}) {
      // Streaming keeps large max_tokens from tripping the SDK's HTTP timeout.
      const stream = anthropic().beta.messages.stream(
        {
          model: opts.model ?? "claude-opus-5",
          max_tokens: opts.maxTokens ?? 16_000,
          system: opts.system,
          thinking: { type: "adaptive" },
          output_config: { effort: opts.effort ?? "high" },
          // On a policy decline the API retries on a fallback model in the same
          // call, so an automated job doesn't just stop with no output.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          messages: [{ role: "user", content: prompt }],
        } as any,
        { signal },
      );

      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") {
        const details = (message as { stop_details?: { category?: string } }).stop_details;
        throw new Error(`Claude declined the request (${details?.category ?? "unspecified"})`);
      }

      return message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
    },

    async openai(prompt, opts = {}) {
      const res = await openai().chat.completions.create(
        {
          model: opts.model ?? "gpt-4.1",
          max_completion_tokens: opts.maxTokens ?? 4_000,
          messages: [
            ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
            { role: "user" as const, content: prompt },
          ],
        },
        { signal },
      );
      return res.choices[0]?.message?.content?.trim() ?? "";
    },
  };
}
