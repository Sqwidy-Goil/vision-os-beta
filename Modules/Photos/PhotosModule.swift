import SwiftUI
import PhotosUI
import UIKit

struct PhotosModuleView: View {
    @ObservedObject var coordinator: AppCoordinator
    @State private var images: [UIImage] = []
    @State private var selection: [PhotosPickerItem] = []
    @State private var showingPicker = false
    @State private var error: String?

    private let columns = [GridItem(.adaptive(minimum: 160), spacing: 14)]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Photos stay on this device. The system picker does not request full library access.")
                    .font(Typography.caption).foregroundStyle(Theme.secondaryInk)
                Spacer()
                Button("Select Photos") { showingPicker = true }.buttonStyle(PrimaryButtonStyle())
                Button("Use as 360° Background") { usePanorama() }
                    .buttonStyle(QuietButtonStyle()).disabled(images.isEmpty)
            }
            .padding(.horizontal, 22)

            if let error {
                Text(error).font(Typography.caption).foregroundStyle(Theme.danger).padding(.horizontal, 22)
            }

            if images.isEmpty {
                VStack(spacing: 14) {
                    Image(systemName: "photo.on.rectangle.angled").font(.system(size: 52)).foregroundStyle(Theme.violet)
                    Text("Choose images to preview or use as a panoramic environment.")
                        .font(Typography.body).foregroundStyle(Theme.secondaryInk)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 14) {
                        ForEach(images.indices, id: \.self) { index in
                            Image(uiImage: images[index])
                                .resizable().scaledToFill()
                                .frame(height: 190).clipped()
                                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                                .overlay(alignment: .topTrailing) {
                                    Button {
                                        images.remove(at: index)
                                    } label: {
                                        Image(systemName: "xmark.circle.fill").font(.title2).foregroundStyle(.white)
                                    }
                                    .buttonStyle(.plain).padding(8)
                                }
                        }
                    }
                    .padding(22)
                }
            }
        }
        .sheet(isPresented: $showingPicker) {
            PhotosPicker(selection: $selection, maxSelectionCount: 10, matching: .images) {
                Label("Select", systemImage: "photo")
            }
            .onChange(of: selection.count) { _, count in
                if count > 0 { loadSelection() }
            }
        }
    }

    private func loadSelection() {
        for item in selection {
            item.loadTransferable(type: Data.self) { result in
                switch result {
                case .success(let data):
                    guard let data else {
                        DispatchQueue.main.async { self.error = "The selected image could not be loaded." }
                        return
                    }
                    if let image = UIImage(data: data) {
                        DispatchQueue.main.async { self.images.append(image) }
                    }
                case .failure(let failure):
                    DispatchQueue.main.async { self.error = failure.localizedDescription }
                }
            }
        }
        selection = []
    }

    private func usePanorama() {
        guard let image = images.first, let data = image.jpegData(compressionQuality: 0.86) else {
            error = "The selected image could not be encoded."
            return
        }
        do {
            let url = try DocumentStore.shared.write(data, to: "Panorama-\(UUID().uuidString).jpg")
            coordinator.settings.panoramaFileName = url.lastPathComponent
            coordinator.settings.environmentKind = .panorama
            coordinator.showMessage("Panoramic environment applied.")
        } catch {
            self.error = error.localizedDescription
        }
    }
}
