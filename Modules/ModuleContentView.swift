import SwiftUI

struct ModuleContentView: View {
    let module: AppModule
    @ObservedObject var coordinator: AppCoordinator

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                ModuleBadge(module: module, size: 46)
                VStack(alignment: .leading, spacing: 2) {
                    Text(module.title).font(Typography.title).foregroundStyle(Theme.ink)
                    Text(module.subtitle).font(Typography.caption).foregroundStyle(Theme.secondaryInk)
                }
                Spacer()
                Button("Done") { coordinator.activeModule = nil }
                    .buttonStyle(PrimaryButtonStyle())
            }
            .padding(22)
            .background(.ultraThinMaterial)

            Divider().overlay(Theme.hairline)

            Group {
                switch module {
                case .browser: BrowserModuleView()
                case .photos: PhotosModuleView(coordinator: coordinator)
                case .video: VideoModuleView()
                case .camera: CameraModuleView(coordinator: coordinator)
                case .music: MusicModuleView()
                case .scanner: ScannerModuleView(coordinator: coordinator)
                case .files: FilesModuleView(coordinator: coordinator)
                case .settings: SettingsModuleView(coordinator: coordinator)
                case .environments: EnvironmentModuleView(coordinator: coordinator)
                case .windows: WindowManagerModuleView(coordinator: coordinator)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Theme.backgroundBottom)
    }
}

struct ModuleSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title.uppercased()).font(Typography.caption).foregroundStyle(Theme.cyan)
            content
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.hairline))
    }
}

struct SettingsSlider: View {
    let title: String
    let value: Binding<Double>
    let range: ClosedRange<Double>
    let step: Double
    let output: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(Typography.body).foregroundStyle(Theme.ink)
                Spacer()
                Text(output).font(Typography.mono).foregroundStyle(Theme.cyan)
            }
            Slider(value: value, in: range, step: step)
                .tint(Theme.cyan)
        }
    }
}
