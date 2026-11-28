export const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_AI_MODEL = 'gpt-4o-mini';

const DEFAULT_TIMEOUT_MS = 30_000;

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface SendChatOptions {
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type AIErrorCode = 'missing_api_key' | 'invalid_request' | 'invalid_response' | 'http_error' | 'network' | 'timeout' | 'aborted';

export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly status?: number;

  constructor(message: string, code: AIErrorCode = 'invalid_request', status?: number) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.status = status;
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

function abortError(timedOut: boolean): AIError {
  return timedOut
    ? new AIError('The OpenAI request timed out.', 'timeout')
    : new AIError('The OpenAI request was aborted.', 'aborted');
}

export class OpenAIChatClient {
  #apiKey: string | null = null;

  setApiKey(apiKey: string): void {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new AIError('Enter an OpenAI API key.');
    this.#apiKey = trimmed;
  }

  hasApiKey(): boolean {
    return this.#apiKey !== null;
  }

  forgetApiKey(): void {
    this.#apiKey = null;
  }

  async send(messages: readonly ChatMessage[], options: SendChatOptions = {}): Promise<string> {
    const apiKey = this.#apiKey;
    if (!apiKey) throw new AIError('Set an OpenAI API key before sending a message.', 'missing_api_key');
    if (messages.length === 0) throw new AIError('Provide at least one chat message.');

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new AIError('The timeout must be a positive number.');
    if (options.signal?.aborted) throw abortError(false);

    const model = options.model?.trim() || DEFAULT_AI_MODEL;
    let body: string;
    try {
      body = JSON.stringify({ model, messages });
    } catch {
      throw new AIError('Chat messages must be JSON serializable.');
    }

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: controller.signal,
        cache: 'no-store',
      });
      if (controller.signal.aborted) throw abortError(timedOut);
      if (!response.ok) {
        throw new AIError(`OpenAI request failed (HTTP ${response.status}).`, 'http_error', response.status);
      }

      let data: ChatCompletionResponse;
      try {
        data = await response.json() as ChatCompletionResponse;
      } catch {
        if (timedOut || controller.signal.aborted) throw abortError(timedOut);
        throw new AIError('OpenAI returned an invalid response.', 'invalid_response');
      }
      if (controller.signal.aborted) throw abortError(timedOut);

      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new AIError('OpenAI returned no assistant text.', 'invalid_response');
      }
      return content;
    } catch (error: unknown) {
      if (error instanceof AIError) throw error;
      if (timedOut || controller.signal.aborted) throw abortError(timedOut);
      throw new AIError('Could not reach OpenAI. Check your connection and try again.', 'network');
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export const ai = new OpenAIChatClient();
