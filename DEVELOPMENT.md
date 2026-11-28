# VISI0N SPATIAL — Native iOS Development Notes

## Architecture

- `App/` contains the SwiftUI entry point, `Info.plist`, and the `@MainActor` application coordinator.
- `Interface/` contains the Liquid Glass design system, launcher, reusable controls, and handheld HUD.
- `Spatial/Scene/` defines persisted window transforms and spatial math.
- `Spatial/Windows/WindowManager.swift` owns the shared scene state, lifecycle actions, z-order, depth, positioning, and debounced atomic persistence.
- `VR/StereoscopicRenderer/` creates separate offscreen color/depth targets for each eye, renders the same scene through distinct camera matrices, then composites both views with lens correction and gaze UI.
- `VR/EyeCameras/StereoCameraRig.swift` implements parallel stereo cameras, Metal zero-to-one projection, lens correction, and gaze-dwell state.
- `Core/Motion/`, `Core/Camera/`, `Core/Permissions/`, `Core/Persistence/`, and `Core/Performance/` provide platform services.
- `Tracking/HandTracking/` contains a testable gesture state machine and Apple Vision hand-pose processing.
- `Scanning/ARSession/ScannerService.swift` owns ARKit world tracking, plane/feature sampling, and world-map/metadata export and import.
- `Modules/` contains the router and all ten native module views.
- `tests/VISI0NSpatialTests/` covers deterministic logic; `tests/VISI0NSpatialUITests/` exercises the app shell.

## Rendering invariants

1. One `SpatialWindow` array is the source of truth for rendering, hit testing, persistence, and UI controls.
2. Stereo mode renders left and right eye targets separately; it never duplicates a single image.
3. Eye targets use half the drawable width per eye in stereo mode and full width in monoscopic mode.
4. Camera matrices, ray construction, model placement, and hit testing share the same view-distance transform.
5. Window textures are regenerated when status, lifecycle, pin state, or dimensions change.
6. The postprocess pass composites both eye textures, applies configurable radial correction, and draws separate per-eye reticles/exit controls.
7. Shader uniforms are sent with `setVertexBytes`/`setFragmentBytes`; there is no unused uniform ring buffer.

## Build and test

Open `VISI0NSpatial.xcodeproj` in Xcode 16.4. The shared `VISI0NSpatial` scheme contains the app, unit tests, and UI tests.

```bash
node scripts/validate-native-project.cjs
xcodebuild test \
  -project VISI0NSpatial.xcodeproj \
  -scheme VISI0NSpatial \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 16e' \
  -configuration Debug \
  CODE_SIGNING_ALLOWED=NO
```

The project validator parses the OpenStep project, checks references and source membership, verifies synchronized source trees, and checks asset metadata. It is not a substitute for `xcodebuild`.

## Persistence and privacy

- Workspace snapshots use versioned JSON, atomic writes, and `completeUntilFirstUserAuthentication` file protection.
- Optical, motion, camera, hand, and environment preferences use versioned `UserDefaults` data.
- Imported files live in `Documents/VISI0N-SPATIAL` and are only exported through explicit user actions.
- Photo import uses `PHPickerViewController`; camera access is requested only after a camera feature is enabled.
- `Config/PrivacyInfo.xcprivacy` declares no tracking and no collected data.
- Signing secrets are optional CI inputs and are never written into project files.

## Native limitations and QA gates

- Full SwiftUI modules are not rendered inside the Metal stereo surfaces; VR uses truthful module previews/control surfaces and hands full content off to handheld mode.
- iPhone 16e has no assumed LiDAR. The scanner exports ARKit feature points, estimated planes, and world maps, not a fabricated depth mesh.
- Camera, motion, hand tracking, and stereo comfort require a physical iPhone 16e.
- A successful simulator build does not validate Cardboard lens fit, thermal throttling, camera orientation, real gyro latency, or device signing.
- UI tests launch with `-ui-test-reset` to isolate persisted workspace state in Debug builds.

