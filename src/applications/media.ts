import type { ApplicationContext, ApplicationInstance, StoredFile } from '../types';
import { deleteEnvironmentFile } from '../core/environments';
import { storage } from '../core/storage';
import { drawEmptyState, ellipsis, fillRoundedRect, roundedRect, WINDOW_CHROME_HEIGHT } from '../spatial/canvasUi';
import { actionAt, drawButton, drawImageCover, drawVideoCover, formatTime, type CanvasAction } from './ui';

interface PhotoItem {
  id: string;
  name: string;
  url: string;
  image: HTMLImageElement;
}

const PHOTOS_STATE_VERSION = 1;
const MAX_PHOTO_IDS = 64;
const MAX_PHOTO_ID_LENGTH = 256;

interface PhotosSnapshot {
  schemaVersion: 1;
  photoIds: string[];
  selectedId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function storedFileId(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_PHOTO_ID_LENGTH) return null;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return null;
  }
  return value;
}

function restorePhotosSnapshot(value: unknown): PhotosSnapshot | null {
  if (!isRecord(value) || value.schemaVersion !== PHOTOS_STATE_VERSION) return null;
  const seen = new Set<string>();
  const photoIds = (Array.isArray(value.photoIds) ? value.photoIds.slice(0, MAX_PHOTO_IDS) : []).flatMap((entry): string[] => {
    const id = storedFileId(entry);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [id];
  }).slice(0, MAX_PHOTO_IDS);
  const selectedId = storedFileId(value.selectedId);
  const limitedIds = photoIds.slice(0, MAX_PHOTO_IDS);
  if (selectedId && !limitedIds.includes(selectedId)) limitedIds.unshift(selectedId);
  return { schemaVersion: 1, photoIds: limitedIds.slice(0, MAX_PHOTO_IDS), selectedId };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const maxDimension = 1280;
      if (Math.max(image.naturalWidth, image.naturalHeight) <= maxDimension) {
        resolve(image);
        return;
      }
      const scale = maxDimension / Math.max(image.naturalWidth, image.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Could not prepare image preview.'));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const resized = new Image();
      resized.onload = () => resolve(resized);
      resized.onerror = () => reject(new Error('Could not decode resized image.'));
      resized.src = canvas.toDataURL('image/jpeg', 0.82);
    };
    image.onerror = () => reject(new Error('Could not decode image.'));
    image.src = url;
  });
}

