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

/**
 * Health of the model endpoint as seen by the game: when it last answered, and the last
 * error in short (HTTP status and the provider's message, never the key). Shown on
 * /api/health, the dashboard and in the feed when NPCs fall back to the rules.
 */
export const modelStatus: { lastOkAt?: string; lastErrorAt?: string; lastError?: string; errors: number } = { errors: 0 };

/** One short line for the feed: "HTTP 402: insufficient credits" → "HTTP 402: insufficient credits". */
export function shortReason(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/abort|timeout/i.test(m)) return 'timed out';
  return m.replace(/^[^:]*?(HTTP \d+)/, '$1').replace(/Bearer\s+\S+|sk-[\w-]+/g, '…').replace(/\s+/g, ' ').slice(0, 90);
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
    try {
      const out = await this.completeRaw(messages);
      modelStatus.lastOkAt = new Date().toISOString();
      return out;
    } catch (e) {
      modelStatus.errors++;
      modelStatus.lastErrorAt = new Date().toISOString();
      modelStatus.lastError = `${this.ep.name}: ${shortReason(e)}`;
      throw e;
    }
  }
  private async completeRaw(messages: ChatMessage[]): Promise<string> {
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

/**
 * The JSON object in a model reply. Reasoning models may prefix a `<think>` block (which can
 * contain braces of its own) or wrap the JSON in a code fence: drop those, then take the last
 * balanced `{...}` that parses.
 */
export function extractJson(raw: string): Record<string, unknown> | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').replace(/```(?:json)?/gi, '');
  const found: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { found.push(text.slice(i, j + 1)); i = j; break; }
    }
  }
  for (const s of found.reverse()) {
    try {
      const j = JSON.parse(s);
      if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>;
    } catch { /* try the previous one */ }
  }
  return null;
}
