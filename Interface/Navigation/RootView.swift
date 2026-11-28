import SwiftUI

struct RootView: View {
    @StateObject private var coordinator = AppCoordinator()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            LinearGradient(colors: [Theme.backgroundTop, Theme.backgroundBottom], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()

            MetalSpatialView(
                windowManager: coordinator.windowManager,
                settings: coordinator.settings,
                motion: coordinator.motion,
                environment: coordinator.settings.environmentKind,
                stereoscopic: coordinator.mode == .vr,
                isActive: scenePhase == .active,
                statuses: coordinator.statuses,
                panoramaURL: coordinator.settings.panoramaURL,
                onWindowOpen: { coordinator.openWindow($0) },
                onExitVR: { coordinator.exitVR() },
                onCycleWindow: { coordinator.windowManager.cycleSelection(reverse: $0) },
                onFrame: { coordinator.renderSnapshot = $0 },
                onError: { coordinator.renderError = $0 }
            )
            .ignoresSafeArea()

            if coordinator.mode != .vr {
                HandheldHUD(coordinator: coordinator, windowManager: coordinator.windowManager)
            }

            if let notice = coordinator.notice, coordinator.mode != .vr {
                VStack {
                    Spacer()
                    Text(notice)
                        .font(Typography.caption)
                        .foregroundStyle(Theme.ink)
                        .multilineTextAlignment(.center)
                        .padding(14)
                        .background(.ultraThinMaterial, in: Capsule())
                        .padding(.horizontal, 30)
                        .padding(.bottom, 112)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .preferredColorScheme(.dark)
        .sheet(item: $coordinator.activeModule) { module in
            ModuleContentView(module: module, coordinator: coordinator)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $coordinator.showCalibration) {
            CalibrationView(
                settings: coordinator.settings,
                motion: coordinator.motion,
                onEnter: { coordinator.enterVR() },
                onCancel: { coordinator.showCalibration = false }
            )
            .presentationDetents([.large])
            .interactiveDismissDisabled()
        }
        .alert("Spatial renderer", isPresented: Binding(
            get: { coordinator.renderError != nil },
            set: { if !$0 { coordinator.renderError = nil } }
        )) {
            Button("OK") { coordinator.renderError = nil }
        } message: {
            Text(coordinator.renderError ?? "")
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                if coordinator.settings.motionEnabled, coordinator.mode != .handheld {
                    coordinator.motion.start()
                }
                coordinator.permissions.refresh()
                if coordinator.settings.cameraEnabled, coordinator.camera.status != .running, coordinator.activeModule != .scanner {
                    Task { await coordinator.updateCamera(enabled: true) }
                }
            case .background:
                coordinator.flush()
                coordinator.motion.stop()
                coordinator.stopCameraSession()
            case .inactive:
                coordinator.flush()
            @unknown default:
                break
            }
        }
        .onChange(of: coordinator.settings.motionEnabled) { _, enabled in
            if enabled, coordinator.mode != .handheld {
                coordinator.motion.start()
            } else {
                coordinator.motion.stop()
            }
        }
        .onAppear {
            if coordinator.settings.motionEnabled {
                coordinator.motion.start()
            }
        }
    }
}

private struct HandheldHUD: View {
    @ObservedObject var coordinator: AppCoordinator
    @ObservedObject var windowManager: WindowManager

    var body: some View {
        VStack {
            HStack(spacing: 14) {
                HStack(spacing: 10) {
                    Text("V0").font(.system(size: 22, weight: .bold, design: .rounded)).foregroundStyle(Theme.cyan)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(AppConfiguration.productName).font(Typography.headline).foregroundStyle(Theme.ink)
                        Text(coordinator.mode == .spatial ? "Spatial mode" : "Handheld workspace")
                            .font(Typography.caption).foregroundStyle(Theme.secondaryInk)
                    }
                }
                Spacer()
                StatusPill(text: motionSummary, color: motionColor)
                if coordinator.settings.cameraEnabled {
                    StatusPill(text: "Rear camera", color: coordinator.camera.status == .running ? Theme.cyan : .orange)
                }
                Button(coordinator.mode == .spatial ? "Handheld" : "Spatial") {
                    coordinator.toggleSpatialMode()
                }
                .buttonStyle(QuietButtonStyle())
                Button("Enter VR") {
                    coordinator.showCalibration = true
                    if coordinator.settings.motionEnabled {
                        coordinator.motion.start()
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .accessibilityIdentifier("enter-vr")
            }
            .padding(.horizontal, 24)
            .padding(.top, 18)

            if let message = windowManager.resourceMessage ?? windowManager.persistenceError {
                HStack(spacing: 12) {
                    Image(systemName: windowManager.persistenceError == nil ? "info.circle" : "exclamationmark.triangle")
                    Text(message).font(Typography.caption).lineLimit(2)
                    Spacer()
                    Button(windowManager.persistenceError == nil ? "OK" : "Retry") {
                        if windowManager.persistenceError == nil {
                            windowManager.resourceMessage = nil
                        } else {
                            windowManager.flush()
                        }
                    }
                    .buttonStyle(QuietButtonStyle())
                }
                .foregroundStyle(windowManager.persistenceError == nil ? Theme.secondaryInk : Theme.danger)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .padding(.horizontal, 24)
            }

            Spacer()

            if let window = windowManager.selectedWindow {
                SelectedWindowBar(window: window, coordinator: coordinator)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 82)
            }

            Dock(coordinator: coordinator)
                .padding(.bottom, 18)
        }

        if coordinator.showLauncher, coordinator.mode == .handheld {
            HStack {
                LauncherView(coordinator: coordinator)
                    .padding(.leading, 24)
                    .padding(.top, 88)
                Spacer()
            }
        }

        if coordinator.settings.showPerformance {
            VStack {
                Spacer()
                HStack {
                    Spacer()
                    Text(String(format: "%.0f FPS • %.2fx • %d windows • %d draws", coordinator.renderSnapshot.fps, coordinator.renderSnapshot.pixelRatio, coordinator.renderSnapshot.windowCount, coordinator.renderSnapshot.drawCalls))
                        .font(Typography.mono)
                        .foregroundStyle(Theme.cyan)
                        .padding(10)
                        .background(.black.opacity(0.45), in: Capsule())
                        .padding(.trailing, 24)
                        .padding(.bottom, 92)
                }
            }
            .allowsHitTesting(false)
        }
    }

