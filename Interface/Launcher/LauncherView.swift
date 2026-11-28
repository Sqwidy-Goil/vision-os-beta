import SwiftUI

struct LauncherView: View {
    @ObservedObject var coordinator: AppCoordinator

    private let columns = [GridItem(.adaptive(minimum: 116), spacing: 14)]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("SPATIAL WORKSPACE").font(Typography.caption).foregroundStyle(Theme.cyan)
                    Text("Launch something").font(Typography.title).foregroundStyle(Theme.ink)
                }
                Spacer()
                Button {
                    coordinator.showLauncher = false
                } label: {
                    Image(systemName: "xmark").font(.headline).foregroundStyle(Theme.secondaryInk)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close launcher")
            }

            ScrollView {
                LazyVGrid(columns: columns, spacing: 14) {
                    ForEach(AppModule.allCases) { module in
                        Button {
                            coordinator.launch(module)
                        } label: {
                            VStack(spacing: 9) {
                                ModuleBadge(module: module, size: 48)
                                Text(module.title).font(Typography.headline).foregroundStyle(Theme.ink)
                                Text(module.subtitle)
                                    .font(Typography.caption)
                                    .foregroundStyle(Theme.secondaryInk)
                                    .multilineTextAlignment(.center)
                                    .lineLimit(2)
                            }
                            .frame(maxWidth: .infinity, minHeight: 126)
                            .padding(12)
                            .background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color.white.opacity(0.09)))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("module-\(module.rawValue)")
                    }
                }
                .padding(2)
            }

            Text("Apps open as shared 3D windows. Select “Open” on the focused window to use full app content outside VR.")
                .font(Typography.caption)
                .foregroundStyle(Theme.secondaryInk)
        }
        .padding(22)
        .frame(width: 470)
        .glassPanel()
        .shadow(color: .black.opacity(0.25), radius: 20)
    }
}
