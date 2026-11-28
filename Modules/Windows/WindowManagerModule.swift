import SwiftUI

struct WindowManagerModuleView: View {
    @ObservedObject var coordinator: AppCoordinator

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Shared window manager").font(Typography.headline).foregroundStyle(Theme.ink)
                    Text("\(coordinator.windowManager.windows.count) open • \(coordinator.windowManager.resourceBudget) resource slots")
                        .font(Typography.caption).foregroundStyle(Theme.secondaryInk)
                }
                Spacer()
                if let message = coordinator.windowManager.resourceMessage {
                    Text(message).font(Typography.caption).foregroundStyle(.orange).frame(maxWidth: 360)
                }
            }
            .padding(.horizontal, 22)

            List {
                ForEach(coordinator.windowManager.visibleWindows) { window in
                    HStack(spacing: 12) {
                        Button {
                            coordinator.windowManager.focus(window.id)
                        } label: {
                            ModuleBadge(module: window.module, size: 42)
                        }
                        .buttonStyle(.plain)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(window.module.title).font(Typography.headline).foregroundStyle(Theme.ink)
                            Text("\(window.lifecycle.rawValue.capitalized) • \(window.positioning.title)")
                                .font(Typography.caption).foregroundStyle(Theme.secondaryInk)
                        }
                        Spacer()
                        Button(window.lifecycle == .minimized ? "Restore" : "Minimize") {
                            if window.lifecycle == .minimized { coordinator.windowManager.restore(window.id) } else { coordinator.windowManager.minimize(window.id) }
                        }.buttonStyle(QuietButtonStyle())
                        Button("Open") { coordinator.openWindow(window) }.buttonStyle(PrimaryButtonStyle())
                        Menu {
                            Button(window.isPinned ? "Unpin" : "Pin") { coordinator.windowManager.togglePinned(window.id) }
                            ForEach(WindowPositioning.allCases) { mode in
                                Button(mode.title) { coordinator.windowManager.setPositioning(mode, for: window.id) }
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }.buttonStyle(QuietButtonStyle())
                        Button(role: .destructive) { coordinator.windowManager.close(window.id) } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.danger)
                        }.buttonStyle(.plain)
                    }
                    .padding(.vertical, 6)
                }
            }
            .listStyle(.plain)
        }
    }
}
