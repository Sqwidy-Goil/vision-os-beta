import { ai, DEFAULT_AI_MODEL, type ChatMessage } from '../core/ai';
import { storage } from '../core/storage';
import type { ApplicationContext, ApplicationInstance, StoredFile } from '../types';
import { drawEmptyState, ellipsis, fillRoundedRect, WINDOW_CHROME_HEIGHT } from '../spatial/canvasUi';
import { actionAt, drawButton, formatBytes, type CanvasAction } from './ui';

interface LibraryRow {
  file: StoredFile;
  y: number;
  height: number;
}

export function createLibraryApp(context: ApplicationContext): ApplicationInstance {
  const actions: CanvasAction[] = [];
  let rows: LibraryRow[] = [];
  let loading = true;
  let scroll = 0;
  let error = '';
  let generation = 0;

  const refresh = async (): Promise<void> => {
    const version = ++generation;
    loading = true;
    error = '';
    context.window.requestRender();
    try {
      const files = (await storage.listFiles()).filter((file) => file.type.startsWith('image/') || file.type.startsWith('video/'));
      if (version !== generation) return;
      rows = files.map((file, index) => ({ file, y: 86 + index * 102, height: 92 }));
      scrollContent(0);
    } catch (cause) {
      if (version === generation) error = cause instanceof Error ? cause.message : 'Could not read local media.';
    } finally {
      if (version === generation) {
        loading = false;
        context.window.requestRender();
      }
    }
  };

  const open = (file: StoredFile): void => {
    context.openSharedFile(file.type.startsWith('video/') ? 'video' : 'photos', file);
    context.window.close();
  };

  const scrollContent = (deltaY: number): void => {
    const maximum = Math.max(0, rows.length * 102 - (context.window.canvas.height - 200));
    scroll = Math.max(0, Math.min(maximum, scroll + deltaY));
    context.window.requestRender();
  };

  void refresh();

  return {
    render: (ctx, width, height) => {
      actions.length = 0;
      fillRoundedRect(ctx, 16, 14, width - 32, 52, 14, 'rgba(255,255,255,.045)');
      ctx.fillStyle = '#9aacc4';
      ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText('Local media stays on this device. Pinch a file to open it.', 32, 45, width - 250);
      actions.push(drawButton(ctx, width - 186, 23, 74, 33, 'Refresh', () => { void refresh(); }));
      actions.push(drawButton(ctx, width - 104, 23, 74, 33, 'Import', () => {
        if (context.isVrActive()) {
          context.notify('Exit VR and use Library to import files. iOS requires a trusted picker gesture.');
          return;
        }
        void context.pickFiles('image/*,video/*', true).then(async (files) => {
          for (const file of files) await storage.putFile(file);
          await refresh();
        }).catch(() => context.notify('Media import was cancelled or unavailable.'));
      }));
      ctx.save();
      ctx.beginPath();
      ctx.rect(16, 78, width - 32, height - 100);
      ctx.clip();
      ctx.translate(0, -scroll);
      if (loading) {
        drawEmptyState(ctx, width, height - 100, 'Loading library', 'Reading IndexedDB media…');
      } else if (error) {
        drawEmptyState(ctx, width, height - 100, 'Library unavailable', error, '#ffb3bc');
      } else if (!rows.length) {
        drawEmptyState(ctx, width, height - 100, 'No local media yet', 'Import photos or videos outside VR before putting on the headset.');
      }
      for (const row of rows) {
        const file = row.file;
        fillRoundedRect(ctx, 20, row.y, width - 40, row.height, 16, 'rgba(255,255,255,.05)');
        ctx.fillStyle = file.type.startsWith('video/') ? '#ff9db0' : '#b694ff';
        ctx.font = '600 30px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(file.type.startsWith('video/') ? '▶' : '✦', 42, row.y + 55);
        ctx.fillStyle = '#eef4fb';
        ctx.font = '650 17px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(ellipsis(ctx, file.name, width - 340), 96, row.y + 36, width - 340);
        ctx.fillStyle = '#9aacc4';
        ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(`${file.type.startsWith('video/') ? 'Video' : 'Image'} • ${formatBytes(file.size)} • ${new Date(file.createdAt).toLocaleDateString()}`, 96, row.y + 63, width - 340);
        if (row.y - scroll + row.height >= 78 && row.y - scroll <= height - 22) {
          actions.push(drawButton(ctx, width - 184, row.y + 29 - scroll, 136, 38, file.type.startsWith('video/') ? 'Play' : 'Open', () => open(file)));
        }
      }
      ctx.restore();
      if (rows.length * 102 > height - 120) {
        const trackHeight = height - 120;
        const thumbHeight = Math.max(45, trackHeight * trackHeight / (rows.length * 102));
        const thumbY = 90 + (trackHeight - thumbHeight) * scroll / Math.max(1, rows.length * 102 - trackHeight);
        fillRoundedRect(ctx, width - 12, thumbY, 5, thumbHeight, 3, 'rgba(255,255,255,.38)');
      }
    },
    pointer: (x, y, event) => {
      if (actionAt(actions, x, y)) return true;
      if (event.type === 'pointermove' && event.buttons === 1) {
        scrollContent(-event.movementY);
        return true;
      }
      const contentTop = 78;
      const contentBottom = context.window.canvas.height - WINDOW_CHROME_HEIGHT - 22;
      if (y < contentTop || y > contentBottom) return false;
      const row = rows.find((candidate) => y + scroll >= candidate.y && y + scroll <= candidate.y + candidate.height);
      if (row && event.type === 'pointerup') open(row.file);
      return row !== undefined;
    },
    scroll: (deltaY) => {
      scrollContent(deltaY);
      return true;
    },
    destroy: () => {
      generation += 1;
      rows = [];
    },
  };
}

