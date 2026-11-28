import { describe, expect, it, vi } from 'vitest';
import { deviceStatusText, inspectDevices, readGamepads, requestBluetoothDevice, type DeviceNavigator } from '../src/core/deviceCapabilities';

describe('device capabilities', () => {
  it('reports Wi-Fi as unsupported instead of treating connectivity as permission', () => {
    const status = inspectDevices({ onLine: true }, true);
    expect(status.wifi).toBe('unsupported');
    expect(status.bluetooth).toBe('unavailable');
    expect(status.gamepads).toEqual([]);
    expect(deviceStatusText(status)).toContain('Wi-Fi control unavailable');
  });

  it('requires a secure context before offering the Bluetooth chooser', async () => {
    const requestDevice = vi.fn();
    const environment: DeviceNavigator = { bluetooth: { requestDevice } };
    expect(inspectDevices(environment, false).bluetooth).toBe('insecure-context');
    await expect(requestBluetoothDevice(environment, false)).rejects.toThrow('HTTPS');
    expect(requestDevice).not.toHaveBeenCalled();
  });

  it('opens a real Bluetooth chooser without requesting unnecessary services', async () => {
    const device = { id: 'device-1', name: 'Controller' };
    const requestDevice = vi.fn(async () => device);
    const environment: DeviceNavigator = { bluetooth: { requestDevice } };
    await expect(requestBluetoothDevice(environment, true)).resolves.toBe(device);
    expect(requestDevice).toHaveBeenCalledWith({ acceptAllDevices: true });
  });

  it('explains when Web Bluetooth is unavailable', async () => {
    await expect(requestBluetoothDevice({}, true)).rejects.toThrow('system settings');
  });

  it('reads connected gamepads and tolerates restricted or failing implementations', () => {
    expect(readGamepads({
      getGamepads: () => [null, { id: 'Pad', index: 0 }, { id: 'Pad 2', index: 1, mapping: 'standard' }],
    })).toEqual([
      { id: 'Pad', index: 0, mapping: 'non-standard' },
      { id: 'Pad 2', index: 1, mapping: 'standard' },
    ]);
    expect(readGamepads({ getGamepads: () => { throw new Error('restricted'); } })).toEqual([]);
    expect(readGamepads({})).toEqual([]);
  });

  it('shows controller mapping so non-standard hardware is not overpromised', () => {
    const status = inspectDevices({
      getGamepads: () => [{ id: 'Legacy pad', index: 0, mapping: '' }],
    }, true);
    expect(deviceStatusText(status)).toContain('Legacy pad (non-standard)');
  });
});
