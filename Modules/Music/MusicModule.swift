import SwiftUI
import AVFoundation
import UniformTypeIdentifiers

final class AudioPlaybackModel: NSObject, ObservableObject {
    @Published private(set) var player: AVAudioPlayer?
    @Published private(set) var duration: Double = 0
    @Published var currentTime: Double = 0
    @Published private(set) var isPlaying = false
    @Published private(set) var isRepeating = false
    @Published private(set) var title: String?
    @Published var error: String?
    private var observer: Any?

    func load(_ url: URL) {
        pause()
        do {
            let player = try AVAudioPlayer(contentsOf: url)
            player.delegate = self
            self.player = player
            duration = player.duration
            currentTime = 0
            title = url.lastPathComponent
            error = nil
            player.prepareToPlay()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func togglePlayback() {
        guard let player else { return }
        if player.isPlaying { player.pause() } else { player.play() }
        isPlaying = player.isPlaying
    }

    func pause() {
        player?.pause()
        isPlaying = false
    }

    func toggleRepeat() {
        guard let player else { return }
        isRepeating.toggle()
        player.numberOfLoops = isRepeating ? -1 : 0
    }

    func seek(_ value: Double) {
        player?.currentTime = value
        currentTime = value
    }

    func startObserving() {
        guard observer == nil, let player else { return }
        observer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.currentTime = player.currentTime
                self.isPlaying = player.isPlaying
            }
        }
    }

    deinit {
        observer = nil
        player?.delegate = nil
    }
}

extension AudioPlaybackModel: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in self.error = error?.localizedDescription ?? "Audio decoding failed." }
    }
}

struct MusicModuleView: View {
    @StateObject private var model = AudioPlaybackModel()
    @State private var showingImporter = false
    @State private var importing = false
    @State private var importTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 24) {
            Text("LOCAL AUDIO").font(Typography.caption).foregroundStyle(Theme.cyan)

            Image(systemName: model.isPlaying ? "waveform" : "music.note")
                .font(.system(size: 76, weight: .light))
                .foregroundStyle(Theme.violet)
                .symbolEffect(.variableColor.iterative, isActive: model.isPlaying)

            Text(model.title ?? "Choose an audio file")
                .font(Typography.title).foregroundStyle(Theme.ink)
                .multilineTextAlignment(.center)

            if model.player != nil {
                VStack(spacing: 8) {
                    Slider(value: $model.currentTime, in: 0...max(model.duration, 0.01)) { editing in
                        if !editing { model.seek(model.currentTime) }
                    }
                    .tint(Theme.cyan)
                    HStack {
                        Text(time(model.currentTime)).font(Typography.mono)
                        Spacer()
                        Text(time(model.duration)).font(Typography.mono)
                    }
                    .foregroundStyle(Theme.secondaryInk)
                }
                .padding(.horizontal, 40)
            }

            HStack(spacing: 16) {
                Button(action: model.togglePlayback) {
                    Image(systemName: model.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 30))
                        .frame(width: 68, height: 68)
                        .foregroundStyle(Color(hex: 0x04121C))
                        .background(Theme.cyan, in: Circle())
                }
                .buttonStyle(.plain).disabled(model.player == nil)

                Button(action: model.toggleRepeat) {
                    Image(systemName: "repeat").font(.title2)
                        .frame(width: 46, height: 46)
                        .foregroundStyle(model.isRepeating ? Theme.cyan : Theme.secondaryInk)
                        .background(.ultraThinMaterial, in: Circle())
                }
                .buttonStyle(.plain).disabled(model.player == nil)
                Button("Choose Audio") { showingImporter = true }.buttonStyle(QuietButtonStyle())
            }

            if importing { ProgressView() }
            if let error = model.error {
                Text(error).font(Typography.caption).foregroundStyle(Theme.danger)
            }
            Spacer()
        }
        .padding(28)
        .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.audio]) { result in
            switch result {
            case .success(let url):
                importing = true
                importTask = Task {
                    do {
                        let stored = try DocumentStore.shared.importItem(url)
                        guard !Task.isCancelled else { return }
                        await MainActor.run { model.load(stored); importing = false }
                    } catch {
                        guard !Task.isCancelled else { return }
                        await MainActor.run { model.error = error.localizedDescription; importing = false }
                    }
                }
            case .failure(let error): model.error = error.localizedDescription
            }
        }
        .onAppear { model.startObserving() }
        .onDisappear {
            importTask?.cancel()
            importTask = nil
            importing = false
            model.pause()
        }
    }

    private func time(_ value: Double) -> String {
        let minutes = Int(value) / 60
        let seconds = Int(value) % 60
        return String(format: "%d:%02d", minutes, seconds)
    }
}
