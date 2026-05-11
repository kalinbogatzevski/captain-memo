// OpenAI-compatible Chat Completions transport for the summarizer.
//
// Speaks the de-facto-standard `/v1/chat/completions` shape, so a single
// transport works against:
//   - OpenAI itself                (https://api.openai.com/v1/chat/completions)
//   - Ollama                       (http://localhost:11434/v1/chat/completions)
//   - LM Studio                    (http://localhost:1234/v1/chat/completions)
//   - vLLM / llama.cpp server      (http://<host>:8000/v1/chat/completions)
//   - OpenRouter / Together / Groq / Fireworks / DeepSeek / Mistral / Anyscale
//
// The endpoint URL is mandatory; the API key is optional (most local servers
// don't need one). The model name is the one passed via the standard
// summarizer config — it MUST match a model your endpoint serves.

import type {
  SummarizerTransport,
  SummarizerTransportArgs,
  SummarizerTransportResult,
} from './summarizer.ts';

export interface OpenAITransportOptions {
  /** Full URL to /v1/chat/completions (or compatible). Required. */
  endpoint: string;
  /** Bearer token. Optional — most local servers don't require one. */
  apiKey?: string;
  /** Override fetch (used by tests). */
  fetchFn?: typeof fetch;
  /** Extra fields merged into the request body (e.g. { temperature: 0 }). */
  extra?: Record<string, unknown>;
}

interface OpenAIChatChoice {
  message?: { role?: string; content?: string };
  finish_reason?: string;
}

interface OpenAIChatResponse {
  choices?: OpenAIChatChoice[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string; type?: string };
}

export function createOpenAITransport(opts: OpenAITransportOptions): SummarizerTransport {
  if (!opts.endpoint) {
    throw new Error('createOpenAITransport: endpoint required');
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const endpoint = opts.endpoint;
  const apiKey = opts.apiKey;
  const extra = opts.extra ?? {};

  return async (args: SummarizerTransportArgs): Promise<SummarizerTransportResult> => {
    const body = {
      model: args.model,
      max_tokens: args.max_tokens,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
      ...extra,
    };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error(`openai transport: ${res.status}${txt ? `: ${txt.slice(0, 300)}` : ''}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }

    const json = await res.json() as OpenAIChatResponse;
    if (json.error) {
      const message = json.error.message || 'openai transport: unknown error';
      const err = new Error(message) as Error & { status?: number };
      if (
        json.error.code === 'model_not_found' ||
        json.error.type === 'invalid_request_error' && /model/i.test(message) ||
        /model_not_found|not_found|invalid.*model/i.test(message)
      ) {
        err.status = 404;
      }
      throw err;
    }

    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new Error(`openai transport: missing choices[0].message.content in response`);
    }
    // Map OpenAI's prompt_tokens/completion_tokens to the shared input/output shape.
    const usage = (json.usage?.prompt_tokens !== undefined && json.usage?.completion_tokens !== undefined)
      ? { input_tokens: json.usage.prompt_tokens, output_tokens: json.usage.completion_tokens }
      : undefined;
    return {
      content: [{ type: 'text', text }],
      model: json.model ?? args.model,
      ...(usage && { usage }),
    };
  };
}