## CI

`ios-build.yml` runs simulator tests and uploads `.xcresult`. The signed archive/IPA job runs only with `IOS_SIGNING_ENABLED=true` and explicitly configured secrets documented in `README.md`. No workflow step should report an IPA without a successful export.

---

# VISI0N OS BETA — Companion Web Development Notes

## Architecture

- `src/main.ts` composes the shell, permissions, launcher, dialogs, settings and persistence.
- `src/spatial/scene.ts` owns the shared Three.js scene, camera/sensor ingestion, environments, adaptive quality, input arbitration and window/taskbar/keyboard coordination.
- `src/spatial/windowManager.ts` owns 6DOF window state, coordinate-frame conversion, bounded inertia/snapping, anchors, follow offsets and persistence. `src/spatial/window.ts` renders each application to a canvas texture on a real 3D plane.
- `src/spatial/intelligence/` implements capability gating, worker-based relative visual-inertial odometry, environment estimation, confidence/staleness and separate metric companion fusion.
- `src/spatial/taskbar.ts` owns the compact curved taskbar, Follow/World Anchored modes, recovery, paging, the single focused-window mode cycle and central application/command routing.
- `src/input/keyboardManager.ts` and `src/input/spatialKeyboard.ts` own the single active text target and curved AZERTY/QWERTY keyboard, direct numeric page and World/Head/Individual header control; `src/spatial/spatialInput.ts` is reserved for information/confirmation modals.
- `src/core/uiSound.ts` owns the singleton Web Audio feedback engine and persistent settings; `src/core/deviceCapabilities.ts` reports secure-context/Bluetooth/Gamepad capability without inventing Wi-Fi permissions.
- `src/input/gamepad.ts` polls the first standard gamepad with radial deadzones, pressed-edge detection, direction repeat and disconnect reset. `src/spatial/scene.ts` routes it through existing DOM focus and spatial cursor/activation paths.
- `src/spatial/stereo.ts` renders the shared scene through two eye cameras, composites lens-corrected left/right views and inverses lens distortion for input rays.
- `src/core/` contains rear-camera leases, motion, local-storage, settings, custom-panorama, OpenAI and companion transport services.
- `src/applications/` contains the built-in spatial applications and the registry shared by the DOM launcher and VR taskbar. `docs/spatial-application-api.md` documents the reusable app contract.
- `src/services/scanner.ts` implements feature detection, patch tracking and estimated point generation.
- `src/tracking/handTracking.ts` lazily loads MediaPipe Tasks Vision with GPU/CPU fallback and exposes real two-hand landmarks/pinch distances.
- `src/tracking/armTracking.ts` optionally loads MediaPipe Pose for shoulder, elbow and wrist landmarks; failure does not disable hand interaction.
- `src/tracking/handOverlay.ts` draws mirrored hand landmarks and measured or clearly estimated forearms above every DOM layer.
- `src/tracking/handInteraction.ts` owns the deterministic pinch-edge and stable-cursor dwell state machine.
- `src/tracking/handMapping.ts` centralizes mirrored, cover-fit camera-to-viewport mapping and pinch hysteresis/resize helpers.
- `public/environments/` contains the bundled Venice and Loft equirectangular panoramas; the service worker caches both for offline use. Imported panoramas live only in IndexedDB.
- `public/music/` contains three bundled Kevin MacLeod CC BY 4.0 chill tracks. The Music app exposes complete attribution and the service worker caches the MP3 files.
- `public/` contains the manifest, service worker, offline page and app icon.

## Development phases

### Completed in the local implementation

