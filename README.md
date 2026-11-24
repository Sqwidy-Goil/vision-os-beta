# VISI0N SPATIAL

An iPhone-first spatial computing PWA with an Apple-inspired **Liquid Glass** design system.
Runs entirely in the browser. No build step. Deployable as static files.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The whole application (UI, apps, camera, orientation, hand tracking, service worker registration) |
| `manifest.json` | PWA manifest (name, icons, standalone display) |
| `sw.js` | Service worker — caches app shell for offline |
| `icon.svg` | App icon |
| `.nojekyll` | Tells GitHub Pages not to run Jekyll |
| `README.md` | This file |

## Deploy to GitHub Pages

1. Create a repo and push these 6 files to the **repository root**.
2. GitHub → repo → **Settings → Pages**.
3. Source: **Deploy from a branch** → Branch: `main` → Folder: `/ (root)` → Save.
4. Wait ~30 seconds. Open `https://<username>.github.io/<repo>/`.

All paths are relative — the app works from any subpath.

## Install on iPhone

1. Open the Pages URL in **Safari** (not Chrome).
2. Share → **Add to Home Screen**.
3. Launch from the home screen — it will run fullscreen without Safari chrome.

> **iOS note:** `apple-touch-icon` does not support SVG, so on the home screen iOS will use a screenshot of the page as the icon until you supply a PNG. To use a custom icon, convert `icon.svg` to `icon-192.png` / `icon-512.png` (e.g. with `rsvg-convert` or any online converter) and add them to `manifest.json`.

## What works

- **Liquid Glass material** — layered gradients, Fresnel rim, specular highlights, backdrop blur + saturation, per-environment tokens.
- **Window manager** — drag by title bar, resize by corner, focus z-stacking, per-window cleanup on close.
- **4 environments** — Dark Space, Futuristic, Light Space, Workspace. Each changes background, glass tint, specular strength, and shadow color.
- **Three quality modes** — Low / Balanced / High (blur, saturation, specular, ambient orbs).
- **8 apps** — Settings, Clock, Notes, Photos, Video, Music, Browser, 3D Viewer, plus Mini-game.
- **Camera preview** — `getUserMedia`, rear camera, streams stopped on close.
- **Orientation tracking** — iOS permission prompt, live parallax, **Recenter** button.
- **Hand tracking** — MediaPipe Tasks Vision from CDN. Cursor follows index fingertip. **Pinch = tap.** Requires HTTPS + camera permission.
- **3D Viewer** — Three.js r160 from CDN, procedural torus knot, orbit + zoom, resources disposed on close.
- **Virtual keyboard** — shift toggle, backspace, space, hide.
- **Service worker** — caches app shell, offline fallback, cache version bump on new deploy.
- **PWA manifest** — standalone display, iOS meta tags.

## What is NOT included (honest list)

| Feature | Why not |
|---|---|
| Native PNG home-screen icon | Requires binary PNGs; provide your own `icon-192.png` / `icon-512.png` |
| Full 6-DOF position tracking | Not possible with Web APIs on iOS |
| Spotify / Apple Music login | Requires a registered OAuth client ID + HTTPS redirect + secret handling; not enabled |
| Arbitrary website embedding | Most sites set `X-Frame-Options: DENY`; Browser app shows "Open in Safari" fallback |
| Native AR Quick Look from 3D Viewer | Requires a `.usdz` model hosted over HTTPS and an `<a rel="ar">` link |
| Automated test suite | No build system / test runner included; smoke-test manually |
| Offline hand-tracking inference | Model files (~5 MB) are fetched from CDN on first use; cached by the browser, not the SW |

## Physical-device tests still required

These could not be verified without a real iPhone:

- Camera permission prompt and stream lifecycle on iOS Safari
- `DeviceOrientationEvent.requestPermission()` flow
- MediaPipe hand landmarker warm-up time and inference FPS on A-series chips
- Battery drain during hand tracking
- Safe-area insets on iPhone 15 / Dynamic Island devices
- Home-screen install and fullscreen launch behavior

Please test these before relying on them in production.

## Permissions

The app requests nothing on load. Each permission is requested **only when you press the corresponding button** in Settings:

- **Camera** — for camera preview and hand tracking
- **Motion & Orientation** — for parallax tilt

You can release all sensors instantly via Settings → **Release all sensors**.

## Tech

- Plain HTML + CSS + vanilla JS ES modules (no bundler)
- Three.js and MediaPipe loaded lazily from jsDelivr only when their apps are opened
- Service worker for offline shell caching
- All media files (photos, video, music) stay on-device — nothing is uploaded

## License

MIT — do what you want.