export function createPhotosApp(context: ApplicationContext): ApplicationInstance {
  const photos: PhotoItem[] = [];
  const actions: CanvasAction[] = [];
  const thumbnails: Array<{ x: number; y: number; width: number; height: number; index: number }> = [];
  let selected: number | null = null;
  let loading = false;
  let destroyed = false;
  let restoreVersion = 0;

  const requestRender = (): void => {
    if (!destroyed) context.window.requestRender();
  };

  const addRecord = async (record: StoredFile): Promise<number | null> => {
    if (destroyed || !record.type.startsWith('image/')) return null;
    const existing = photos.findIndex((photo) => photo.id === record.id);
    if (existing >= 0) return existing;
    const url = URL.createObjectURL(record.blob);
    try {
      const image = await loadImage(url);
      if (destroyed) {
        URL.revokeObjectURL(url);
        return null;
      }
      const duplicate = photos.findIndex((photo) => photo.id === record.id);
      if (duplicate >= 0) {
        URL.revokeObjectURL(url);
        return duplicate;
      }
      photos.push({ id: record.id, name: record.name, url, image });
      requestRender();
      return photos.length - 1;
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  };

  const addFile = async (file: File, id?: string): Promise<number | null> => {
    const record = id ? await storage.getFile(id) : await storage.putFile(file);
    return record ? addRecord(record) : null;
  };

  const load = async (): Promise<void> => {
    if (destroyed) return;
    loading = true;
    try {
      const files = await storage.listFiles();
      for (const file of files.filter((candidate) => candidate.type.startsWith('image/')).slice(0, 24)) {
        if (destroyed) return;
        await addRecord(file);
      }
    } catch (error) {
      if (!destroyed) context.notify(error instanceof Error ? error.message : 'Could not load local photos.');
    } finally {
      loading = false;
      requestRender();
    }
  };
  const initialLoad = load();

  const applyRestoredPhotos = async (version: number, photoIds: string[], selectedId: string | null): Promise<void> => {
    await initialLoad;
    if (destroyed || version !== restoreVersion) return;
    for (const id of photoIds) {
      if (destroyed || version !== restoreVersion) return;
      if (photos.some((photo) => photo.id === id)) continue;
      try {
        const record = await storage.getFile(id);
        if (record) await addRecord(record);
      } catch {
        // Missing, unreadable, or undecodable stored files are intentionally skipped.
      }
    }
    if (destroyed || version !== restoreVersion) return;
    const remaining = photos.filter((photo) => !photoIds.includes(photo.id));
    const ordered = photoIds.flatMap((id) => {
      const photo = photos.find((candidate) => candidate.id === id);
      return photo ? [photo] : [];
    });
    photos.splice(0, photos.length, ...ordered, ...remaining);
    selected = selectedId ? photos.findIndex((photo) => photo.id === selectedId) : null;
    if (selected === -1) selected = null;
    requestRender();
  };

  return {
    render: (ctx, width, height) => {
      actions.length = 0;
      thumbnails.length = 0;
      actions.push(drawButton(ctx, 16, 12, 118, 36, 'Import photos', () => {
        void context.pickFiles('image/*', true).then(async (files) => {
          let imported = 0;
          for (const file of files) {
            try {
              await addFile(file);
              imported += 1;
            } catch (error) {
              context.notify(error instanceof Error ? error.message : 'Could not import photo.');
            }
          }
          context.notify(`${imported} photo${imported === 1 ? '' : 's'} imported.`);
        }).catch((error: unknown) => context.notify(error instanceof Error ? error.message : 'Could not import photos.'));
      }));
      if (photos.length) actions.push(drawButton(ctx, 146, 12, 104, 36, selected === null ? 'Gallery' : 'Back', () => { selected = null; }, selected !== null));
      ctx.fillStyle = 'rgba(220,231,247,.58)';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`${photos.length} local photo${photos.length === 1 ? '' : 's'}`, width - 18, 34);
      ctx.textAlign = 'left';

      if (!photos.length) {
        drawEmptyState(ctx, width, height - 22, loading ? 'Loading library' : 'Private photo library', loading ? 'Reading images from this device…' : 'Import photos from Files. Nothing is uploaded.');
        return;
      }
      if (selected !== null && photos[selected]) {
        const photo = photos[selected];
        const preview = { x: 16, y: 60, width: width - 32, height: height - 132 };
        fillRoundedRect(ctx, preview.x, preview.y, preview.width, preview.height, 15, '#050c16');
        drawImageCover(ctx, photo.image, preview.x, preview.y, preview.width, preview.height);
        ctx.fillStyle = 'rgba(3,9,17,.72)';
        fillRoundedRect(ctx, preview.x + 12, preview.y + preview.height - 36, preview.width - 24, 25, 8, 'rgba(3,9,17,.72)');
        ctx.fillStyle = '#e8f2ff';
        ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(ellipsis(ctx, photo.name, preview.width - 50), preview.x + 22, preview.y + preview.height - 19);
        const buttonY = height - 54;
        actions.push(drawButton(ctx, 16, buttonY, 110, 38, 'Previous', () => { selected = selected === null ? null : (selected - 1 + photos.length) % photos.length; }));
        actions.push(drawButton(ctx, 138, buttonY, 110, 38, 'Next', () => { selected = selected === null ? null : (selected + 1) % photos.length; }));
        actions.push(drawButton(ctx, width - 142, buttonY, 126, 38, 'Delete photo', () => {
          void context.requestConfirm(`Delete ${photo.name} from this device?`).then(async (confirmed) => {
            if (!confirmed) return;
            const removedEnvironment = await deleteEnvironmentFile(photo.id);
            if (removedEnvironment && context.getSettings().environment === removedEnvironment) context.setEnvironment('loft');
            URL.revokeObjectURL(photo.url);
            photos.splice(selected ?? 0, 1);
            selected = photos.length ? Math.min(selected ?? 0, photos.length - 1) : null;
          }).catch((error: unknown) => context.notify(error instanceof Error ? error.message : 'Could not delete photo.'));
        }, false, '#ff8f9d'));
        return;
      }

      const columns = width > 700 ? 4 : 3;
      const gap = 12;
      const cardWidth = (width - 32 - gap * (columns - 1)) / columns;
      const cardHeight = Math.min(148, (height - 82) / 2.4);
      photos.forEach((photo, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const x = 16 + column * (cardWidth + gap);
        const y = 62 + row * (cardHeight + gap);
        if (y + cardHeight > height - 8) return;
        thumbnails.push({ x, y, width: cardWidth, height: cardHeight, index });
        fillRoundedRect(ctx, x, y, cardWidth, cardHeight, 13, '#050c16');
        drawImageCover(ctx, photo.image, x, y, cardWidth, cardHeight);
        ctx.fillStyle = 'rgba(3,9,17,.68)';
        fillRoundedRect(ctx, x + 7, y + cardHeight - 27, cardWidth - 14, 20, 6, 'rgba(3,9,17,.68)');
        ctx.fillStyle = '#e8f2ff';
        ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(ellipsis(ctx, photo.name, cardWidth - 28), x + 13, y + cardHeight - 13);
      });
    },
    pointer: (x, y) => {
      if (actionAt(actions, x, y)) return true;
      if (selected === null) {
        const thumbnail = thumbnails.find((candidate) => x >= candidate.x && x <= candidate.x + candidate.width && y >= candidate.y && y <= candidate.y + candidate.height);
        if (thumbnail) selected = thumbnail.index;
      }
      return false;
    },
    openFile: async (record: StoredFile) => {
      if (!record.type.startsWith('image/')) return;
      const index = await addFile(record.blob as File, record.id);
      if (index !== null) selected = index;
      requestRender();
    },
    serialize: (): PhotosSnapshot => {
      const selectedId = selected === null ? null : storedFileId(photos[selected]?.id) ?? null;
      const photoIds = photos.slice(-MAX_PHOTO_IDS).flatMap((photo) => {
        const id = storedFileId(photo.id);
        return id ? [id] : [];
      });
      if (selectedId && !photoIds.includes(selectedId)) {
        if (photoIds.length < MAX_PHOTO_IDS) photoIds.push(selectedId);
        else photoIds[photoIds.length - 1] = selectedId;
      }
      return { schemaVersion: 1, photoIds, selectedId };
    },
    restore: (value: unknown) => {
      if (destroyed) return;
      const snapshot = restorePhotosSnapshot(value);
      if (!snapshot) return;
      restoreVersion += 1;
      void applyRestoredPhotos(restoreVersion, snapshot.photoIds, snapshot.selectedId);
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      restoreVersion += 1;
      photos.forEach((photo) => URL.revokeObjectURL(photo.url));
      photos.length = 0;
    },
  };
}