1. **Foundation** — TypeScript/Vite architecture, landscape shell, neutral Liquid Glass styling and responsive controls.
2. **Spatial engine** — shared 3D scene, textured 6DOF windows, coordinate-frame-safe positioning, persistent anchors/follow offsets and window interaction guards.
3. **Cardboard VR** — dual eye cameras, stereo compositing, IPD/FOV/distance/distortion controls and configurable gaze dwell.
4. **Motion and interaction** — iOS permission flow, calibration, smoothing, touch-look, content-originated multitouch resize and global hand controls.
5. **Camera and tracking** — environment-facing camera preference, explicit front-camera rejection, two-hand MediaPipe landmarks, pinch hysteresis, one-hand manipulation and two-hand resize.
6. **Environments** — Venice/Loft 360 panoramas, mirrored camera passthrough, a Gallery 360 file-picker card and validated local 360 imports, with gesture rotation and surround arrangement.
7. **Scanning** — grayscale feature detection, patch tracking, estimated point clouds, IndexedDB save/reload.
8. **Applications** — central registry for Browser, YouTube, Photos, Video, Camera, Music, Scanner, Files, Notes, Spotify, Memory, Echo, Reflex, AI, LiDAR, Settings, Environments and Windows, with lifecycle and nonsecret state serialization.
9. **PWA/offline** — manifest, service worker, offline fallback and installation instructions.
10. **Verification/deployment** — automated tests, lint/typecheck/build workflow, CDP browser regressions and a prepared Pages deployment workflow.

### Local browser verification — 2026-11-26

- `npm run verify` passes ESLint, TypeScript, the Vitest suite and the production build.
- `.tools/keyboard-check.mjs` uses real Chrome pointer input at 874×430 to verify target retention, character entry, Shift/Caps, Backspace, Enter, Close and reopen without console errors.
- `.tools/integration-check.mjs` verifies custom panorama import/activation/reload/deletion fallback, shared image/video selection races, in-memory AI authorization/cancellation, pin guards/persistence, content-originated touch pinch, synthetic two-hand resize/release suppression, duplicate-window prevention and offline service-worker reload without console errors.
- Headless Chrome at 874×430 launches the spatial apps, persists settings and renders distinct left/right Cardboard views without console errors.
- Window drag, depth scrolling, maximize/restore, anchoring modes, pinch resize, rotate, resize grip, minimize/restore, close and empty-state recovery pass.
- Environment changes persist; browser address entry and sandboxed iframe projection align with the spatial window.
- The Hands/Guide controls fit the landscape top bar; the guide opens, surround arrangement persists world-space positions/sizes, and camera denial cleanly disables hand mode without errors.
- `.tools/immersive-check.mjs` verifies zero startup windows, both panorama textures and screenshots, a synthetic mirrored camera sphere, hand-driven panorama rotation, table placement/drag/re-anchoring/reload persistence, foreground hand pixels over settings/modal/launcher, retained VR overlay and a visible browser start screen.
- `.tools/hand-integration-check.mjs` verifies cursor mapping, dwell/pinch DOM activation, 3D title-bar drag/close and tracker cleanup with deterministic camera/MediaPipe stubs; this does not replace real camera inference.
- Camera permission denial reports an error without an unhandled rejection.
- Manifest PNG icons load, the service worker controls the page and an offline reload restores the cached shell and saved windows.
- Physical iPhone 16e Safari/Cardboard QA, real MediaPipe hand/pose inference and the remote GitHub Actions Pages run remain outstanding.

### VR expansion verification — 2026-11-27

- `.tools/vr-expansion-check.mjs` passes 68/68 checks in a fresh isolated Chrome context at 874×430, with no uncaught runtime errors or warnings.
- The in-scene taskbar stays inside the eye viewport; stereo cameras retain 64 mm separation and produce distinct left/right images. All 13 applications launch, paging keeps the Taskbar return control visible, gaze opens AI once, and hand input takes precedence over gaze.
- Browser address entry, Clear, right-eye QWERTY targeting, history, external-open fallback, pinned content, press/release activation, title dragging, position persistence, one-hand pinch resize and two-hand resize pass.
- YouTube key save/mask/show/hide, mocked Data API search/thumbnails/pagination, shared hand scrolling, scroll-activation suppression, honest stereo-video refusal and VR state retention pass. The monoscopic selection invokes the IFrame Player API path through a deterministic player mock.
- The existing OpenAI provider/default model, in-memory key, response and cancellation paths pass with mocked network responses. Final cleanup leaves zero windows, overlays and open input; hand detection and animation each ran 43 times in the sampling window.
- `.tools/vr-expansion-initial.png`, `.tools/vr-expansion-input.png`, `.tools/vr-expansion-stereo.png` and `.tools/vr-expansion-youtube.png` were inspected: the taskbar, keyboard, browser and YouTube results remain spatial and readable, with visible stereo differences. These checks do not replace physical iPhone, real MediaPipe inference or live credentialed API testing.

