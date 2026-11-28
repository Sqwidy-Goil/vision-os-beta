import { describe, expect, it } from 'vitest';
import { sanitizeSettings } from '../src/core/settings';
import { DEFAULT_SETTINGS } from '../src/types';

describe('settings validation', () => {
  it('uses safe defaults for invalid values', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ ipd: Number.NaN, quality: 'ultra', environment: 'unknown' })).toEqual(DEFAULT_SETTINGS);
  });

  it('accepts panorama and camera environments', () => {
    expect(sanitizeSettings({ environment: 'venice' }).environment).toBe('venice');
    expect(sanitizeSettings({ environment: 'loft' }).environment).toBe('loft');
    expect(sanitizeSettings({ environment: 'camera' }).environment).toBe('camera');
  });

  it('clamps numeric ranges and preserves valid choices', () => {
    const settings = sanitizeSettings({
      motionSensitivity: 9,
      ipd: 20,
      vrDistance: 99,
      fov: 10,
      distortion: -1,
      quality: 'low',
      environment: 'custom:panorama-123',
      headLockDefault: true,
      glassTransparency: 1,
      glassBlur: 99,
      defaultWindowScale: -1,
      environmentExposure: 0,
      handSmoothing: 2,
      dwellTime: 0,
      uiSoundEnabled: false,
      uiSoundVolume: 4,
    });
    expect(settings.motionSensitivity).toBe(2);
    expect(settings.ipd).toBe(50);
    expect(settings.vrDistance).toBe(12);
    expect(settings.fov).toBe(50);
    expect(settings.distortion).toBe(0);
    expect(settings.quality).toBe('low');
    expect(settings.environment).toBe('custom:panorama-123');
    expect(settings.headLockDefault).toBe(true);
    expect(settings.glassTransparency).toBe(0.95);
    expect(settings.glassBlur).toBe(40);
    expect(settings.defaultWindowScale).toBe(0.7);
    expect(settings.environmentExposure).toBe(0.6);
    expect(settings.handSmoothing).toBe(0.75);
    expect(settings.dwellTime).toBe(0.4);
    expect(settings.uiSoundEnabled).toBe(false);
    expect(settings.uiSoundVolume).toBe(1);
  });

  it('accepts known interface palettes and rejects unknown palette identifiers', () => {
    expect(sanitizeSettings({ palette: 'lagoon' }).palette).toBe('lagoon');
    expect(sanitizeSettings({ palette: 'sunset' }).palette).toBe('sunset');
    expect(sanitizeSettings({ palette: 'neon' }).palette).toBe(DEFAULT_SETTINGS.palette);
  });

  it('migrates removed procedural environments to a real panorama', () => {
    for (const environment of ['aurora', 'studio', 'cyber', 'void']) {
      expect(sanitizeSettings({ environment }).environment).toBe(DEFAULT_SETTINGS.environment);
    }
    expect(sanitizeSettings({ environment: 'custom:bad/id' }).environment).toBe(DEFAULT_SETTINGS.environment);
  });
});
