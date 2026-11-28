# VISI0N SPATIAL

VISI0N SPATIAL is the native iPhone application in this repository. It uses SwiftUI, CoreMotion, AVFoundation, Apple Vision, ARKit, and a custom Metal stereoscopic renderer. The primary target is iPhone 16e with iOS 18 or later, locked to a landscape user interface.

The repository also preserves an independent browser-based prototype, documented below as the companion web app.

## Native app status

The native application now has an Xcode project, shared scheme, app icon, privacy manifest, unit tests, UI tests, and a GitHub Actions iOS workflow. Compilation and physical-device behavior must be verified with Xcode or the workflow; a local Windows session cannot produce a real iOS build or signed IPA.

## Native features

- Shared SwiftUI/Metal spatial window manager with open, close, focus, move, resize, roll, depth, pin, minimize, maximize, restore, and positioning modes.
- World-locked, head-locked, and individual-yaw window behavior.
- Real side-by-side stereo rendering from parallel left/right cameras with configurable IPD, FOV, viewing distance, and lens correction.
- Gaze-dwell selection, stereoscopic reticle/progress, window cycling, touch controls, and VR exit controls.
- CoreMotion orientation at a 90 Hz target, quaternion calibration, smoothing, sensitivity, and interruption handling.
- Rear-camera capture with explicit permission and no front-camera fallback.
- On-device Apple Vision hand landmarks with pinch selection, movement, and resizing; touch remains the fallback.
- Studio, midnight, aurora, and imported equirectangular environments.
- ARKit world tracking, raw feature points, plane estimates, world-map export/import, and point metadata. This is not LiDAR mesh reconstruction.
- Functional Browser, Photos, Video Player, Camera, Music, Scanner, Files, Settings, Environment Selector, and Window Manager modules.
- App-private media storage, atomic workspace persistence, file protection, adaptive resolution, thermal/memory-aware window budgets, and a privacy manifest.

## Build and test

Requires macOS with Xcode 16.4 and an iOS 18.4 or later simulator runtime.

```bash
xcodebuild -list -project VISI0NSpatial.xcodeproj
xcodebuild test \
  -project VISI0NSpatial.xcodeproj \
  -scheme VISI0NSpatial \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 16e' \
  CODE_SIGNING_ALLOWED=NO
```

The unit suite covers window lifecycle, persistence, spatial math, stereo cameras, zero-to-one Metal depth projection, lens correction, gaze dwell, hand gestures, adaptive quality, document storage, generated textures, and scan metadata. UI tests cover launch, launcher/browser flow, settings, calibration, and the VR countdown.

## iOS CI and signing

`.github/workflows/ios-build.yml` runs project validation, Swift/Metal compilation, unit tests, and UI tests on a macOS runner. Test results are uploaded as an artifact.

A signed archive/IPA job is disabled unless the repository variable `IOS_SIGNING_ENABLED` is set to `true` and the user has explicitly configured all of these GitHub Secrets:

- `APPLE_TEAM_ID`
- `IOS_CERTIFICATE_BASE64` — base64 of a distribution `.p12`
- `IOS_CERTIFICATE_PASSWORD`
- `IOS_PROVISIONING_PROFILE_BASE64`
- `IOS_PROVISIONING_PROFILE_NAME`
- `APP_STORE_CONNECT_API_KEY_ID`
- `APP_STORE_CONNECT_API_ISSUER_ID`
- `APP_STORE_CONNECT_API_KEY_P8`

No signing material belongs in the repository. The workflow does not claim an IPA exists until export succeeds and the artifact is available.

## Native controls

- Drag empty space to look around outside VR.
- Drag a window title bar to move it, its lower-right corner to resize, and use two fingers to pinch/rotate.
- Tap close/minimize controls, or long-press a window to open its full module outside VR.
- In VR, gaze at a window and dwell to focus it; swipe up/down to cycle windows.
- Tap the upper-right exit icon in either eye, or swipe down with three fingers, to leave VR.

## Native privacy and limitations

- Camera processing and imported files stay on the device. Nothing is transmitted by the native spatial renderer.
- Photo selection uses the system picker and does not require full photo-library access.
- VR windows currently use generated module previews/control surfaces. Full application content opens in handheld/spatial mode; long-press inside VR exits to that mode rather than pretending the full module is rendered stereoscopically.
- ARKit plane and feature-point data is an approximation. The app does not claim LiDAR, dense depth-mesh, or metric reconstruction on iPhone 16e.
- Browser rendering uses WKWebView outside the Metal window. External website behavior and network access depend on the selected site.
- Cardboard comfort, lens alignment, rear-camera permission behavior, hand tracking, thermal performance, and physical-device stereo quality require an actual iPhone test.
- No private key, certificate, provisioning profile, Apple credential, signed IPA, or successful remote build is included or implied.

