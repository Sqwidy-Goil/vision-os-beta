import type { ApplicationDefinition } from '../types';
import { createCameraApp, createScannerApp } from './cameraScanner';
import { createMusicApp, createPhotosApp, createVideoApp } from './media';
import { createAiApp, createLibraryApp } from './workspace';
import { createYouTubeApp } from './youtube';
import { createBrowserApp, createEnvironmentsApp, createFilesApp, createSettingsApp, createWindowManagerApp } from './system';
import { createNotesApp } from './notes';
import { createSpotifyApp } from './spotify';
import { createCompanionApp } from './companion';
import { createEchoApp, createMemoryApp, createReflexApp } from './games';

export const APPLICATIONS: ApplicationDefinition[] = [
  { id: 'browser', name: 'Internet', icon: '◉', color: '#75e7ff', description: 'Browse compatible sites in a spatial window.', create: createBrowserApp },
  { id: 'youtube', name: 'YouTube', icon: '▶', color: '#ff8f9d', description: 'Search and play YouTube in a spatial window.', create: createYouTubeApp },
  { id: 'photos', name: 'Photos', icon: '✦', color: '#b694ff', description: 'Private local photo library.', create: createPhotosApp },
  { id: 'notes', name: 'Notes', icon: '✎', color: '#ffd28a', description: 'Write and autosave private notes locally.', stereoSafe: true, create: createNotesApp },
  { id: 'spotify', name: 'Spotify', icon: '♫', color: '#78f0a8', description: 'Control Spotify Connect from a spatial remote.', stereoSafe: true, create: createSpotifyApp },
  { id: 'memory', name: 'Memory', icon: '✦', color: '#b694ff', description: 'Match symbol pairs with hand-controlled cards.', stereoSafe: true, create: createMemoryApp },
  { id: 'echo', name: 'Echo', icon: '◉', color: '#78f0d0', description: 'Repeat an expanding light and sound sequence.', stereoSafe: true, create: createEchoApp },
  { id: 'reflex', name: 'Reflex', icon: '↯', color: '#ffb37c', description: 'Hit expiring targets in a 30-second hand reflex round.', stereoSafe: true, create: createReflexApp },
  { id: 'video', name: 'Video', icon: '▶', color: '#ff9db0', description: 'Play local video files.', create: createVideoApp },
  { id: 'camera', name: 'Camera', icon: '◫', color: '#7cf5c8', description: 'Rear camera and optional hand tracking.', create: createCameraApp },
  { id: 'music', name: 'Music', icon: '♫', color: '#ffd28a', description: 'Play local audio files.', create: createMusicApp },
  { id: 'scanner', name: '3D Scanner', icon: '◈', color: '#75e7ff', description: 'Capture an estimated RGB point cloud.', create: createScannerApp },
  { id: 'files', name: 'Files', icon: '▤', color: '#9fc5ff', description: 'Manage local files and saved scans.', create: createFilesApp },
  { id: 'settings', name: 'Settings', icon: '⚙', color: '#c7d5e8', description: 'Motion, rendering and VR controls.', create: createSettingsApp },
  { id: 'companion', name: 'LiDAR', icon: '⌁', color: '#78f0d0', description: 'Pair an optional local ARKit/LiDAR spatial sensor.', stereoSafe: true, create: createCompanionApp },
  { id: 'environments', name: 'Environments', icon: '◎', color: '#78f0d0', description: 'Switch immersive spaces.', create: createEnvironmentsApp },
  { id: 'windows', name: 'Windows', icon: '▣', color: '#aebaff', description: 'Focus, anchor and close spatial windows.', create: createWindowManagerApp },
  { id: 'library', name: 'Library', icon: '▤', color: '#9fc5ff', description: 'Open shared local photos and videos.', spatialOnly: true, create: createLibraryApp },
  { id: 'ai', name: 'AI', icon: '✦', color: '#b694ff', description: 'Private in-memory OpenAI assistant.', spatialOnly: true, create: createAiApp },
];

const APPLICATION_MAP = new Map(APPLICATIONS.map((application) => [application.id, application]));

export function getApplication(id: string): ApplicationDefinition | undefined {
  return APPLICATION_MAP.get(id);
}