### Spatial OS verification — 2026-11-28

- `npm run verify` passes ESLint, TypeScript, all 259 Vitest tests across 33 files and the production Vite build.
- `.tools/spatial-os-check.mjs` passes 72/72 checks in a fresh isolated Chrome context at 874×430 with no uncaught runtime errors or warnings.
- New windows default to World positioning, legacy accidental Head locks migrate without discarding their apparent world pose, and deliberate Head positioning persists. A single taskbar Window mode button cycles the focused window through World, Head and Individual while preserving its apparent pose; the no-focused-window case reports an honest message.
- The VR reticle and progress ring are hidden without disabling gaze input. Glass transparency affects application content and the monoscopic Browser iframe. The iframe is projected from all four window corners, follows translation/rotation/perspective and begins below the title bar instead of appearing pinned to one corner.
- The universal keyboard opens anchored in world space, renders floating Liquid Glass keys and a thin current-text preview, and exposes a header button cycling World, Head and Individual. Head follows camera position/orientation, Individual keeps its position while following orientation, and World has zero measured drift during head movement. Same-origin DOM fields receive the preview text and real submission; cross-origin documents remain inaccessible.
- Exact positive/negative X, Y and Z translation, distinct yaw/pitch/roll quaternions, two-hand resize, anchor following, 90-degree head-rotation stability and the anchored taskbar's 180-degree turn/move/return behavior pass. A hand-placed World window has zero measured drift after release even with inertia and snapping enabled.
- Real Chrome mouse events retain their physical pointer ID instead of becoming synthetic hand input. Pointer capture keeps a drag active until release; title-bar dragging moves a World window, dragging empty canvas turns the view with zero measured World-window drift, and mouse clicks activate window content and the spatial keyboard without leaving pointer state behind.
- Taskbar controls distinguish Bar World/Bar Follow from the single focused-window mode cycle. World Reposition moves and persists the bar relative to the current camera, while unrelated settings changes leave its anchor untouched.
- Environments exposes an actionable Gallery 360 card. A real 2048×1024 fixture is validated, stored in IndexedDB, activated through an object URL, rendered as a panorama and listed in the local environment library.
- Taskbar-launched Internet address entry commits `http://localhost:5173/`. A previously saved local YouTube key is validated once on activation without entering serialized app state; YouTube commits the typed `vision` query; Spotify search and playback controls execute through an explicitly deterministic service fixture. All remaining registered applications still render in centralized VR windows.
- Three bundled Kevin MacLeod chill tracks are CC BY 4.0 attributed and cached for offline use. Chrome loads real MP3 metadata, honestly reports blocked autoplay, starts playback after a trusted Play gesture, advances through Previous/Next/ended and pauses on close. After an autoplay refusal, focus no longer retries playback before an explicit gesture.
- Six persisted interface palettes update the DOM theme, taskbar, window chrome, keyboard, input prompts and notifications. Normal Settings selection and the hand-pinchable VR Settings row both propagate the selected palette through shared surfaces.
- Memory, Echo and Reflex use the central registry, hand/gaze/touch actions and window lifecycle. Memory pair matching, Echo sequence advancement, Reflex target hits, sound preferences, best-score persistence, automatic lifecycle pause and explicit hand-controlled Pause/Resume pass. A focus event no longer clears a deliberate pause.
- Curved AZERTY input, French dead accents, centralized field focus, cross-origin iframe hiding and the prohibition on automatic external opening pass. Browser hand landmarks are deterministic fixtures, not real MediaPipe inference.
- A protocol-shaped calibrated companion fixture activates metric fusion, moves an arranged window clear of an unlabeled metric obstacle, expires into relative Camera mode with an explicit expiry reason, recovers Full mode from fresh data without restart and falls back again on disconnect. `semanticObjects` remains false for the unlabeled fixture.
- Spatial Off mode releases the analysis camera while preserving VR, windows and taskbar; Camera mode reactivates without restart and skips over-frequent frames. Adaptive quality reduces and restores render resolution from measured frame rate.
- Six hundred sustained VR animation frames preserve the active window/camera, recover no runtime errors and keep geometry count stable; texture count remains bounded. Final cleanup leaves zero windows, overlays and open keyboard input.
- `.tools/spatial-os-initial.png`, `.tools/spatial-os-azerty.png`, `.tools/spatial-os-gallery.png`, `.tools/spatial-os-music.png`, `.tools/spatial-os-browser-address.png`, `.tools/spatial-os-fallback.png`, `.tools/spatial-os-browser-normal.png`, `.tools/spatial-os-browser-projection.png`, `.tools/spatial-os-palette.png`, `.tools/spatial-os-memory.png`, `.tools/spatial-os-echo.png`, `.tools/spatial-os-reflex.png` and `.tools/spatial-os-mouse-look.png` were captured for visual review. These local checks do not verify native Swift compilation, real LiDAR/ARKit behavior, physical iPhone 16e thermals or stereo comfort, real hand/pose inference, live credentialed APIs or deployment.