---

# Companion web prototype: VISI0N OS BETA

VISI0N OS BETA is a browser-based spatial computing PWA built for iPhone Safari in landscape, including manual Google Cardboard use. It is a web application, not a native iOS app or IPA.

## Features

- Three.js spatial workspace with independent floating windows and a zero-window first launch.
- Neutral Liquid Glass panels and window chrome with adjustable transparency, blur, inset highlights, subtle rims and specular effects.
- Six persistent interface palettes that theme the DOM shell, taskbar, windows, keyboard, spatial prompts and notifications from normal and VR Settings.
- Independent 6DOF windows with World, Head and Individual positioning, X/Y/Z movement, yaw/pitch/roll, uniform or aspect-preserving resize, bounded pointer inertia, snapping and persisted pose/app state. Hand release preserves the exact placed pose.
- Persistent world/surface/object anchors with confidence, follow offsets, loss handling and reload recovery; legacy Pin controls are aliases for Anchor/Release.
- Real side-by-side stereo rendering from two eye cameras, with IPD, FOV, distance and lens-correction settings.
- A compact curved Liquid Glass taskbar with smooth Follow mode, persisted World Anchored mode, recovery controls, paging and every registered app launcher. One Window mode control cycles the focused window through World, Head and Individual without changing its apparent pose.
- Capability-gated spatial analysis with Off, Economy, Camera and Full modes, live switching, relative-scale visual-inertial tracking and metric-only companion fusion. Disabling analysis does not disable VR.
- A spatial Browser with address/search entry, history, reload, home, loading/error status and an external-open fallback. Its DOM iframe follows the complete moved and rotated window plane.
- A spatial YouTube app that automatically validates a previously saved local Data API v3 key when opened, with connection testing, search results, thumbnails, pagination and genuine IFrame Player API playback outside stereo VR.
- Optional authenticated local LiDAR companion with ARKit scene depth, planes, meshes, pose, calibration, incremental updates and automatic relative-camera fallback. It is disabled by default and is not required for normal operation.
- Device-orientation controls with iOS permission handling, calibration and touch-look fallback.
- Mirrored rear-camera preview with explicit permission and no silent front-camera fallback.
- Optional global MediaPipe controls for two hands: index-finger pointing, pinch/dwell activation, one-hand manipulation, two-hand pinch resizing and panorama rotation, with GPU/CPU fallback and honest touch fallback.
- Optional MediaPipe Pose shoulder/elbow/wrist overlay above every interface; when Pose is unavailable, a clearly estimated forearm extension is drawn from the tracked wrist.
- Browser-compatible RGB feature scanning with saved, clearly labeled estimated point clouds.
- Bundled Venice 360 and Loft 360 panoramas, mirrored live camera passthrough, and a Gallery 360 card that validates, stores and activates imported 2:1 equirectangular JPEG, PNG or WebP images.
- Shared local image/video library linked to Photos and Video, plus an optional OpenAI assistant whose API key remains in memory only.
- One centralized Universal Keyboard Manager with a curved lap keyboard, floating Liquid Glass keys, French AZERTY by default, accents, symbols, a direct 123 numeric page with decimal key, and QWERTY switching. Its header cycles World, Head and Individual positioning; World remains fixed while the viewer looks around. It edits the actual focused DOM field or spatial session, supports explicit multiline input, and retains its world placement until repositioned.
- Persistent, synthesized interface sounds with trusted-gesture audio unlock, per-action throttling, five-step pitch variation, and enable/volume controls shared by DOM, canvas, keyboard, taskbar, windows and spatial input.
- Web Bluetooth device selection where supported, automatic Gamepad API controller detection, DOM focus navigation and VR cursor/look/activation through the existing input systems. Wi-Fi scanning and joining are reported honestly as unsupported by browsers.
- Central application registry and reusable spatial application API covering rendering, pointer/scroll input, 6DOF controls, focus, lifecycle and serialization; every registered app opens in a centralized VR-compatible window.
- Local Browser, YouTube, Photos, Video, Camera, Music, Scanner, Files, Notes, Spotify, Memory, Echo, Reflex, AI, LiDAR, Settings, Environments and Window Manager modules.
- Music includes three bundled CC BY 4.0 chill tracks by Kevin MacLeod, attempts autoplay when activated, advances at track end and provides an explicit Play fallback when browser policy blocks sound.
- Three hand-playable games: Memory pair matching, Echo sequence repetition and a timed Reflex target round, with shared window controls, automatic lifecycle pause, explicit Resume, sound preferences and local best scores.
- IndexedDB media/panorama/scan storage and localStorage settings/window persistence.
- Installable PWA manifest, offline app shell and Safari installation guide.

