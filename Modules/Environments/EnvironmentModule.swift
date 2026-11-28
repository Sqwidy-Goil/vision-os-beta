import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct EnvironmentModuleView: View {
    @ObservedObject var coordinator: AppCoordinator
    @State private var showingImporter = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                HStack {
                    Text("Environments are shared by handheld, spatial, and both VR eyes.")
                        .font(Typography.caption).foregroundStyle(Theme.secondaryInk)
                    Spacer()
                    if coordinator.settings.panoramaURL != nil {
                        Button("Remove Panorama", role: .destructive, action: removePanorama).buttonStyle(QuietButtonStyle())
                    }
                }
                .padding(.horizontal, 22)

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 16)]) {
                    ForEach(EnvironmentKind.allCases) { kind in
                        Button {
                            select(kind)
                        } label: {
                            VStack(alignment: .leading, spacing: 12) {
                                ZStack {
                                    if kind == .panorama, let url = coordinator.settings.panoramaURL, let image = UIImage(contentsOfFile: url.path) {
                                        Image(uiImage: image).resizable().scaledToFill().frame(height: 118).clipped()
                                    } else {
                                        LinearGradient(colors: [kind.topColor, kind.bottomColor], startPoint: .top, endPoint: .bottom)
                                            .frame(height: 118)
                                            .overlay(Image(systemName: kind.symbol).font(.system(size: 38)).foregroundStyle(.white.opacity(0.75)))
                                    }
                                }
                                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                                HStack {
                                    Text(kind.title).font(Typography.headline).foregroundStyle(Theme.ink)
                                    Spacer()
                                    if coordinator.settings.environmentKind == kind {
                                        Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.cyan)
                                    }
                                }
                                Text(kind.subtitle).font(Typography.caption).foregroundStyle(Theme.secondaryInk)
                            }
                            .padding(14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(coordinator.settings.environmentKind == kind ? Theme.cyan : Theme.hairline, lineWidth: coordinator.settings.environmentKind == kind ? 2 : 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(22)

                ModuleSection(title: "Panoramic environment") {
                    Text("Import a wide equirectangular image. Ordinary photos can be wrapped, but a 2:1 panorama provides the best result.")
                        .font(Typography.caption).foregroundStyle(Theme.secondaryInk)
                    Button("Choose Panorama Image") { showingImporter = true }.buttonStyle(PrimaryButtonStyle())
                    if let error {
                        Text(error).font(Typography.caption).foregroundStyle(Theme.danger)
                    }
                }
                .padding(.horizontal, 22)
            }
            .padding(.bottom, 24)
        }
        .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.image]) { result in
            switch result {
            case .success(let url):
                do {
                    let stored = try DocumentStore.shared.importItem(url)
                    coordinator.settings.panoramaFileName = stored.lastPathComponent
                    coordinator.settings.environmentKind = .panorama
                    coordinator.showMessage("Panorama imported and applied.")
                } catch { self.error = error.localizedDescription }
            case .failure(let failure): error = failure.localizedDescription
            }
        }
    }

    private func select(_ kind: EnvironmentKind) {
        if kind == .panorama, coordinator.settings.panoramaURL == nil {
            coordinator.showMessage("Import a panoramic image first.")
            return
        }
        coordinator.settings.environmentKind = kind
    }

    private func removePanorama() {
        guard let url = coordinator.settings.panoramaURL else { return }
        do {
            try DocumentStore.shared.remove(url)
            coordinator.settings.panoramaFileName = nil
            if coordinator.settings.environmentKind == .panorama { coordinator.settings.environmentKind = .studio }
        } catch { self.error = error.localizedDescription }
    }
}
