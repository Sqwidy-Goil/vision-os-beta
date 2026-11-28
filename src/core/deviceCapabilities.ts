export interface BluetoothDeviceSummary {
  id: string;
  name: string;
}

interface BluetoothRequestDevice {
  requestDevice(options: { acceptAllDevices: true }): Promise<BluetoothDeviceSummary>;
}

export interface GamepadSummary {
  id: string;
  index: number;
  mapping: string;
}

export interface DeviceNavigator {
  bluetooth?: BluetoothRequestDevice;
  getGamepads?: () => Array<{ id: string; index: number; mapping?: string } | null>;
  onLine?: boolean;
}

export interface DeviceStatus {
  secureContext: boolean;
  bluetooth: 'available' | 'unavailable' | 'insecure-context';
  gamepadApi: boolean;
  gamepads: GamepadSummary[];
  wifi: 'unsupported';
}

function currentNavigator(): DeviceNavigator | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator as DeviceNavigator;
}

export function readGamepads(environment: DeviceNavigator | undefined = currentNavigator()): GamepadSummary[] {
  if (typeof environment?.getGamepads !== 'function') return [];
  try {
    return environment.getGamepads().flatMap((gamepad) => gamepad ? [{
      id: gamepad.id,
      index: gamepad.index,
      mapping: gamepad.mapping || 'non-standard',
    }] : []);
  } catch {
    return [];
  }
}

export function inspectDevices(
  environment: DeviceNavigator | undefined = currentNavigator(),
  secureContext = globalThis.isSecureContext === true,
): DeviceStatus {
  const gamepads = readGamepads(environment);
  return {
    secureContext,
    bluetooth: !secureContext ? 'insecure-context' : typeof environment?.bluetooth?.requestDevice === 'function' ? 'available' : 'unavailable',
    gamepadApi: typeof environment?.getGamepads === 'function',
    gamepads,
    wifi: 'unsupported',
  };
}

export function deviceStatusText(status: DeviceStatus): string {
  const controllers = status.gamepads.length
    ? status.gamepads.map((gamepad) => `${gamepad.id} (${gamepad.mapping})`).join(', ')
    : status.gamepadApi ? 'No controller detected' : 'Gamepad API unavailable';
  const bluetooth = status.bluetooth === 'available' ? 'Bluetooth chooser available'
    : status.bluetooth === 'insecure-context' ? 'Bluetooth needs HTTPS or localhost'
      : 'Web Bluetooth unavailable';
  return `${controllers} • ${bluetooth} • Wi-Fi control unavailable in browsers`;
}

export async function requestBluetoothDevice(
  environment: DeviceNavigator | undefined = currentNavigator(),
  secureContext = globalThis.isSecureContext === true,
): Promise<BluetoothDeviceSummary> {
  if (!secureContext) throw new Error('Bluetooth device access requires HTTPS or localhost.');
  const bluetooth = environment?.bluetooth;
  if (typeof bluetooth?.requestDevice !== 'function') {
    throw new Error('Web Bluetooth is unavailable in this browser. Pair the controller in system settings and use the Gamepad API instead.');
  }
  return bluetooth.requestDevice({ acceptAllDevices: true });
}
