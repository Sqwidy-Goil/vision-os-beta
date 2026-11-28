import { describe, expect, it } from 'vitest';
import { APPLICATIONS, getApplication } from '../src/applications/registry';

describe('central application registry', () => {
  it('exposes Notes, Spotify, LiDAR and hand games to both the launcher and VR taskbar', () => {
    expect(getApplication('notes')?.create).toBeTypeOf('function');
    expect(getApplication('spotify')?.create).toBeTypeOf('function');
    expect(getApplication('companion')?.create).toBeTypeOf('function');
    expect(getApplication('memory')?.create).toBeTypeOf('function');
    expect(getApplication('echo')?.create).toBeTypeOf('function');
    expect(getApplication('reflex')?.create).toBeTypeOf('function');
    expect(getApplication('spotify')?.stereoSafe).toBe(true);
    expect(getApplication('companion')?.stereoSafe).toBe(true);
    expect(getApplication('memory')?.stereoSafe).toBe(true);
    expect(getApplication('echo')?.stereoSafe).toBe(true);
    expect(getApplication('reflex')?.stereoSafe).toBe(true);
  });

  it('keeps application identifiers unique', () => {
    expect(new Set(APPLICATIONS.map((application) => application.id)).size).toBe(APPLICATIONS.length);
  });
});
