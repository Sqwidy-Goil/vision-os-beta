# Spatial application API

VISI0N applications run inside the shared Three.js scene. The launcher and VR taskbar use the same registry in `src/applications/registry.ts`; opening an app never requires a separate 2D interaction system.

## Register an application

```ts
import type { ApplicationDefinition } from '../types';

export const definition: ApplicationDefinition = {
  id: 'example',
  name: 'Example',
  icon: '✦',
  color: '#b694ff',
  description: 'What the app actually does.',
  stereoSafe: true,
  create: (context) => createExampleApp(context),
};
```

Add the definition to `APPLICATIONS`. IDs must be unique. `spatialOnly` hides an app from the normal launcher but keeps it available in VR. `stereoSafe` documents that the app has no monoscopic-only DOM dependency; it does not bypass browser iframe restrictions.

## Application context

`ApplicationContext` is the only host API an app receives:

- `window`: canvas, rendering requests, overlay placement and window controls.
- `requestText`, `requestUrl`, `requestConfirm`: shared modal/universal spatial keyboard input.
- `getSettings`, `updateSettings`: validated persistent settings.
- `focusWindow`, `closeWindow`, `listWindows`, `arrangeWindows`: centralized Window Manager.
- `toggleWindowAnchor`, `moveWindowDepth`: 6DOF world-pose operations.
- `getCompanionStatus`, `connectCompanion`, `disconnectCompanion`: optional local LiDAR companion.
- `pickFiles`, `openSharedFile`, `showScan`: privacy-preserving local media integration.
- `rearCamera`, `handTracker`, `toggleHandControls`: existing camera and hand pipelines.
- `notify`: shared user feedback.

Do not mutate `WindowState` directly. Use the context or `window.controls` so transforms, anchors, inertia, persistence and lifecycle stay centralized.

## Rendering and pointer input

```ts
return {
  render(ctx, width, height, time) {
    // Draw the complete current state into the window canvas.
  },
  pointer(x, y, event) {
    // Return true only when this app consumed the pointer.
    return false;
  },
  scroll(deltaY) {
    // Return true when the app has scrollable content.
    return false;
  },
  openKeyboard() {
    // Optional entry point for physical keyboard activation.
  },
};
```

Canvas coordinates are local to the app content. The scene arbitrates input in this order: universal keyboard, grabbed object/window, app content, taskbar, environment. Apps must not install competing global pointer or keyboard handlers.

Browser iframes remain monoscopic DOM overlays. In VR, cross-origin iframe pixels are unavailable; apps must provide real canvas controls and an honest external-browser action rather than simulating page contents.

## Lifecycle and state

```ts
return {
  activate() {},
  deactivate() {},
  suspend() {},
  resume() {},
  serialize() { return { /* JSON-safe app state */ }; },
  restore(value) { /* Validate unknown persisted state. */ },
  destroy() {
    // Stop timers, polling, media and object URLs.
  },
};
```

- `activate`/`deactivate`: focus changes.
- `suspend`/`resume`: background or hidden-window resource management.
- `serialize`/`restore`: app-specific state stored with the window record.
- `destroy`: release every resource owned by the app.

Long-lived network polling, audio, video and object URLs must stop when suspended or destroyed. Notes and Spotify provide reference implementations.

## Universal spatial keyboard

Use `context.requestText(options)` for text entry. In VR it opens the single curved keyboard; outside VR it uses the shared DOM adapter. The active HTML input, textarea or contenteditable remains authoritative when a real DOM field has focus.

French AZERTY is the default. Layout, dead accents, symbols, Shift, Caps Lock, editing keys and language switching are managed centrally. Apps must not create another on-screen keyboard.

## 6DOF windows

Window position, quaternion and size are authoritative; Euler rotation is derived. Supported operations include one-hand drag, two-hand resize/rotate, roll, depth, uniform/aspect resize, bounded inertia, snapping, maximize restore and world anchoring.

Use `window.controls` for title-bar actions:

```ts
context.window.controls?.toggleAnchor(context.window.id);
context.window.controls?.moveDepth(context.window.id, 0.5);
context.window.controls?.roll(context.window.id, 0.08);
```

World anchors require a trustworthy tracked transform. When tracking is unavailable, anchored windows freeze honestly instead of drifting. `arrangeWindows()` uses the shared non-overlapping arc and, only with fresh metric companion data, observed obstacle/free-space avoidance. Relative camera estimates are never treated as metric clearance.

## Spatial intelligence and companion privacy

Spatial modes are `off`, `economy`, `camera` and `full`:

- `off`: analysis stopped; VR remains available.
- `economy`: orientation only; no position or depth.
- `camera`: relative visual-inertial tracking with arbitrary scale.
- `full`: fresh calibrated companion required for metric depth, meshes and free space.

The main camera pipeline stays active in Full mode as a fallback. Companion disconnect or expiration discards stale metric data and returns to relative camera tracking without closing windows.

The companion is disabled by default. Pairing requires explicit user approval, trusted local WSS, HMAC-SHA256 frame authentication, replay/rate limits and a calibrated `world-y-up-right-handed` metre frame. Environmental recordings must remain local unless the user explicitly authorizes another destination.

## Verification checklist

Before marking an app complete:

1. Open it from both the normal launcher and VR taskbar.
2. Exercise rendering, pointer, scrolling, keyboard, focus and close.
3. Verify suspend/resume and serialize/restore.
4. Check stereo rendering and cross-origin limitations honestly.
5. Run `npm run verify`.
6. Exercise the built app in a browser; unit tests do not prove visual or hardware behavior.