### Numeric input, sound and controller verification — 2026-11-28

- Two complete `npm run verify` passes each pass ESLint, TypeScript, all 282 Vitest tests across 36 files and the production Vite build.
- `scripts/validate-native-project.cjs` passes in both verification rounds: 91 project objects, 52 explicit/synchronized files, target source membership, Release tests, privacy declarations and stereo shader entry points.
- Two fresh `.tools/spatial-os-check.mjs` Chrome runs at 874×430 each pass 97/97 checks with no unexpected runtime errors or warnings and clean window/overlay/keyboard teardown.
- The universal keyboard's numeric page enters direct digits and a decimal point, exposes reachable Shift symbols and returns to letters with ABC. Controller A enters `12.5` through the real spatial keyboard.
- One lazily unlocked Web Audio context synthesizes interface feedback. Mute prevents new oscillator starts, volume persists through shared settings and re-enabling sounds resumes playback.
- The device control invokes the real Web Bluetooth chooser contract with only `acceptAllDevices`, reports unavailable Bluetooth honestly and always identifies Wi-Fi scanning/joining as unsupported by browsers.
- Deterministic Gamepad API fixtures verify connection/disconnect, standard-mapping preference, non-standard mapping refusal, DOM focus/navigation/activation, analog cursor and camera movement, window switching/depth, numeric input and VR prompt arbitration. Back dismisses an information prompt without exiting VR; unrelated controller commands cannot replace it.
- Regression coverage also verifies one sound per close action, suspended-audio silence, modal isolation from hidden settings/background windows, same-frame Back+A arbitration, controller identity by index, VR transitions without fake reconnects and camelCase/hash credential removal from saved Browser URLs.
- The Pages workflow builds with `/vision-os-beta/`, matching the target repository URL rather than the uppercase local development path.
- `.tools/spatial-os-gamepad-keyboard.png`, `.tools/spatial-os-gamepad-guide.png` and `.tools/spatial-os-device-settings.png` were inspected. These checks use browser fixtures and do not claim physical Bluetooth controller compatibility, real MediaPipe inference or native hardware validation.

## Known limitations

