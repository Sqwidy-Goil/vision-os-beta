import type { CustomEnvironment, EnvironmentId } from '../types';
import { storage } from './storage';

const LIBRARY_KEY = 'custom-environments:v1';
const MAX_FILE_SIZE = 64 * 1024 * 1024;
let records: CustomEnvironment[] = [];
const urls = new Map<string, string>();
let initialization: Promise<void> | null = null;

function isRecord(value: unknown): value is CustomEnvironment {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CustomEnvironment>;
  return typeof candidate.id === 'string'
    && /^custom:[a-zA-Z0-9-]+$/.test(candidate.id)
    && typeof candidate.name === 'string'
    && typeof candidate.fileId === 'string'
    && typeof candidate.width === 'number'
    && typeof candidate.height === 'number'
    && typeof candidate.createdAt === 'number';
}

async function readRecords(): Promise<CustomEnvironment[]> {
  const value = await storage.get<unknown>(LIBRARY_KEY);
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

async function createUrl(record: CustomEnvironment): Promise<string | null> {
  const file = await storage.getFile(record.fileId);
  if (!file) return null;
  const url = URL.createObjectURL(file.blob);
  urls.set(record.id, url);
  return url;
}

export async function initializePanoramaLibrary(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    records = await readRecords();
    for (const record of records) await createUrl(record);
    records = records.filter((record) => urls.has(record.id));
    await storage.set(LIBRARY_KEY, records);
  })().catch((error: unknown) => {
    initialization = null;
    throw error;
  });
  return initialization;
}

export function listCustomEnvironments(): CustomEnvironment[] {
  return [...records];
}

export function getPanoramaUrl(id: EnvironmentId): string | undefined {
  return urls.get(id);
}

function decodeDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The selected file could not be decoded as an image.'));
    };
    image.src = url;
  });
}

export async function importPanorama(file: File): Promise<CustomEnvironment> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPEG, PNG, or WebP panorama image.');
  if (file.size > MAX_FILE_SIZE) throw new Error('Panorama images must be 64 MB or smaller.');
  await initializePanoramaLibrary();
  const dimensions = await decodeDimensions(file);
  const ratio = dimensions.width / dimensions.height;
  if (dimensions.width < 1024 || ratio < 1.85 || ratio > 2.15) {
    throw new Error('A 360 panorama must be at least 1024 pixels wide and approximately 2:1.');
  }
  const stored = await storage.putFile(file);
  const record: CustomEnvironment = {
    id: `custom:${crypto.randomUUID()}`,
    name: (file.name.replace(/\.[^.]+$/, '') || 'Custom panorama').slice(0, 60),
    fileId: stored.id,
    width: dimensions.width,
    height: dimensions.height,
    createdAt: Date.now(),
  };
  const nextRecords = [record, ...records];
  try {
    await storage.set(LIBRARY_KEY, nextRecords);
  } catch (error) {
    await storage.deleteFile(stored.id).catch(() => undefined);
    throw error;
  }
  records = nextRecords;
  urls.set(record.id, URL.createObjectURL(stored.blob));
  return record;
}

export async function deletePanorama(id: EnvironmentId): Promise<void> {
  const record = records.find((candidate) => candidate.id === id);
  if (!record) return;
  const nextRecords = records.filter((candidate) => candidate.id !== id);
  await storage.set(LIBRARY_KEY, nextRecords);
  records = nextRecords;
  const url = urls.get(id);
  if (url) URL.revokeObjectURL(url);
  urls.delete(id);
  await storage.deleteFile(record.fileId);
}

export async function deleteEnvironmentFile(fileId: string): Promise<EnvironmentId | null> {
  const record = records.find((candidate) => candidate.fileId === fileId);
  if (!record) {
    await storage.deleteFile(fileId);
    return null;
  }
  await deletePanorama(record.id);
  return record.id;
}
