import SwiftUI
import AVKit
import UIKit

struct CameraModuleView: View {
    @ObservedObject var coordinator: AppCoordinator

    var body: some View {
        VStack(spacing: 16) {
            CameraPreview(layer: coordinator.camera.previewLayer)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Theme.hairline))

            HStack(spacing: 14) {
                if coordinator.camera.status == .running {
                    Button("Capture") {
                        Task {
                            if let url = await coordinator.camera.capturePhoto() {
                                coordinator.showMessage("Photo saved to Files: \(url.lastPathComponent)")
                            } else {
                                coordinator.showMessage("Photo capture failed.")
                            }
                        }
                    }.buttonStyle(PrimaryButtonStyle())
                    Button("Stop Camera") {
                        Task { await coordinator.updateCamera(enabled: false) }
                    }.buttonStyle(QuietButtonStyle())
                } else {
                    Button("Enable Rear Camera") {
                        Task { await coordinator.updateCamera(enabled: true) }
                    }.buttonStyle(PrimaryButtonStyle())
                }

                Toggle("Hand Tracking", isOn: Binding(get: { coordinator.settings.handTrackingEnabled }, set: { enabled in
                    if enabled, !coordinator.settings.cameraEnabled {
                        coordinator.showMessage("Start the rear camera first.")
                    } else {
                        coordinator.setHandTracking(enabled: enabled)
                    }
                }))
                .toggleStyle(.switch).tint(Theme.cyan)

                Spacer()
                Text(coordinator.statuses[.camera] ?? "Camera off")
                    .font(Typography.caption).foregroundStyle(Theme.secondaryInk)
            }
            .padding(.horizontal, 22)

            if coordinator.permissions.cameraStatus == .denied {
                Button("Open Camera Settings") { coordinator.permissions.openSettings() }.buttonStyle(QuietButtonStyle())
            }
        }
        .padding(18)
        .onAppear {
            if coordinator.settings.cameraEnabled, coordinator.camera.status == .stopped {
                Task { await coordinator.updateCamera(enabled: true) }
            }
        }
        .onDisappear {
            if coordinator.mode == .handheld {
                Task { await coordinator.updateCamera(enabled: false) }
            }
        }
    }
}

private struct CameraPreview: UIViewRepresentable {
    let layer: AVCaptureVideoPreviewLayer

    func makeUIView(context: Context) -> PreviewContainer {
        let view = PreviewContainer()
        view.previewLayer = layer
        return view
    }

    func updateUIView(_ uiView: PreviewContainer, context: Context) {
        uiView.previewLayer = layer
    }

    final class PreviewContainer: UIView {
        var previewLayer: AVCaptureVideoPreviewLayer? {
            didSet {
                guard let previewLayer, previewLayer.superlayer !== layer else { return }
                oldValue?.removeFromSuperlayer()
                layer.addSublayer(previewLayer)
            }
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            previewLayer?.frame = bounds
        }
    }
}
