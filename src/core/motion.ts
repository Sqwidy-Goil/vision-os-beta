import { Euler, MathUtils, Quaternion, Vector3 } from 'three';

type PermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported';

type MotionEventWithPermission = {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

export interface GyroSample {
  /** DeviceMotionEvent timestamp in milliseconds. */
  readonly timestamp: number;
  /** Angular velocity in radians per second. */
  readonly angularVelocity: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
}

export interface MotionEnableOptions {
  gyro?: boolean;
  onGyro?: (sample: GyroSample) => void;
}

const SCREEN_TRANSFORM = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);

export class MotionController {
  private deviceQuaternion = new Quaternion();
  private relativeQuaternion = new Quaternion();
  private calibration = new Quaternion();
  private screenQuaternion = new Quaternion();
  private euler = new Euler();
  private listening = false;
  private gyroListening = false;
  private hasReading = false;
  private latestGyro: GyroSample | null = null;
  private lastGyroTimestamp: number | null = null;
  private onGyro: ((sample: GyroSample) => void) | undefined;

  enabled = false;
  permission: PermissionState = 'prompt';
  gyroPermission: PermissionState = 'prompt';
  sensitivity = 1;

  constructor(private readonly onStatus: (message: string, error?: boolean) => void) {}

  get available(): boolean {
    return 'DeviceOrientationEvent' in globalThis;
  }

  get gyroAvailable(): boolean {
    return 'DeviceMotionEvent' in globalThis;
  }

  get gyroEnabled(): boolean {
    return this.gyroListening;
  }

  get hasData(): boolean {
    return this.hasReading;
  }

  get latestGyroSample(): GyroSample | null {
    return this.latestGyro;
  }

  async enable(options: MotionEnableOptions = {}): Promise<boolean> {
    if (!this.enabled) {
      if (!this.available) {
        this.permission = 'unsupported';
        this.onStatus('Motion sensors are unavailable. Touch-look remains active.', true);
        return false;
      }
      try {
        const constructor = DeviceOrientationEvent as unknown as MotionEventWithPermission;
        if (typeof constructor.requestPermission === 'function') {
          const result = await constructor.requestPermission();
          this.permission = result;
          if (result !== 'granted') {
            this.onStatus('Motion access was not granted. Touch-look remains active.', true);
            return false;
          }
        } else {
          this.permission = 'granted';
        }
        this.enabled = true;
        this.hasReading = false;
        this.calibration.identity();
        globalThis.addEventListener('deviceorientation', this.handleOrientation, true);
        this.listening = true;
      } catch (error) {
        this.permission = 'denied';
        this.onStatus(error instanceof Error ? error.message : 'Motion access failed.', true);
        return false;
      }
    }

    let gyroIssue: string | null = null;
    if (options.gyro && !this.gyroListening) {
      gyroIssue = await this.startGyro();
    } else if (!options.gyro) {
      this.stopGyro();
    }
    this.onGyro = options.onGyro;
    if (gyroIssue) {
      this.onStatus(`Motion enabled; ${gyroIssue}`, true);
    } else {
      this.onStatus('Motion enabled. Hold the phone still to set your forward direction.');
    }
    return true;
  }

  disable(): void {
    this.enabled = false;
    if (this.listening) globalThis.removeEventListener('deviceorientation', this.handleOrientation, true);
    this.listening = false;
    this.stopGyro();
    this.hasReading = false;
    this.onStatus('Touch-look enabled.');
  }

  private async startGyro(): Promise<string | null> {
    if (!this.gyroAvailable) {
      this.gyroPermission = 'unsupported';
      return 'gyro samples are unavailable.';
    }
    try {
      const constructor = DeviceMotionEvent as unknown as MotionEventWithPermission;
      if (typeof constructor.requestPermission === 'function') {
        const result = await constructor.requestPermission();
        this.gyroPermission = result;
        if (result !== 'granted') return 'gyro access was not granted.';
      } else {
        this.gyroPermission = 'granted';
      }
      globalThis.addEventListener('devicemotion', this.handleMotion, true);
      this.gyroListening = true;
      this.latestGyro = null;
      this.lastGyroTimestamp = null;
      return null;
    } catch (error) {
      this.gyroPermission = 'denied';
      return error instanceof Error ? `gyro access failed: ${error.message}` : 'gyro access failed.';
    }
  }

  private stopGyro(): void {
    if (this.gyroListening) globalThis.removeEventListener('devicemotion', this.handleMotion, true);
    this.gyroListening = false;
    this.latestGyro = null;
    this.lastGyroTimestamp = null;
    this.onGyro = undefined;
  }

  calibrate(): void {
    if (!this.hasData) {
      this.onStatus('Waiting for the first orientation reading before calibration.', true);
      return;
    }
    this.calibration.copy(this.deviceQuaternion).invert();
    this.onStatus('Orientation calibrated. Look straight ahead to recenter.');
  }

  getTarget(): Quaternion | null {
    if (!this.enabled || !this.hasData) return null;
    this.relativeQuaternion.copy(this.calibration).multiply(this.deviceQuaternion);
    const target = new Quaternion().slerp(this.relativeQuaternion, MathUtils.clamp(this.sensitivity, 0.25, 2));
    return target;
  }

  private handleMotion = (event: DeviceMotionEvent): void => {
    if (!this.gyroListening) return;
    const rate = event.rotationRate;
    const timestamp = event.timeStamp;
    if (!rate || !Number.isFinite(timestamp)) return;
    const x = MathUtils.degToRad(rate.beta ?? Number.NaN);
    const y = MathUtils.degToRad(rate.gamma ?? Number.NaN);
    const z = MathUtils.degToRad(rate.alpha ?? Number.NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    if (this.lastGyroTimestamp !== null && timestamp <= this.lastGyroTimestamp) return;
    this.lastGyroTimestamp = timestamp;
    const sample: GyroSample = { timestamp, angularVelocity: { x, y, z } };
    this.latestGyro = sample;
    this.onGyro?.(sample);
  };

  private handleOrientation = (event: DeviceOrientationEvent): void => {
    if (event.alpha == null && event.beta == null && event.gamma == null) return;
    const alpha = MathUtils.degToRad(event.alpha ?? 0);
    const beta = MathUtils.degToRad(event.beta ?? 0);
    const gamma = MathUtils.degToRad(event.gamma ?? 0);
    this.euler.set(beta, alpha, -gamma, 'YXZ');
    this.deviceQuaternion.setFromEuler(this.euler).multiply(SCREEN_TRANSFORM);
    const screenAngle = MathUtils.degToRad(screen.orientation?.angle ?? 0);
    this.screenQuaternion.setFromAxisAngle(new Vector3(0, 0, 1), -screenAngle);
    this.deviceQuaternion.premultiply(this.screenQuaternion).normalize();
    if (!this.hasReading) {
      this.calibration.copy(this.deviceQuaternion).invert();
      this.hasReading = true;
      this.onStatus('Motion tracking active.');
    }
  };
}
