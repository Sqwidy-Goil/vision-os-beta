# VISI0N SPATIAL

A spatial computing environment for iPhone, built as a Progressive Web App with an
Apple-inspired **Liquid Glass** design system. Floating windows, a spatial dock,
rear-camera integration, device-orientation parallax, optional MediaPipe hand
tracking, four adaptive environments, and eight integrated mini-apps.

**Status:** complete rebuild from zero. No legacy code is reused.

---

## Features

| Area | What works |
|---|---|
| Spatial OS | Floating, draggable, resizable, minimizable windows; focus & z-order; dock with running indicators |
| Liquid Glass | Layered backdrop blur, gradient fresnel edges, specular highlights, thickness via inner glow, env-adaptive tints |
| Environments | Dark Space / Futuristic / Light Space / Workspace — each changes background, lighting, glass tint, text colors |
| Camera | `getUserMedia`, rear-camera preference, graceful denial handling, track cleanup |
| Orientation | iOS permission flow, low-pass smoothing, recenter, view parallax. **3-DoF only — not 6-DoF positional tracking** |
| Hand tracking | Lazy-loaded MediaPipe Hands, pinch-to-tap cursor; touch remains the primary fallback |
| Apps | Browser, Video, Photos, 3D Viewer, Music, Keyboard, Settings, Nebula Dodge (playable game) |
| PWA | `manifest.json`, service worker, offline shell cache, iOS Add-to-Home-Screen metadata |
| GitHub Pages | Fully relative paths — works at root **or** any repository subpath, no config needed |

## Quick start (no build step)

This is a zero-dependency static site on purpose (best for GitHub Pages + iOS PWA):

```bash
# from the project root
python3 -m http.server 8080
# open http://localhost:8080
```

> Camera / orientation require `https://` or `http://localhost`. On iPhone, serve via
> GitHub Pages or any HTTPS host — `file://` will not work.

## Project structure

```
index.html            app shell
manifest.json         PWA manifest
service-worker.js     offline shell cache
styles/main.css       design tokens + Liquid Glass material system
js/
  main.js             bootstrap
  core/               state (pub/sub), errors/toasts
  spatial/            environment, window manager, dock
  camera/             getUserMedia lifecycle
  orientation/        deviceorientation tracking + recenter
  tracking/           MediaPipe hand tracking (lazy CDN)
  apps/               the 8 dock applications
  services/           status bar, service worker registration
icons/                generated PWA + Apple touch icons
```

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. **Settings → Pages → Source: Deploy from a branch → `main` / `(root)`**.
3. Open `https://<user>.github.io/<repo>/` on your iPhone.

All asset paths are relative, so repository subpaths work automatically.
`.nojekyll` is included so GitHub serves files as-is.

### Install on iPhone

Safari → open the deployed URL → **Share → Add to Home Screen**.
The app launches standalone with the VISI0N icon. Note: an installed PWA is still
a web app — no native APIs beyond what Safari exposes (no true ARKit, no background
execution).

## Offline behavior

The service worker caches the shell (HTML, CSS, main JS, icons). Media-heavy apps
(3D models from CDN, hand-tracking models, streamed pages) require a connection on
first use; the 3D viewer and hand tracking then rely on browser HTTP caches.

## Permissions & privacy

- Camera and motion sensors are requested **only from a direct tap** in Settings.
- The camera stream is never recorded, transmitted, or sent anywhere — it stays in
  `<video>` elements and the local MediaPipe pipeline.
- All photo/audio/video imports use local `File` objects; nothing is uploaded.
- No analytics, no third-party data collection.

## Known limitations

- **6-DoF tracking does not exist.** Gyroscope = rotation only. The UI never claims
  otherwise.
- Browser app: many sites (`X-Frame-Options` / CSP) refuse to render in iframes;
  the app detects this and offers "Open in Safari".
- Spotify/Apple Music streaming is not integrated (requires per-user OAuth apps and
  API keys). Local audio files work instead.
- Hand tracking uses the front camera at 320×240 for performance; expect ~modest
  accuracy on older iPhones. Tested logic only — **needs validation on real hardware**.
- MediaPipe and model-viewer load from CDN; the first load needs connectivity.

## Testing

```bash
# JavaScript syntax check (Node ≥ 16)
find js service-worker.js -name '*.js' -exec node --check {} \;

# Local serve
python3 -m http.server 8080
```

Automated browser tests are intentionally minimal (the heavy 3D/tracking paths need
physical-device validation); everything else was syntax-checked and manually
code-reviewed for the failure paths listed above.

## Troubleshooting

- **Camera button does nothing** → you must be on HTTPS (or localhost) and tap from
  a user gesture. Check iOS Settings → Safari → Camera permissions.
- **Orientation toggle stays off** → iOS requires the permission prompt to come from
  a tap (it does — in Settings). If denied, re-enable in iOS Settings → Safari →
  Motion & Orientation Access.
- **Black screen after install** → hard-close the PWA and reopen; the service worker
  may still be installing on first launch.