export function createVideoApp(context: ApplicationContext): ApplicationInstance {
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'metadata';
  const actions: CanvasAction[] = [];
  let url: string | null = null;
  let fileId: string | null = null;
  let name = 'No video loaded';
  let selectionVersion = 0;

  const loadRecord = async (record: StoredFile): Promise<void> => {
    selectionVersion += 1;
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(record.blob);
    fileId = record.id;
    name = record.name;
    video.src = url;
    context.window.requestRender();
  };

  const load = async (): Promise<void> => {
    const version = selectionVersion;
    const record = (await storage.listFiles()).find((file) => file.type.startsWith('video/'));
    if (record && version === selectionVersion) await loadRecord(record);
  };
  void load().catch((error: unknown) => context.notify(error instanceof Error ? error.message : 'Could not load videos.'));

  return {
    update: () => context.window.requestRender(),
    render: (ctx, width, height) => {
      actions.length = 0;
      const preview = { x: 16, y: 14, width: width - 32, height: height - 116 };
      fillRoundedRect(ctx, preview.x, preview.y, preview.width, preview.height, 16, '#050c16');
      if (url) drawVideoCover(ctx, video, preview.x, preview.y, preview.width, preview.height);
      else drawEmptyState(ctx, width, height - 50, 'Local video player', 'Import a video from Files. Playback stays on this device.');
      ctx.fillStyle = 'rgba(3,9,17,.72)';
      fillRoundedRect(ctx, 16, height - 94, width - 32, 25, 8, 'rgba(3,9,17,.72)');
      ctx.fillStyle = '#dce7f7';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(`${ellipsis(ctx, name, width - 210)}  •  ${formatTime(video.currentTime)} / ${formatTime(video.duration)}`, 28, height - 77);
      const buttonY = height - 58;
      actions.push(drawButton(ctx, 16, buttonY, 104, 40, 'Open video', () => {
        void context.pickFiles('video/*', false).then(async (files) => {
          if (!files[0]) return;
          const record = await storage.putFile(files[0]);
          await loadRecord(record);
        }).catch((error: unknown) => context.notify(error instanceof Error ? error.message : 'Could not open video.'));
      }));
      actions.push(drawButton(ctx, 132, buttonY, 104, 40, video.paused ? 'Play' : 'Pause', () => {
        if (!url) return;
        if (video.paused) void video.play().catch((error: unknown) => context.notify(error instanceof Error ? error.message : 'Playback failed.'));
        else video.pause();
      }, !video.paused));
      actions.push(drawButton(ctx, 248, buttonY, 104, 40, video.muted ? 'Unmute' : 'Mute', () => { video.muted = !video.muted; }, !video.muted));
      if (fileId) actions.push(drawButton(ctx, width - 120, buttonY, 104, 40, 'Delete', () => {
        void context.requestConfirm(`Delete ${name} from this device?`).then(async (confirmed) => {
          if (!confirmed || !fileId) return;
          video.pause();
          const removedEnvironment = await deleteEnvironmentFile(fileId);
          if (removedEnvironment && context.getSettings().environment === removedEnvironment) context.setEnvironment('loft');
          if (url) URL.revokeObjectURL(url);
          url = null;
          fileId = null;
          video.removeAttribute('src');
          name = 'No video loaded';
        }).catch((error: unknown) => context.notify(error instanceof Error ? error.message : 'Could not delete video.'));
      }, false, '#ff8f9d'));
    },
    pointer: (x, y) => {
      if (actionAt(actions, x, y)) return true;
      const width = context.window.canvas.width;
      const height = context.window.canvas.height - WINDOW_CHROME_HEIGHT;
      if (url && y >= 14 && y <= 14 + height - 116 && Number.isFinite(video.duration)) {
        const progress = Math.max(0, Math.min(1, (x - 16) / (width - 32)));
        video.currentTime = progress * video.duration;
        return true;
      }
      return false;
    },
    openFile: async (record: StoredFile) => {
      if (record.type.startsWith('video/')) await loadRecord(record);
    },
    destroy: () => {
      video.pause();
      if (url) URL.revokeObjectURL(url);
    },
  };
}