const AI_STATE_VERSION = 1;
const MAX_AI_MESSAGES = 60;
const MAX_AI_MESSAGE_LENGTH = 8_000;
const MAX_AI_MODEL_LENGTH = 80;
const MAX_AI_SCROLL = 1_000_000;

interface AiSnapshot {
  schemaVersion: 1;
  history: ChatMessage[];
  model: string;
  scroll: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function restoreAiSnapshot(value: unknown): AiSnapshot | null {
  if (!isRecord(value) || value.schemaVersion !== AI_STATE_VERSION) return null;
  const history = (Array.isArray(value.history) ? value.history.slice(-MAX_AI_MESSAGES) : []).flatMap((entry): ChatMessage[] => {
    if (!isRecord(entry)
      || (entry.role !== 'user' && entry.role !== 'assistant')
      || typeof entry.content !== 'string') return [];
    return [{ role: entry.role, content: entry.content.slice(0, MAX_AI_MESSAGE_LENGTH) }];
  }).slice(-MAX_AI_MESSAGES);
  const model = typeof value.model === 'string' && value.model.trim()
    ? value.model.trim().slice(0, MAX_AI_MODEL_LENGTH)
    : DEFAULT_AI_MODEL;
  const scroll = typeof value.scroll === 'number' && Number.isFinite(value.scroll)
    ? Math.min(MAX_AI_SCROLL, Math.max(0, value.scroll))
    : 0;
  return { schemaVersion: 1, history, model, scroll };
}

export function createAiApp(context: ApplicationContext): ApplicationInstance {
  const actions: CanvasAction[] = [];
  const history: ChatMessage[] = [];
  let status = 'Add an OpenAI key for this session, or ask a question.';
  let model = DEFAULT_AI_MODEL;
  let busy = false;
  let abort: AbortController | null = null;
  let scroll = 0;
  let destroyed = false;

  const contentHeight = (width: number): number => {
    if (!history.length) return 0;
    const measurement = context.window.context;
    measurement.save();
    measurement.font = '15px -apple-system, BlinkMacSystemFont, sans-serif';
    let y = 100;
    for (const message of history) {
      y += 24 + wrapText(measurement, message.content, width - 80).length * 23 + 24;
    }
    measurement.restore();
    return Math.max(0, y - 78);
  };

  const scrollContent = (deltaY: number): void => {
    const maximum = Math.max(0, contentHeight(context.window.canvas.width) - (context.window.canvas.height - 200));
    scroll = Math.max(0, Math.min(maximum, scroll + deltaY));
    context.window.requestRender();
  };

  const ask = (): void => {
    if (busy) return;
    void context.requestText({ title: 'Message to AI', value: '', placeholder: 'Prompts go to OpenAI only when you send them.', submitLabel: 'Send' })
      .then((value) => { if (value !== null) send(value); })
      .catch((error: unknown) => {
        status = error instanceof Error ? error.message : 'AI text entry is unavailable.';
        context.window.requestRender();
      });
  };

  const send = (prompt: string): void => {
    const text = prompt.trim();
    if (!text) return;
    if (!ai.hasApiKey()) {
      status = 'Set an OpenAI API key before sending.';
      context.window.requestRender();
      return;
    }
    history.push({ role: 'user', content: text });
    status = 'Request sent to OpenAI';
    const controller = new AbortController();
    abort = controller;
    busy = true;
    context.window.requestRender();
    void ai.send([
      { role: 'system', content: 'You are a concise assistant inside a spatial computing interface. Be practical and honest about device limitations.' },
      ...history,
    ], { model, signal: controller.signal }).then((answer) => {
      if (abort !== controller) return;
      history.push({ role: 'assistant', content: answer });
      status = 'Response received';
    }).catch((error: unknown) => {
      if (abort !== controller) return;
      history.pop();
      status = error instanceof Error ? error.message : 'The AI request failed.';
    }).finally(() => {
      if (abort !== controller) return;
      abort = null;
      busy = false;
      scrollContent(0);
      context.window.requestRender();
    });
  };

  return {
    render: (ctx, width, height) => {
      actions.length = 0;
      fillRoundedRect(ctx, 16, 14, width - 32, 48, 13, 'rgba(255,255,255,.045)');
      ctx.fillStyle = '#9aacc4';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(ellipsis(ctx, status, width - 530), 30, 43, width - 530);
      actions.push(drawButton(ctx, width - 488, 22, 104, 31, ai.hasApiKey() ? 'Key active' : 'Set key', () => {
        if (ai.hasApiKey()) {
          context.notify('An OpenAI key is active in memory. Use Forget to clear it.');
          return;
        }
        void context.requestText({ title: 'OpenAI API key', value: '', secret: true, placeholder: 'Stored in memory only', submitLabel: 'Use key' })
          .then((value) => {
            if (value === null) return;
            try {
              ai.setApiKey(value);
              status = 'OpenAI key active for this session.';
            } catch (error) {
              status = error instanceof Error ? error.message : 'Enter a valid key.';
            }
            context.window.requestRender();
          });
      }, ai.hasApiKey()));
      actions.push(drawButton(ctx, width - 376, 22, 88, 31, 'Forget', () => {
        abort?.abort();
        abort = null;
        ai.forgetApiKey();
        history.length = 0;
        status = 'Key and conversation forgotten.';
        context.window.requestRender();
      }));
      actions.push(drawButton(ctx, width - 280, 22, 88, 31, 'Model', () => {
        void context.requestText({ title: 'OpenAI model', value: model, placeholder: 'gpt-4o-mini', submitLabel: 'Save' }).then((value) => {
          if (value?.trim()) model = value.trim().slice(0, 80);
          context.window.requestRender();
        });
      }));
      actions.push(drawButton(ctx, width - 184, 22, 154, 31, busy ? 'Cancel' : 'Ask AI', () => {
        if (busy) abort?.abort();
        else ask();
      }, busy));

      ctx.save();
      ctx.beginPath();
      ctx.rect(20, 78, width - 40, height - 102);
      ctx.clip();
      ctx.translate(0, -scroll);
      if (!history.length) {
        drawEmptyState(ctx, width, height - 110, 'Spatial AI assistant', 'Your API key is never saved by VISI0N OS. Do not send private camera, file, or scan content.');
      } else {
        let y = 100;
        for (const message of history) {
          const speaker = message.role === 'user' ? 'YOU' : 'AI';
          ctx.fillStyle = message.role === 'user' ? '#75e7ff' : '#b694ff';
          ctx.font = '700 11px -apple-system, BlinkMacSystemFont, sans-serif';
          ctx.fillText(speaker, 34, y);
          y += 24;
          ctx.fillStyle = '#e9f0f8';
          ctx.font = '15px -apple-system, BlinkMacSystemFont, sans-serif';
          for (const line of wrapText(ctx, message.content, width - 80)) {
            ctx.fillText(line, 34, y);
            y += 23;
          }
          y += 24;
        }
      }
      ctx.restore();
    },
    pointer: (x, y, event) => {
      if (actionAt(actions, x, y)) return true;
      if (event.type === 'pointermove' && event.buttons === 1 && y > 78) {
        scrollContent(-event.movementY);
        return true;
      }
      return y > 78;
    },
    scroll: (deltaY) => {
      scrollContent(deltaY);
      return true;
    },
    openKeyboard: () => {
      if (busy) context.notify('AI is responding. Choose Cancel before starting another message.');
      else ask();
    },
    serialize: (): AiSnapshot => ({
      schemaVersion: 1,
      history: history.slice(-MAX_AI_MESSAGES).map((message) => ({
        role: message.role,
        content: message.content.slice(0, MAX_AI_MESSAGE_LENGTH),
      })),
      model: model.slice(0, MAX_AI_MODEL_LENGTH),
      scroll: Math.min(MAX_AI_SCROLL, Math.max(0, scroll)),
    }),
    restore: (value: unknown) => {
      if (destroyed) return;
      const snapshot = restoreAiSnapshot(value);
      if (!snapshot) return;
      abort?.abort();
      abort = null;
      busy = false;
      history.splice(0, history.length, ...snapshot.history);
      model = snapshot.model;
      scroll = snapshot.scroll;
      status = 'Conversation restored. Any previous in-flight request was not resent.';
      context.window.requestRender();
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      abort?.abort();
      abort = null;
      history.length = 0;
    },
  };
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (context.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}