## Develop

Requires Node.js 20.19+ (Node 22 recommended).

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. For production verification:

```bash
npm run verify
```

The verification command runs ESLint, TypeScript checking, Vitest and the production build.

## GitHub Pages

The local default Vite base path is `/VISI0N-OS-BETA/`. The GitHub Pages workflow overrides it with `/vision-os-beta/` for the target repository. For another deployment path, set `VITE_BASE_PATH` before building:

```bash
VITE_BASE_PATH=/actual-repository-name/ npm run build
```

The workflow in `.github/workflows/deploy.yml` installs dependencies, verifies the project, uploads `dist/` and deploys it with the supported GitHub Pages actions. Deployment is not successful until that workflow finishes and the published URL is checked.

## Install on iPhone

1. Open the GitHub Pages site in Safari.
2. Tap the Share button.
3. Choose **Add to Home Screen**.
4. Confirm the name and tap **Add**.
5. Launch VISI0N OS from the home screen in landscape.

Safari cannot install a PWA silently. Camera and motion permissions are requested only after a user gesture.

## Controls

- Drag a window title bar to move it.
- Drag the lower-right handle, pinch with two fingers on the chrome or window content, or use two hands to resize.
- Drag the rotate and roll title-bar controls for pitch/yaw and roll; use the depth control or wheel to move closer/farther.
- Use the title-bar **Anchor** control or taskbar/Window Manager Anchor command to capture a world anchor; use **Release** to remove it.
- Drag empty canvas with the mouse or touch to look around in normal or VR mode.
- Enable **Hands** in the top bar, point with an index fingertip, then pinch or hold still for the configured delay to activate interface and spatial-window controls.
- Pinch and hold a window title bar, rotate control, or resize corner to manipulate it with one hand; bring a second hand into view and spread or close both fingertips to resize.
- Pinch empty space in Venice, Loft, Camera passthrough or an imported panorama and drag to rotate the surrounding environment.
- Choose **Arrange windows around me** in Settings or Window Manager for a world-space arc around the viewer.
- Open **Library** to preload local photos/videos, **AI** to configure an in-memory OpenAI key, or **Keyboard** to type into the last selected compatible field.
- Open **Gallery 360** in Environments to choose a local panorama. Valid images are added to the environment library and activated immediately. Images must decode correctly, be at least 1024 pixels wide and have an aspect ratio between 1.85:1 and 2.15:1; the maximum file size is 64 MB.
- Adjust glass transparency/blur, default window scale, environment exposure, hand smoothing and activation delay in Settings. Choose Glacier, Lagoon, Sunset, Orchid, Citrus or Graphite to personalize the shared interface palette. Interface sounds can be disabled and their volume adjusted independently.
- Use **123** on the universal keyboard for direct digits, decimal point, arithmetic operators and parentheses; use **ABC** to return to letters.
- Pair a standard-mapping controller in system Bluetooth settings and press a button for automatic Gamepad API detection. D-pad/left stick navigates DOM focus in normal mode or the cursor in VR; A activates, B goes back, X opens the keyboard, Start opens Settings, Y opens the launcher/Window Manager, shoulders switch windows, triggers change depth, and Home opens the guide. The device button opens the Web Bluetooth chooser only on supported secure origins; it does not guarantee controller exposure. Non-standard mappings are detected and labeled, but their button/axis meanings are not guessed.
- Open the **?** guide button for touch, hand, VR, controller, keyboard and privacy commands.
- Keyboard shortcuts: **L** launcher, **H** hands, **G** guide, **A** arrange, **K** on-screen keyboard, **P** anchor/release, **Escape** close/exit.
- In VR, mouse/touch dragging on a window title bar or manipulation control moves that window; dragging empty canvas turns the view without moving World windows. Use the compact in-scene taskbar to launch apps, switch pages, open the universal keyboard, change spatial settings and exit. Follow mode is the default; World Anchored mode captures a persistent pose and exposes working reposition/recovery controls. Bar World/Bar Follow control the taskbar; the single Window mode button cycles the focused window through World, Head and Individual while preserving its apparent pose. The keyboard header provides the same three positioning modes.
- In VR, center a control and hold gaze for the configured delay to select it when no hand is tracked.
- Browser tabs and YouTube recommendations are not implemented. Cross-origin pages may block iframe embedding; the Browser reports this and offers an external-open action.