    private var motionSummary: String {
        switch coordinator.motion.status {
        case .running: "Motion tracking"
        case .interrupted: "Motion interrupted"
        case .unavailable: "Touch look"
        default: "Touch look"
        }
    }

    private var motionColor: Color {
        coordinator.motion.status == .running ? Theme.cyan : Color.white.opacity(0.4)
    }
}

private struct SelectedWindowBar: View {
    let window: SpatialWindow
    @ObservedObject var coordinator: AppCoordinator

    var body: some View {
        HStack(spacing: 10) {
            ModuleBadge(module: window.module, size: 36)
            Text(window.module.title).font(Typography.headline).foregroundStyle(Theme.ink)
            Button("Open") { coordinator.openWindow(window) }
                .buttonStyle(PrimaryButtonStyle())
                .accessibilityIdentifier("open-selected-window")
            Button(window.lifecycle == .minimized ? "Restore" : "Minimize") {
                if window.lifecycle == .minimized {
                    coordinator.windowManager.restore(window.id)
                } else {
                    coordinator.windowManager.minimize(window.id)
                }
            }
            .buttonStyle(QuietButtonStyle())
            Button("Maximize") { coordinator.windowManager.maximize(window.id) }
                .buttonStyle(QuietButtonStyle())
            Button(window.isPinned ? "Unpin" : "Pin") { coordinator.windowManager.togglePinned(window.id) }
                .buttonStyle(QuietButtonStyle())
            Menu {
                ForEach(WindowPositioning.allCases) { mode in
                    Button(mode.title) { coordinator.windowManager.setPositioning(mode, for: window.id) }
                }
            } label: {
                Label(window.positioning.title, systemImage: "anchor").font(Typography.caption)
            }
            .buttonStyle(QuietButtonStyle())
            HStack(spacing: 4) {
                Button { coordinator.windowManager.adjustDepth(of: window.id, by: 0.25) } label: { Image(systemName: "minus.circle") }
                Button { coordinator.windowManager.adjustDepth(of: window.id, by: -0.25) } label: { Image(systemName: "plus.circle") }
            }
            .buttonStyle(QuietButtonStyle())
            Button(role: .destructive) {
                coordinator.windowManager.close(window.id)
            } label: {
                Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.danger)
            }
            .buttonStyle(.plain)
        }
        .padding(12)
        .glassPanel(cornerRadius: 22)
    }
}

private struct Dock: View {
    @ObservedObject var coordinator: AppCoordinator

    var body: some View {
        HStack(spacing: 10) {
            DockButton(title: "Apps", symbol: "square.grid.2x2", active: coordinator.showLauncher) {
                coordinator.showLauncher.toggle()
                coordinator.mode = .handheld
            }
            DockButton(title: "Windows", symbol: "macwindow.on.rectangle") { coordinator.launch(.windows) }
            DockButton(title: "Space", symbol: "globe") { coordinator.launch(.environments) }
            DockButton(title: "Scan", symbol: "arkit") { coordinator.launch(.scanner) }
            DockButton(title: "VR", symbol: "viewfinder") {
                coordinator.showCalibration = true
                if coordinator.settings.motionEnabled { coordinator.motion.start() }
            }
        }
        .padding(10)
        .glassPanel(cornerRadius: 26)
    }
}

private struct DockButton: View {
    let title: String
    let symbol: String
    var active = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: symbol).font(.system(size: 20, weight: .semibold))
                Text(title).font(Typography.caption)
            }
            .foregroundStyle(active ? Theme.cyan : Theme.ink)
            .frame(width: 74, height: 54)
            .background(active ? Theme.cyan.opacity(0.13) : Color.clear, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("dock-\(title.lowercased())")
    }
}
