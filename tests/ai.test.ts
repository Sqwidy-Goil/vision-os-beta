import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createAiApp } from '../src/applications/workspace';
import {
  ai,
  AIError,
  DEFAULT_AI_MODEL,
  OPENAI_CHAT_COMPLETIONS_URL,
  OpenAIChatClient,
  type ChatMessage,
} from '../src/core/ai';
import type { ApplicationContext, ApplicationInstance } from '../src/types';

const apiKey = 'sk-test-in-memory-only';
const messages: ChatMessage[] = [
  { role: 'system', content: 'Be concise.' },
  { role: 'user', content: 'Hello.' },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body) ?? 'null', {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function captureError(pending: Promise<string>): Promise<AIError> {
  try {
    await pending;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AIError);
    return error as AIError;
  }
  throw new Error('Expected the request to fail.');
}

describe('OpenAI chat client', () => {
  let client: OpenAIChatClient;
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    client = new OpenAIChatClient();
    client.setApiKey(apiKey);
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the key in memory and sends nothing until explicitly requested', async () => {
    const localStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() };
    const indexedDB = { open: vi.fn() };
    vi.stubGlobal('localStorage', localStorage);
    vi.stubGlobal('indexedDB', indexedDB);
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => (
      vi.spyOn(console, method).mockImplementation(() => undefined)
    ));

    client.forgetApiKey();
    expect(client.hasApiKey()).toBe(false);
    client.setApiKey(`  ${apiKey}  `);
    expect(client.hasApiKey()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Object.keys(client)).toEqual([]);
    expect(JSON.stringify(client)).not.toContain(apiKey);
    expect(localStorage.getItem).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(indexedDB.open).not.toHaveBeenCalled();
    consoleSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());

    client.forgetApiKey();
    expect(client.hasApiKey()).toBe(false);
    await expect(client.send(messages)).rejects.toMatchObject({ code: 'missing_api_key' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts messages with a Bearer key and returns assistant text', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'Hello from OpenAI.' } }] }));

    await expect(client.send(messages)).resolves.toBe('Hello from OpenAI.');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OPENAI_CHAT_COMPLETIONS_URL);
    expect(String(url)).not.toContain(apiKey);
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store' });
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${apiKey}`);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(init?.body).not.toContain(apiKey);
    expect(JSON.parse(init?.body as string)).toEqual({ model: DEFAULT_AI_MODEL, messages });
    expect(DEFAULT_AI_MODEL).toBe('gpt-4o-mini');
  });

  it('allows a model override', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'Custom model reply.' } }] }));

    await client.send(messages, { model: '  gpt-4.1-mini  ' });

    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(init?.body as string).model).toBe('gpt-4.1-mini');
  });

  it('validates requests before calling fetch', async () => {
    await expect(client.send([])).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.send(messages, { timeoutMs: 0 })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(() => client.setApiKey('   ')).toThrow(AIError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sanitizes HTTP API errors without exposing the response payload', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      error: { message: `Authorization: Bearer ${apiKey}; key=${apiKey}` },
    }, 401));

    const error = await captureError(client.send(messages));

    expect(error).toMatchObject({ code: 'http_error', status: 401 });
    expect(error.message).not.toContain(apiKey);
    expect(error.message).not.toContain('Authorization');
    expect(JSON.stringify(error)).not.toContain(apiKey);
  });

  it('sanitizes network failures', async () => {
    fetchMock.mockRejectedValue(new Error(`Network failed with Bearer ${apiKey}`));

    const error = await captureError(client.send(messages));

    expect(error.code).toBe('network');
    expect(error.message).not.toContain(apiKey);
    expect(error.message).not.toContain('Bearer');
    expect(JSON.stringify(error)).not.toContain(apiKey);
  });

  it('rejects malformed or empty assistant responses', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('not json', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ choices: [] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 42 } }] }));

    for (let index = 0; index < 3; index += 1) {
      const error = await captureError(client.send(messages));
      expect(error.code).toBe('invalid_response');
    }
  });

  it('aborts timed-out requests and clears the timer', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted.', 'AbortError')), { once: true });
      });
    });

    const pending = client.send(messages, { timeoutMs: 25 });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;

    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards caller cancellation and clears the timeout', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted.', 'AbortError')), { once: true });
      });
    });

    const pending = client.send(messages, { signal: controller.signal, timeoutMs: 1_000 });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'aborted' });
    controller.abort();
    await assertion;

    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

interface AiState {
  schemaVersion: number;
  history: ChatMessage[];
  model: string;
  scroll: number;
}

function fakeCanvasContext(): CanvasRenderingContext2D {
  return {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    lineWidth: 1,
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
  } as unknown as CanvasRenderingContext2D;
}

function aiContext() {
  const ctx = fakeCanvasContext();
  const canvas = { width: 1024, height: 548, context: ctx } as unknown as HTMLCanvasElement;
  const requestRender = vi.fn();
  const requestText = vi.fn(async (): Promise<string | null> => null);
  const context = {
    window: { id: 'ai-test', canvas, context: ctx, requestRender },
    requestText,
    notify: vi.fn(),
  } as unknown as ApplicationContext;
  return { context, requestRender, requestText };
}

function snapshot(app: ApplicationInstance): AiState {
  return app.serialize?.() as AiState;
}

const instances: ApplicationInstance[] = [];

function aiApp(context: ApplicationContext): ApplicationInstance {
  const app = createAiApp(context);
  instances.push(app);
  return app;
}

describe('AI spatial window state', () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    ai.forgetApiKey();
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    instances.splice(0).forEach((app) => app.destroy?.());
    ai.forgetApiKey();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('restores conversation, model, and scroll without persisting or accepting API keys', () => {
    const harness = aiContext();
    const app = aiApp(harness.context);
    ai.setApiKey('sk-real-in-memory-secret');
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => (
      vi.spyOn(console, method).mockImplementation(() => undefined)
    ));
    app.restore?.({
      schemaVersion: 1,
      history: [
        { role: 'system', content: 'untrusted system prompt' },
        { role: 'user', content: 'Hello.' },
        { role: 'assistant', content: 'Hi there.' },
      ],
      model: '  gpt-custom  ',
      scroll: 35,
      busy: true,
      apiKey: 'sk-injected-secret',
      accessToken: 'injected-token',
      status: 'injected-status-secret',
    });
    const saved = snapshot(app);
    expect(saved).toEqual({
      schemaVersion: 1,
      history: [
        { role: 'user', content: 'Hello.' },
        { role: 'assistant', content: 'Hi there.' },
      ],
      model: 'gpt-custom',
      scroll: 35,
    });
    const serialized = JSON.stringify(saved);
    expect(serialized).not.toMatch(/sk-real-in-memory-secret|sk-injected-secret|injected-token|injected-status-secret|untrusted system prompt/);
    expect(ai.hasApiKey()).toBe(true);
    consoleSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });

  it('caps conversation length, message size, model size, and scroll', () => {
    const harness = aiContext();
    const app = aiApp(harness.context);
    app.restore?.({
      schemaVersion: 1,
      history: Array.from({ length: 100 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `${index}:${'x'.repeat(9_000)}` })),
      model: 'm'.repeat(200),
      scroll: Number.POSITIVE_INFINITY,
    });
    const saved = snapshot(app);
    expect(saved.history).toHaveLength(60);
    expect(saved.history[0].content).toMatch(/^40:/);
    expect(saved.history[59].content).toMatch(/^99:/);
    expect(saved.history.every((message) => message.content.length <= 8_000)).toBe(true);
    expect(saved.model).toHaveLength(80);
    expect(saved.scroll).toBe(0);
  });

  it('ignores malformed restore roots without throwing or changing valid state', () => {
    const harness = aiContext();
    const app = aiApp(harness.context);
    app.restore?.({ schemaVersion: 1, history: [{ role: 'user', content: 'Keep me.' }], model: 'gpt-test' });
    const before = snapshot(app);
    for (const value of [null, [], 42, { schemaVersion: 2 }, { schemaVersion: 1, history: 'invalid' }]) {
      expect(() => app.restore?.(value)).not.toThrow();
      if (value === null || Array.isArray(value) || typeof value !== 'object' || (value as { schemaVersion?: number }).schemaVersion !== 1) {
        expect(snapshot(app)).toEqual(before);
      }
    }
  });

  it('does not resend an in-flight request when its conversation is restored', async () => {
    const harness = aiContext();
    const original = aiApp(harness.context);
    ai.setApiKey('sk-in-flight-secret');
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    harness.requestText.mockResolvedValueOnce('First question');
    original.openKeyboard?.();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const saved = snapshot(original);
    expect(saved.history).toEqual([{ role: 'user', content: 'First question' }]);
    expect(JSON.stringify(saved)).not.toContain('sk-in-flight-secret');

    const restored = aiApp(harness.context);
    restored.restore?.(saved);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    harness.requestText.mockResolvedValueOnce(null);
    restored.openKeyboard?.();
    await vi.waitFor(() => expect(harness.requestText).toHaveBeenCalledTimes(2));

    resolveFetch(jsonResponse({ choices: [{ message: { content: 'Late answer.' } }] }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(snapshot(restored).history).toEqual(saved.history);
  });
});