const CHILL_TRACKS = [
  {
    name: 'Morning',
    artist: 'Kevin MacLeod',
    url: `${import.meta.env.BASE_URL}music/Morning.mp3`,
    source: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN2300003',
  },
  {
    name: 'Evening',
    artist: 'Kevin MacLeod',
    url: `${import.meta.env.BASE_URL}music/Evening.mp3`,
    source: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN2300002',
  },
  {
    name: 'Late Night Radio',
    artist: 'Kevin MacLeod',
    url: `${import.meta.env.BASE_URL}music/Late-Night-Radio.mp3`,
    source: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN2100003',
  },
] as const;

const MUSIC_CREDITS = [
  'Music: “Morning”, “Evening”, and “Late Night Radio” by Kevin MacLeod (incompetech.com).',
  '',
  ...CHILL_TRACKS.map((track) => `${track.name}: ${track.source}`),
  '',
  'Licensed under Creative Commons Attribution 4.0 International:',
  'https://creativecommons.org/licenses/by/4.0/',
  '',
  'No changes made.',
].join('\n');

export function createMusicApp(context: ApplicationContext): ApplicationInstance {
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = CHILL_TRACKS[0].url;
  const actions: CanvasAction[] = [];
  let url: string | null = null;
  let fileId: string | null = null;
  let trackIndex = 0;
  let name: string = CHILL_TRACKS[0].name;
  let imported = false;
  let userPaused = false;
  let autoplayBlocked = false;
  let destroyed = false;

  const play = (): void => {
    if (!audio.src || destroyed || !audio.paused) return;
    userPaused = false;
    void audio.play().then(() => {
      if (destroyed) return;
      autoplayBlocked = false;
      context.window.requestRender();
    }).catch((error: unknown) => {
      if (destroyed) return;
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        autoplayBlocked = true;
        context.window.requestRender();
        return;
      }
      context.notify(error instanceof Error ? error.message : 'Playback failed.');
    });
  };

  const loadBundledTrack = (index: number, autoplay: boolean): void => {
    const wasPlaying = !audio.paused;
    audio.pause();
    if (url) URL.revokeObjectURL(url);
    url = null;
    fileId = null;
    imported = false;
    trackIndex = (index + CHILL_TRACKS.length) % CHILL_TRACKS.length;
    const track = CHILL_TRACKS[trackIndex];
    name = track.name;
    audio.src = track.url;
    context.window.requestRender();
    if (autoplay || wasPlaying) play();
  };

  const loadRecord = async (record: StoredFile): Promise<void> => {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(record.blob);
    fileId = record.id;
    name = record.name;
    imported = true;
    audio.src = url;
    context.window.requestRender();
    play();
  };

  const onEnded = (): void => loadBundledTrack(trackIndex + 1, true);
  const onPlay = (): void => context.window.requestRender();
  const onPause = (): void => context.window.requestRender();
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('play', onPlay);
  audio.addEventListener('pause', onPause);

  return {
    activate: () => { if (!userPaused && !autoplayBlocked) play(); },
    resume: () => { if (!userPaused && !autoplayBlocked) play(); },
    suspend: () => audio.pause(),
    update: () => context.window.requestRender(),
    render: (ctx, width, height) => {
      actions.length = 0;
      const artSize = Math.min(height - 150, width * 0.36, 260);
      const artX = width > 620 ? 34 : (width - artSize) / 2;
      const artY = width > 620 ? 28 : 12;
      const gradient = ctx.createLinearGradient(artX, artY, artX + artSize, artY + artSize);
      gradient.addColorStop(0, '#214c70');
      gradient.addColorStop(0.5, '#534a91');
      gradient.addColorStop(1, '#123047');
      fillRoundedRect(ctx, artX, artY, artSize, artSize, 24, gradient);
      ctx.save();
      roundedRect(ctx, artX, artY, artSize, artSize, 24);
      ctx.clip();
      for (let index = 0; index < 6; index += 1) {
        ctx.beginPath();
        ctx.arc(artX + artSize / 2, artY + artSize / 2, artSize * (0.12 + index * 0.075), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(180,230,255,${0.22 - index * 0.025})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();
      const infoX = width > 620 ? artX + artSize + 38 : 24;
      const infoY = width > 620 ? 44 : artY + artSize + 22;
      ctx.fillStyle = '#f4f8ff';
      ctx.font = '600 20px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(ellipsis(ctx, name, width - infoX - 24), infoX, infoY, width - infoX - 24);
      ctx.fillStyle = '#9aacc4';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      const detail = imported
        ? 'Local audio • private playback'
        : `Bundled chill • ${trackIndex + 1}/${CHILL_TRACKS.length}${autoplayBlocked ? ' • press Play' : ''}`;
      ctx.fillText(detail, infoX, infoY + 25);
      ctx.fillStyle = 'rgba(220,231,247,.62)';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(imported ? 'Imported from this device' : 'Kevin MacLeod • CC BY 4.0 • incompetech.com', infoX, infoY + 44);
      const progressY = infoY + 72;
      const progressWidth = width - infoX - 24;
      fillRoundedRect(ctx, infoX, progressY, progressWidth, 5, 3, 'rgba(255,255,255,.1)');
      const progress = audio.duration ? audio.currentTime / audio.duration : 0;
      if (progress > 0) fillRoundedRect(ctx, infoX, progressY, progressWidth * progress, 5, 3, '#75e7ff');
      ctx.fillStyle = '#9aacc4';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(`${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`, infoX, progressY + 22);
      const buttonY = height - 58;
      actions.push(drawButton(ctx, 16, buttonY, 112, 40, 'Open music', () => {
        void context.pickFiles('audio/*', false).then(async (files) => {
          if (!files[0]) return;
          await loadRecord(await storage.putFile(files[0]));
        }).catch((error: unknown) => context.notify(error instanceof Error ? error.message : 'Could not open music.'));
      }));
      actions.push(drawButton(ctx, 140, buttonY, 88, 40, audio.paused ? 'Play' : 'Pause', () => {
        if (audio.paused) play();
        else {
          userPaused = true;
          audio.pause();
        }
      }, !audio.paused));
      actions.push(drawButton(ctx, 240, buttonY, 40, 40, '‹', () => loadBundledTrack(trackIndex - 1, !audio.paused)));
      actions.push(drawButton(ctx, 288, buttonY, 40, 40, '›', () => loadBundledTrack(trackIndex + 1, !audio.paused)));
      actions.push(drawButton(ctx, 340, buttonY, 70, 40, '−10s', () => { audio.currentTime = Math.max(0, audio.currentTime - 10); }));
      actions.push(drawButton(ctx, 418, buttonY, 70, 40, '+10s', () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); }));
      actions.push(drawButton(ctx, width - 202, buttonY, 90, 40, 'Credits', () => {
        void context.requestText({ title: 'Music credits', value: MUSIC_CREDITS, submitLabel: 'Done', mode: 'information' })
          .catch((error: unknown) => context.notify(error instanceof Error ? error.message : 'Music credits are unavailable.'));
      }));
      if (fileId) actions.push(drawButton(ctx, width - 104, buttonY, 88, 40, 'Delete', () => {
        void context.requestConfirm(`Delete ${name} from this device?`).then(async (confirmed) => {
          if (!confirmed || !fileId) return;
          audio.pause();
          await storage.deleteFile(fileId);
          if (url) URL.revokeObjectURL(url);
          url = null;
          fileId = null;
          audio.removeAttribute('src');
          name = 'No track loaded';
          imported = false;
          loadBundledTrack(trackIndex, false);
        }).catch((error: unknown) => context.notify(error instanceof Error ? error.message : 'Could not delete music.'));
      }, false, '#ff8f9d'));
    },
    pointer: (x, y) => actionAt(actions, x, y),
    destroy: () => {
      destroyed = true;
      audio.pause();
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      if (url) URL.revokeObjectURL(url);
    },
  };
}