## API configuration

- **YouTube:** save a YouTube Data API v3 key once in YouTube → Settings. Opening YouTube validates that saved local key automatically; **Test connection**, **Edit key**, **Forget** and **Search** remain available. Show/Hide only changes masking. The key is not suitable for concealing a secret in a public frontend.
- **OpenAI:** open AI, paste the key and send a prompt. The existing Chat Completions provider and `gpt-4o-mini` default are unchanged; the key stays in memory until the page is reloaded or **Forget key** is used.

## Privacy and limitations

- Camera frames, imported media, panoramas and scans stay in browser storage unless the user explicitly downloads them.
- The OpenAI key is held only in memory and is never written to localStorage, IndexedDB, cookies or source. Prompts leave the device only after **Send**; **Forget key** clears the key and chat history and cancels an active request.
- The YouTube Data API key is saved only when the user explicitly saves it, in this browser's localStorage under `vision.youtube.apiKey.v1`, and is validated automatically on later app activation. It is never placed in source or the repository. A frontend-only GitHub Pages app cannot keep an API key secret from someone with access to that browser profile; use a restricted key and never publish it.
- Bundled music is stored with the app and cached for offline use. Browsers may block autoplay until a user gesture; Music then shows an explicit **Play** control instead of claiming that sound is playing.
- Hand tracking requires a network connection the first time its WASM runtime and models are loaded; it is not faked when unavailable. Two hands and one optional upper-body pose are tracked. Pose failure leaves hand interaction available and uses an estimated forearm extension rather than claiming measured arm joints. Browser security may still require touch for websites inside cross-origin iframes.
- The hand/arm layer is a landmark visualization, not camera segmentation or a photorealistic body mask. It is drawn above the 2D interface in both monoscopic and Cardboard views; stereoscopic hand depth is not reconstructed.
- The scanner measures image features and estimates depth/geometry. Browser Camera mode uses an arbitrary relative scale; it does not claim LiDAR, ARKit or metric reconstruction. Full metric reconstruction requires the optional native companion. Browser Camera mode does not perform semantic segmentation or furniture recognition: its objects are unlabeled geometric clusters, and `semanticObjects` remains false unless a companion supplies genuinely labeled objects.
- Gyroscope and orientation sensors do not provide permanent positional tracking. Economy mode is orientation-only; lost visual/companion tracking freezes uncertain spatial followers rather than fabricating clearance.
- Many websites prohibit iframe embedding. The Browser app explains this and can open those sites in Safari. The virtual keyboard cannot bypass cross-origin iframe boundaries.
- Cross-origin iframe pixels cannot be captured into the WebGL scene, so the Browser hides its DOM iframe in stereo VR and shows an honest status/fallback. YouTube search results and thumbnails remain spatial; actual video pixels play in the genuine monoscopic player because they cannot be rendered stereoscopically.
- Stereoscopic hand depth is approximate and derived from landmarks, not metric 3D reconstruction.
- Offline support starts after the app shell has been loaded and cached. Imported IndexedDB blobs remain local and are not HTTP cache assets.
- Browsers provide no general API to scan, join or grant permission for Wi-Fi networks; `navigator.onLine` is not a Wi-Fi authorization. Web Bluetooth requires HTTPS or localhost and a user gesture, opens a per-device chooser, and is separate from Gamepad API detection. Automatic controls use the browser's standard gamepad mapping; non-standard controllers are reported without guessed commands. Controller exposure and physical Bluetooth behavior depend on the browser, operating system and hardware.
- Interface sounds are synthesized locally with Web Audio. Browsers may keep audio suspended until a trusted gesture; disabling sounds or setting volume to zero prevents new oscillator playback.
- Physical iPhone, Cardboard lens alignment, rear-camera selection, real MediaPipe inference, motion permission behavior and a physical Bluetooth controller still require device testing.