- Browser Camera mode is relative-scale and never claims metric clearance. Full metric data requires the optional native LiDAR companion; gyroscope-only Economy mode cannot provide permanent positional tracking. Browser Camera mode does not implement semantic segmentation or furniture/object recognition; its objects are unlabeled geometric clusters. Semantic capability is reported only for genuinely labeled companion objects, and the current native companion does not generate those labels.
- Hand tracking model/WASM assets are fetched from MediaPipe/CDN hosts on first use and may be blocked offline or by network policy.
- Global hand input tracks two hands but cannot synthesize trusted keyboard input or reach inside cross-origin iframes; the on-screen keyboard and touch remain available for those cases.
- Browser iframe support depends on each site's headers. Cross-origin iframe pixels are not captured into the stereo WebGL scene; the DOM iframe is hidden in VR and the spatial Browser presents status/external-open controls.
- YouTube Data API search is real, but automated local checks mock network responses. IFrame Player API playback is genuine and monoscopic; video pixels are not rendered in stereo VR. Recommendations and Browser tabs are not implemented.
- The YouTube key is explicitly persisted in browser localStorage and cannot be secret from someone with access to that profile. The OpenAI key remains in memory only.
- iOS Safari may report an unknown camera facing mode; the app reports this instead of claiming a rear camera.
- CSS orientation locking is not assumed; portrait users receive a rotate instruction.
- Service-worker caching cannot include private IndexedDB blobs as HTTP assets; those records remain available locally through IndexedDB.
- Browsers cannot authorize Wi-Fi scanning/joining. Web Bluetooth requires a secure origin and user gesture, exposes only the chosen device and does not guarantee that the operating system exposes it through the Gamepad API. Automatic controls require the browser's standard gamepad mapping; non-standard devices are detected and labeled without guessed button/axis commands. Physical controller compatibility remains hardware-dependent.
- Web Audio may remain suspended until a trusted gesture. Sound settings persist locally; mute and zero volume suppress new synthesized playback. Local gamepad tests use a deterministic Gamepad API fixture, not a physical Bluetooth controller.

## Device QA checklist

- [ ] iPhone 16e landscape layout and safe-area insets.
- [ ] Add to Home Screen launch and standalone behavior.
- [ ] Rear-camera permission and actual environment-facing selection.
- [ ] Motion permission, calibration and 360-degree response.
- [ ] Window drag/resize/rotate/depth and state restoration.
- [ ] Left/right perspective difference, Cardboard lens alignment and in-scene taskbar readability.
- [ ] Taskbar gaze/pinch selection, menus, paging and application launching in standalone VR.
- [ ] Offline reload after the app shell has been cached.
- [ ] Local media import/playback/deletion and scan save/reload.
- [ ] Hand tracking model load, two-hand landmarks, pinch/dwell activation, one-hand window drag/resize, two-hand resize and clean camera/tracker shutdown.
- [ ] Browser address entry, navigation, scrolling, window manipulation and iframe restrictions with real hand input.
- [ ] YouTube Data API key restrictions, live search/thumbnails and genuine monoscopic playback.
- [ ] OpenAI live response and request cancellation with the in-memory key.
- [ ] Imported panorama validation, reload persistence and deletion on a physical iPhone.
- [ ] Universal curved AZERTY/numeric keyboard, decimal entry, dead accents, multiline Enter, cancellation and actual focused-field editing in standalone Safari.
- [ ] Persistent interface sound unlock, mute/volume and absence of duplicate or runaway playback in standalone Safari.
- [ ] Physical Bluetooth pairing, Web Bluetooth chooser behavior and Gamepad API detection/navigation with a real controller.
- [ ] Optional native companion build, trusted local pairing, LiDAR calibration/connect/disconnect and camera-mode fallback on physical hardware.

## Future improvements

- Improve scan geometry with bundle adjustment when feasible on device.
- Add adaptive hand-tracking cadence based on measured frame cost.
- Promote the local CDP permission-denied, browser-overlay and offline checks into a maintained browser-test suite.
