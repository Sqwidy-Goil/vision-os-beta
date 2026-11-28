# VisionCompanion

Optional native iOS/iPadOS spatial companion for the repository's browser companion protocol **v1**. Capture is disabled by default and starts only after an explicit enable action, camera permission, pairing-code entry, and authenticated WSS pairing. The package does not create a cloud service, record video, or send environmental data to third parties.

## Requirements and limitations

- iOS/iPadOS 16 or later with ARKit world tracking and LiDAR scene depth. Unsupported devices fail explicitly; depth, pose, planes, and meshes are never synthesized.
- Plane anchors and scene meshes are used when ARKit supports them. Meshes are voxel-simplified to protocol limits.
- ARKit does not provide semantic object recognition or certified free-space cells here, so `objects` and `freeSpace` remain empty.
- ARKit does not publish statistical pose covariance. The emitted 6x6 covariance is a documented conservative tracking-state envelope, not a calibrated noise estimate. Pose, surface, and calibration confidence values are likewise conservative tracking-state quality mappings, not probabilities; depth confidence comes from ARKit's confidence map.
- Build and validate in Xcode on a physical LiDAR device. The included executable is a capability probe only; it cannot capture on macOS.

## Package layout

- `VisionCompanionProtocol`: pairing cryptography, canonical encoding, VIS1 framing, HMAC-SHA256, gzip, trusted-endpoint/rate/replay validation, depth planning, and spatial wire validation.
- `VisionCompanionRuntime`: URLSession WSS transport, guest session lifecycle, ARKit capture, calibrated scene-depth/confidence extraction, intrinsics, pose, planes, meshes, and cleanup.
- `VisionCompanionCLI`: minimal capability probe.
- `Tests/VisionCompanionProtocolTests`: pure protocol, crypto, math, and validation tests that do not require ARKit or LiDAR.

## Build and test

From this directory on macOS with the required Xcode toolchain:

```sh
swift test
swift run VisionCompanionCLI
```

For an app or app extension, add this package in Xcode and link the `VisionCompanion` product. The host target must declare a non-empty `NSCameraUsageDescription`. Camera access is requested explicitly before ARKit starts. App-extension resource and entitlement constraints still need validation in the hosting app; a full iOS app is the simplest integration target.

## Trusted WSS requirement

`TrustedLocalWSS` accepts only `wss://` endpoints on private/loopback/link-local IPs, unique-local IPv6, `localhost`, `*.localhost`, or `*.local`. URLSession uses normal system TLS trust. The browser host must present a certificate trusted by the device with the correct hostname or IP subject alternative name. A self-signed certificate must be deliberately installed and trusted in the device's trust settings. There is no certificate-validation bypass, and trust failures stop capture with an explicit error.

The pairing code is the short code displayed by the browser host. The guest derives a P-256/HKDF-SHA256 session key, sends an authenticated join, verifies the authenticated ready message, and then sends `ready-ack`. Session expiry, exact sequence numbers, HMAC, frame limits, and inbound/outbound rate limits are enforced. Reconnect is manual.

## Integration sketch

```swift
let companion = VisionCompanionController(
    configuration: VisionCompanionConfiguration(
        endpoint: "wss://192.168.1.20:8443/socket",
        deviceName: UIDevice.current.name
    ),
    enabled: false
)
companion.onStatus = { status in /* Update an explicit opt-in UI. */ }
companion.setEnabled(true)
try await companion.start(pairingCode: codeFromBrowser)
// Later:
companion.stop()
```

Do not retain or log the pairing code or session key. Call `stop()` on disconnect, cancellation, scene expiry, or teardown. The controller pauses ARKit, invalidates timers, clears anchors/state, disconnects WSS, and wipes the session key.

## Coordinates, depth, and timestamps

Calibration declares `world-y-up-right-handed`, meters, identity orientation, and a session origin at the first accepted camera transform. Pose, plane, and mesh coordinates are shifted by that origin. Depth uses real ARKit scene depth plus its confidence map; intrinsics are scaled to the emitted depth resolution. Full, rectangle, and unchanged updates are emitted, using Float32LE by default or canonical base64 when selected.

Protocol sample/intrinsics/anchor timestamps are ARKit session-relative milliseconds: the first accepted frame maps to `1 ms`, then capture deltas are used. This satisfies the browser decoder's first-frame and 1000 ms interval bounds without claiming that ARKit and wall clocks share an origin. `sentAt` remains Unix wall-clock time for replay skew checks. Diagnostics retain the native capture clock and conservative target-frame-period uncertainty (at least 33.4 ms) for pose/depth association and protocol-origin mapping; no cross-device wall-clock offset is asserted.

If scene depth disappears after capture began, calibration is reset so protocol v1 does not retain stale depth implicitly. No synthetic replacement is sent.
