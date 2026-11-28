export interface HandInteractionFrame {
  x: number;
  y: number;
  pinching: boolean;
  progress: number;
  activate: boolean;
}

export class HandInteractionController {
  private lastX: number | null = null;
  private lastY: number | null = null;
  private pinching = false;
  private dwell = 0;
  private dwellFired = false;
  private dwellTime = 0.9;
  private movementThreshold = 20;

  configure(options: { dwellTime: number; movementThreshold?: number }): void {
    this.dwellTime = options.dwellTime;
    if (options.movementThreshold !== undefined) this.movementThreshold = options.movementThreshold;
  }

  update(x: number, y: number, pinching: boolean, delta: number): HandInteractionFrame {
    const moved = this.lastX === null || this.lastY === null || Math.hypot(x - this.lastX, y - this.lastY) > this.movementThreshold;
    const pinchStarted = pinching && !this.pinching;
    const pinchReleased = !pinching && this.pinching;
    this.lastX = x;
    this.lastY = y;
    this.pinching = pinching;

    if (moved || pinchStarted || pinchReleased) {
      this.dwell = 0;
      this.dwellFired = false;
    }
    if (pinching) this.dwell = 0;
    else if (!moved) this.dwell += delta;
    if (pinchReleased) this.dwellFired = true;

    const progress = pinching ? 1 : Math.min(this.dwell / this.dwellTime, 1);
    const activate = pinchStarted || (!pinching && !this.dwellFired && this.dwell >= this.dwellTime);
    if (activate) this.dwellFired = true;
    return { x, y, pinching, progress, activate };
  }

  reset(): void {
    this.lastX = null;
    this.lastY = null;
    this.pinching = false;
    this.dwell = 0;
    this.dwellFired = false;
  }
}
