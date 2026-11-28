import SwiftUI
import AVKit
import UniformTypeIdentifiers

struct VideoModuleView: View {
    @State private var player: AVPlayer?
    @State private var title = "No video selected"
    @State private var showingImporter = false
    @State private var isImporting = false
    @State private var importTask: Task<Void, Never>?
    @State private var error: String?

    var body: some View {
        VStack(spacing: 16) {
            HStack {
                Text(title).font(Typography.headline).foregroundStyle(Theme.ink)
                Spacer()
                Button("Choose Video") { showingImporter = true }.buttonStyle(PrimaryButtonStyle())
            }
            .padding(.horizontal, 22)

            if isImporting { ProgressView("Importing into app storage…") }

            if let player {
                VideoPlayer(player: player)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(.horizontal, 14)
            } else {
                VStack(spacing: 14) {
                    Image(systemName: "play.rectangle").font(.system(size: 56)).foregroundStyle(Theme.cyan)
                    Text("Import a local MP4, MOV, or M4V file.")
                        .foregroundStyle(Theme.secondaryInk)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            if let error {
                Text(error).font(Typography.caption).foregroundStyle(Theme.danger).padding(.horizontal, 22)
            }
        }
        .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.mpeg4Movie, .quickTimeMovie]) { result in
            switch result {
            case .success(let url):
                isImporting = true
                importTask = Task {
                    do {
                        let stored = try DocumentStore.shared.importItem(url)
                        guard !Task.isCancelled else { return }
                        await MainActor.run {
                            player?.pause()
                            player = AVPlayer(url: stored)
                            title = stored.lastPathComponent
                            isImporting = false
                        }
                    } catch {
                        guard !Task.isCancelled else { return }
                        await MainActor.run {
                            self.error = error.localizedDescription
                            isImporting = false
                        }
                    }
                }
            case .failure(let failure):
                error = failure.localizedDescription
            }
        }
        .onDisappear {
            importTask?.cancel()
            importTask = nil
            isImporting = false
            player?.pause()
        }
    }
}
