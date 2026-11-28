import {
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';

const VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;
  varying vec2 vUv;
  uniform sampler2D tLeft;
  uniform sampler2D tRight;
  uniform float distortion;

  vec2 correctLens(vec2 uv) {
    vec2 p = uv * 2.0 - 1.0;
    float r2 = dot(p, p);
    p *= 1.0 + distortion * r2 + distortion * 0.35 * r2 * r2;
    return p * 0.5 + 0.5;
  }

  void main() {
    float rightEye = step(0.5, vUv.x);
    vec2 eyeUv = vec2(fract(vUv.x * 2.0), vUv.y);
    vec2 corrected = correctLens(eyeUv);
    if (corrected.x < 0.0 || corrected.x > 1.0 || corrected.y < 0.0 || corrected.y > 1.0) {
      gl_FragColor = vec4(0.005, 0.01, 0.02, 1.0);
      return;
    }
    gl_FragColor = mix(texture2D(tLeft, corrected), texture2D(tRight, corrected), rightEye);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function eyeCameraPositions(ipdMillimeters: number): [number, number] {
  const separation = Math.max(0, ipdMillimeters) / 1000;
  if (separation === 0) return [0, 0];
  return [-separation / 2, separation / 2];
}

export function undoLensDistortion(u: number, v: number, distortion: number): { u: number; v: number } {
  const distortedX = u * 2 - 1;
  const distortedY = v * 2 - 1;
  const distortedRadius = Math.hypot(distortedX, distortedY);
  if (distortedRadius === 0) return { u: 0.5, v: 0.5 };
  const quadratic = distortion;
  const quartic = distortion * 0.35;
  let radius = distortedRadius;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const radiusSquared = radius * radius;
    const value = radius * (1 + quadratic * radiusSquared + quartic * radiusSquared * radiusSquared) - distortedRadius;
    const derivative = 1 + 3 * quadratic * radiusSquared + 5 * quartic * radiusSquared * radiusSquared;
    radius = Math.max(0, radius - value / derivative);
  }
  const radiusSquared = radius * radius;
  const scale = 1 + quadratic * radiusSquared + quartic * radiusSquared * radiusSquared;
  return {
    u: (distortedX / scale) * 0.5 + 0.5,
    v: (distortedY / scale) * 0.5 + 0.5,
  };
}

export class StereoRenderer {
  readonly leftCamera = new PerspectiveCamera(70, 1, 0.05, 100);
  readonly rightCamera = new PerspectiveCamera(70, 1, 0.05, 100);
  private leftTarget: WebGLRenderTarget;
  private rightTarget: WebGLRenderTarget;
  private compositeScene = new Scene();
  private compositeCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private compositeMaterial: ShaderMaterial;
  private logicalWidth = 1;
  private logicalHeight = 1;
  private ipdMillimeters = 64;
  private fov = 70;
  private distortion = 0.08;

  constructor(private readonly renderer: WebGLRenderer) {
    this.leftTarget = new WebGLRenderTarget(1, 1, { depthBuffer: true });
    this.rightTarget = new WebGLRenderTarget(1, 1, { depthBuffer: true });
    this.compositeMaterial = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        tLeft: { value: this.leftTarget.texture },
        tRight: { value: this.rightTarget.texture },
        distortion: { value: this.distortion },
      },
      depthTest: false,
      depthWrite: false,
      toneMapped: true,
    });
    const quad = new Mesh(new PlaneGeometry(2, 2), this.compositeMaterial);
    quad.frustumCulled = false;
    this.compositeScene.add(quad);
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.logicalWidth = Math.max(1, Math.floor(width));
    this.logicalHeight = Math.max(1, Math.floor(height));
    const physicalWidth = Math.max(1, Math.floor(width * pixelRatio));
    const physicalHeight = Math.max(1, Math.floor(height * pixelRatio));
    const eyeWidth = Math.max(1, Math.floor(physicalWidth / 2));
    this.leftTarget.setSize(eyeWidth, physicalHeight);
    this.rightTarget.setSize(eyeWidth, physicalHeight);
    const aspect = eyeWidth / physicalHeight;
    this.leftCamera.aspect = aspect;
    this.rightCamera.aspect = aspect;
    this.updateProjection();
  }

  setSettings(ipdMillimeters: number, fov: number, distortion: number): void {
    this.ipdMillimeters = ipdMillimeters;
    this.fov = fov;
    this.distortion = distortion;
    this.compositeMaterial.uniforms.distortion.value = distortion;
    this.updateProjection();
  }

  private updateProjection(): void {
    this.leftCamera.fov = this.fov;
    this.rightCamera.fov = this.fov;
    this.leftCamera.updateProjectionMatrix();
    this.rightCamera.updateProjectionMatrix();
  }

  render(scene: Scene, position: Vector3, orientation: Quaternion): void {
    const [left, right] = eyeCameraPositions(this.ipdMillimeters);
    this.leftCamera.position.set(left, 0, 0).applyQuaternion(orientation).add(position);
    this.rightCamera.position.set(right, 0, 0).applyQuaternion(orientation).add(position);
    this.leftCamera.quaternion.copy(orientation);
    this.rightCamera.quaternion.copy(orientation);
    this.leftCamera.updateMatrixWorld();
    this.rightCamera.updateMatrixWorld();

    this.renderer.setScissorTest(false);
    this.renderer.setRenderTarget(this.leftTarget);
    this.renderer.clear();
    this.renderer.render(scene, this.leftCamera);
    this.renderer.setRenderTarget(this.rightTarget);
    this.renderer.clear();
    this.renderer.render(scene, this.rightCamera);

    this.renderer.setRenderTarget(null);
    this.renderer.setViewport(0, 0, this.logicalWidth, this.logicalHeight);
    this.renderer.setScissorTest(false);
    this.renderer.clear();
    this.renderer.render(this.compositeScene, this.compositeCamera);
  }

  get eyeSize(): Vector2 {
    return new Vector2(this.leftTarget.width, this.leftTarget.height);
  }

  dispose(): void {
    this.leftTarget.dispose();
    this.rightTarget.dispose();
    this.compositeMaterial.dispose();
    this.compositeScene.traverse((object) => {
      if (object instanceof Mesh) object.geometry.dispose();
    });
  }
}
