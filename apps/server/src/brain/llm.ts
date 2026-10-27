export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmClient {
  readonly name: string;
  complete(messages: ChatMessage[]): Promise<string>;
}

export interface LlmEndpoint {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/** NEAR AI Cloud, OpenAI-compatible (https://docs.near.ai/cloud/guides/openai-compatibility). */
export const NEAR_AI_DEFAULT_BASE_URL = 'https://cloud-api.near.ai/v1';

/**
 * Minimal client for any OpenAI-compatible chat completions API.
 * NEAR AI Cloud exposes this interface (private inference in TEEs), so switching
 * model or provider is configuration only. Check https://docs.near.ai/ for the
 * current base URL and model ids.
 */
export class OpenAiCompatible implements LlmClient {
  constructor(private ep: LlmEndpoint, private fetchImpl: typeof fetch = fetch) {}
  get name() {
    return `${this.ep.name} (${this.ep.model})`;
  }
  async complete(messages: ChatMessage[]): Promise<string> {
    const res = await this.fetchImpl(`${this.ep.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.ep.apiKey}` },
      body: JSON.stringify({ model: this.ep.model, messages, temperature: 0.4, max_tokens: this.ep.maxTokens ?? 600 }),
      signal: AbortSignal.timeout(this.ep.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new Error(`${this.ep.name} HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    return json.choices?.[0]?.message?.content ?? '';
  }

  /** Model ids the endpoint offers (GET /models). */
  async models(): Promise<string[]> {
    const res = await this.fetchImpl(`${this.ep.baseUrl.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${this.ep.apiKey}` },
      signal: AbortSignal.timeout(this.ep.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new Error(`${this.ep.name} /models HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { id?: string }[] };
    return (json.data ?? []).map((m) => m.id ?? '').filter(Boolean);
  }
}

/** Primary first; on error or quota, the fallback with the same interface. */
export class WithFallback implements LlmClient {
  constructor(private primary: LlmClient, private fallback?: LlmClient) {}
  get name() {
    return this.primary.name;
  }
  async complete(messages: ChatMessage[]) {
    try {
      return await this.primary.complete(messages);
    } catch (e) {
      if (!this.fallback) throw e;
      return this.fallback.complete(messages);
    }
  }
}

/**
 * A deliberately compromised model for security tests: it does whatever the player's
 * message asks, encoded as an action proposal. If the guard holds against this, it
 * holds against any real model.
 */
export class ObedientLlm implements LlmClient {
  readonly name = 'obedient (test double)';
  constructor(private proposal: (userText: string) => unknown) {}
  async complete(messages: ChatMessage[]) {
    const user = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    return JSON.stringify({ reply: 'Of course! Right away.', action: this.proposal(user) });
  }
}
