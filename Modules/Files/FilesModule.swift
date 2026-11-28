import SwiftUI
import UniformTypeIdentifiers

struct FilesModuleView: View {
    @ObservedObject var coordinator: AppCoordinator
    @State private var files: [URL] = []
    @State private var showingImporter = false
    @State private var pendingDelete: URL?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("App-private storage. Imported files never leave this device unless you share them.")
                    .font(Typography.caption).foregroundStyle(Theme.secondaryInk)
                Spacer()
                Button("Import File") { showingImporter = true }.buttonStyle(PrimaryButtonStyle())
            }
            .padding(.horizontal, 22)

            if let error {
                Text(error).font(Typography.caption).foregroundStyle(Theme.danger).padding(.horizontal, 22)
            }

            if files.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "folder").font(.system(size: 52)).foregroundStyle(Theme.violet)
                    Text("No imported files yet.").foregroundStyle(Theme.secondaryInk)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(files, id: \.self) { file in
                        HStack(spacing: 14) {
                            Image(systemName: symbol(for: file)).font(.title2).foregroundStyle(Theme.cyan).frame(width: 32)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(file.lastPathComponent).font(Typography.headline).foregroundStyle(Theme.ink).lineLimit(1)
                                Text(subtitle(for: file)).font(Typography.caption).foregroundStyle(Theme.secondaryInk)
                            }
                            Spacer()
                            ShareLink(item: file) { Label("Share", systemImage: "square.and.arrow.up") }
                                .buttonStyle(QuietButtonStyle())
                            Button(role: .destructive) { pendingDelete = file } label: {
                                Image(systemName: "trash").foregroundStyle(Theme.danger)
                            }.buttonStyle(.plain)
                        }
                        .padding(.vertical, 6)
                    }
                }
                .listStyle(.plain)
            }
        }
        .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.data, .image, .video, .audio, .pdf, .text, .archive]) { result in
            switch result {
            case .success(let url):
                do {
                    _ = try DocumentStore.shared.importItem(url)
                    reload()
                    coordinator.showMessage("File imported.")
                } catch { self.error = error.localizedDescription }
            case .failure(let failure): self.error = failure.localizedDescription
            }
        }
        .onAppear(perform: reload)
        .confirmationDialog("Delete this file?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let file = pendingDelete {
                    do { try DocumentStore.shared.remove(file); reload() } catch { self.error = error.localizedDescription }
                }
                pendingDelete = nil
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        }
    }

    private func reload() {
        do { files = try DocumentStore.shared.documents() } catch { self.error = error.localizedDescription }
    }

    private func symbol(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "jpg", "jpeg", "png", "heic": "photo"
        case "mp4", "mov", "m4v": "play.rectangle"
        case "mp3", "m4a", "wav", "aac": "music.note"
        case "pdf": "doc.text"
        default: "doc"
        }
    }

    private func subtitle(for url: URL) -> String {
        let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        let size = ByteCountFormatter.string(fromByteCount: Int64(values?.fileSize ?? 0), countStyle: .file)
        let date = values?.contentModificationDate?.formatted(date: .abbreviated, time: .omitted) ?? ""
        return "\(size) • \(date)"
    }
}
