import { AnthropicSummarizer } from "./anthropic-summarizer.js";
import { FixtureSummarizer } from "./fixture-summarizer.js";
import type { ConversationSummarizer } from "./summarizer.js";

export * from "./summarizer.js";
export * from "./session-time.js";

/**
 * Which summarizer runs. A language model is used ONLY when explicitly configured
 * (PULSEOS_LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY); a key alone does not turn it on, because sending
 * patient conversations to a third party is a deliberate hospital decision. Otherwise the deterministic
 * fixture runs and every summary is labelled FIXTURE — never presented as AI.
 */
export function getSummarizer(env: Record<string, string | undefined> = process.env): ConversationSummarizer {
  if (env.PULSEOS_LLM_PROVIDER === "anthropic" && env.ANTHROPIC_API_KEY) {
    return new AnthropicSummarizer({ apiKey: env.ANTHROPIC_API_KEY, model: env.PULSEOS_LLM_MODEL });
  }
  return new FixtureSummarizer();
}
