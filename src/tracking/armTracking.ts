import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

export class ArmTracker {
  private landmarker: PoseLandmarker | null = null;
  private loading: Promise<void> | null = null;
  private loadingGeneration = 0;
  private lastVideoTime = -1;
  private lastDetectionTime = 0;
  private generation = 0;
  private disposed = false;
  active = false;
  lastResult: NormalizedLandmark[] = [];

  constructor(private readonly onStatus: (message: string, error?: boolean) => void) {}

  async enable(): Promise<boolean> {
    if (this.disposed || this.active) return this.active;
    const generation = this.generation;
    if (!this.loading || this.loadingGeneration !== generation) {
      this.loadingGeneration = generation;
      this.loading = this.load(generation);
    }
    const loading = this.loading;
    try {
      await loading;
      if (generation !== this.generation || this.disposed) return false;
      this.active = true;
      if (this.loading === loading) this.loading = null;
      return true;
    } catch (error) {
      if (this.loading === loading) this.loading = null;
      this.onStatus(`Arm overlay unavailable: ${error instanceof Error ? error.message : 'pose model unavailable'}.`, true);
      return false;
    }
  }

  private async load(generation: number): Promise<void> {
    const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm');
    const options = {
      runningMode: 'VIDEO' as const,
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    };
    let landmarker: PoseLandmarker;
    try {
      landmarker = await PoseLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      });
    } catch {
      landmarker = await PoseLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      });
    }
    if (generation !== this.generation || this.disposed) {
      landmarker.close();
      throw new Error('Arm tracking request cancelled.');
    }
    this.landmarker = landmarker;
  }

  disable(): void {
    this.generation += 1;
    this.active = false;
    this.lastVideoTime = -1;
    this.lastDetectionTime = 0;
    this.lastResult = [];
  }

  detect(video: HTMLVideoElement, now: number): NormalizedLandmark[] {
    if (!this.active || !this.landmarker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return [];
    if (now - this.lastDetectionTime < 90 || video.currentTime === this.lastVideoTime) return this.lastResult;
    this.lastDetectionTime = now;
    if (video.currentTime < this.lastVideoTime) this.lastVideoTime = -1;
    this.lastVideoTime = video.currentTime;
    try {
      const result = this.landmarker.detectForVideo(video, now);
      this.lastResult = result.landmarks[0] ?? [];
    } catch (error) {
      this.active = false;
      this.lastResult = [];
      this.onStatus(`Arm overlay stopped: ${error instanceof Error ? error.message : 'inference failed'}.`, true);
    }
    return this.lastResult;
  }

  dispose(): void {
    this.generation += 1;
    this.disposed = true;
    this.active = false;
    this.landmarker?.close();
    this.landmarker = null;
    this.lastResult = [];
  }
}
