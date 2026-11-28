import Foundation
import simd

@MainActor
final class WindowManager: ObservableObject {
    @Published private(set) var windows: [SpatialWindow] = []
    @Published private(set) var selectedWindowID: UUID?
    @Published var resourceMessage: String?
    @Published private(set) var persistenceError: String?

    private let store: WorkspaceStore
    private var saveTask: Task<Void, Never>?
    private var nextZIndex = 0

    init(store: WorkspaceStore = .shared) {
        self.store = store
        do {
            let snapshot = try store.load()
            windows = snapshot.windows
            selectedWindowID = snapshot.selectedWindowID
            nextZIndex = (windows.map(\.zIndex).max() ?? -1) + 1
            if windows.isEmpty {
                createDefaultWorkspace()
            }
        } catch {
            persistenceError = error.localizedDescription
            createDefaultWorkspace()
        }
    }

    var selectedWindow: SpatialWindow? {
        windows.first { $0.id == selectedWindowID }
    }

    var visibleWindows: [SpatialWindow] {
        windows.sorted {
            if $0.isPinned != $1.isPinned { return $0.isPinned }
            return $0.zIndex < $1.zIndex
        }
    }

    var resourceBudget: Int {
        let memoryGB = Double(ProcessInfo.processInfo.physicalMemory) / 1_000_000_000
        let memoryTier = memoryGB >= 6 ? 28 : (memoryGB >= 4 ? 20 : 12)
        let thermalPenalty = Int(ProcessInfo.processInfo.thermalState.rawValue)
        return max(6, memoryTier - thermalPenalty)
    }

    func open(_ module: AppModule) {
        if let index = windows.firstIndex(where: { $0.module == module && $0.lifecycle != .minimized }) {
            focus(windows[index].id)
            resourceMessage = nil
            return
        }

        if let index = windows.firstIndex(where: { $0.module == module && $0.lifecycle == .minimized }) {
            restore(windows[index].id)
            resourceMessage = nil
            return
        }

        guard windows.count < resourceBudget else {
            resourceMessage = "Window resources are full (\(resourceBudget)). Close a window before opening another."
            return
        }

        var window = SpatialWindow(module: module, placement: defaultPlacement(index: windows.count), zIndex: nextZIndex)
        nextZIndex += 1
        windows.append(window)
        selectedWindowID = window.id
        resourceMessage = nil
        scheduleSave()
    }

    func focus(_ id: UUID) {
        guard let index = windows.firstIndex(where: { $0.id == id }) else { return }
        if windows[index].lifecycle == .minimized {
            windows[index].restore()
        }
        windows[index].lastActiveAt = Date().timeIntervalSinceReferenceDate
        windows[index].zIndex = nextZIndex
        nextZIndex += 1
        selectedWindowID = id
        scheduleSave()
    }

    func close(_ id: UUID) {
        windows.removeAll { $0.id == id }
        if selectedWindowID == id {
            selectedWindowID = windows.max { $0.lastActiveAt < $1.lastActiveAt }?.id
        }
        scheduleSave()
    }

    func minimize(_ id: UUID) {
        guard let index = windows.firstIndex(where: { $0.id == id }) else { return }
        windows[index].minimize()
        scheduleSave()
    }

    func maximize(_ id: UUID) {
        guard let index = windows.firstIndex(where: { $0.id == id }) else { return }
        windows[index].maximize()
        focus(id)
    }

    func restore(_ id: UUID) {
        guard let index = windows.firstIndex(where: { $0.id == id }) else { return }
        windows[index].restore()
        focus(id)
    }

    func togglePinned(_ id: UUID) {
        guard let index = windows.firstIndex(where: { $0.id == id }) else { return }
        windows[index].togglePinned()
        scheduleSave()
    }

    func setPositioning(_ positioning: WindowPositioning, for id: UUID) {
        guard let index = windows.firstIndex(where: { $0.id == id }) else { return }
        windows[index].positioning = positioning
        scheduleSave()
    }

    func move(_ id: UUID, to placement: WindowPlacement) {
        guard let index = windows.firstIndex(where: { $0.id == id }) else { return }
        windows[index].placement = placement.clamped()
        windows[index].lastActiveAt = Date().timeIntervalSinceReferenceDate
        scheduleSave()
    }

    func moveSelected(to normalizedPoint: SIMD2<Float>) {
        guard var window = selectedWindow else { return }
        window.placement.x = SpatialMath.clamp((normalizedPoint.x - 0.5) * 7, -7...7)
        window.placement.y = SpatialMath.clamp((normalizedPoint.y - 0.5) * 4, -4...4)
        move(window.id, to: window.placement)
    }

    func resizeSelected(scale: Float) {
        guard let window = selectedWindow else { return }
        resize(window.id, scale: scale)
    }

    func resize(_ id: UUID, scale: Float) {
        guard var window = windows.first(where: { $0.id == id }) else { return }
        window.placement.width = SpatialMath.clamp(window.placement.width * scale, 0.65...5.2)
        window.placement.height = SpatialMath.clamp(window.placement.height * scale, 0.3...3.2)
        move(window.id, to: window.placement)
    }

    func rotateSelected(by radians: Float) {
        guard let window = selectedWindow else { return }
        rotate(window.id, by: radians)
    }

    func rotate(_ id: UUID, by radians: Float) {
        guard var window = windows.first(where: { $0.id == id }) else { return }
        window.placement.roll += radians
        move(window.id, to: window.placement)
    }

    func adjustDepth(of id: UUID, by delta: Float) {
        guard let index = windows.firstIndex(where: { $0.id == id }) else { return }
        windows[index].placement.z += delta
        move(id, to: windows[index].placement)
    }

    func selectAt(_ normalizedPoint: SIMD2<Float>) {
        let target = SIMD3<Float>((normalizedPoint.x - 0.5) * 7, (normalizedPoint.y - 0.5) * 4, -3.4)
        guard let nearest = windows.min(by: { lhs, rhs in
            let left = SIMD3<Float>(lhs.placement.x, lhs.placement.y, lhs.placement.z)
            let right = SIMD3<Float>(rhs.placement.x, rhs.placement.y, rhs.placement.z)
            return distance_squared(left, target) < distance_squared(right, target)
        }) else { return }
        focus(nearest.id)
    }

    func cycleSelection(reverse: Bool = false) {
        let ordered = visibleWindows
        guard !ordered.isEmpty else { return }
        guard let current = selectedWindowID, let index = ordered.firstIndex(where: { $0.id == current }) else {
            focus(ordered[0].id)
            return
        }
        let next = (index + (reverse ? -1 : 1) + ordered.count) % ordered.count
        focus(ordered[next].id)
    }

    func flush() {
        saveTask?.cancel()
        saveTask = nil
        do {
            try store.save(WorkspaceSnapshot(version: 1, windows: windows, selectedWindowID: selectedWindowID))
            persistenceError = nil
        } catch {
            persistenceError = error.localizedDescription
        }
    }

    private func createDefaultWorkspace() {
        let settings = SpatialWindow(
            module: .settings,
            placement: WindowPlacement(x: -1.45, y: 0.05, z: -3.8, width: 2.45, height: 1.4, yaw: 0.08, pitch: 0, roll: 0),
            positioning: .worldLocked,
            zIndex: nextZIndex
        )
        nextZIndex += 1
        let environments = SpatialWindow(
            module: .environments,
            placement: WindowPlacement(x: 1.45, y: -0.1, z: -4.1, width: 2.45, height: 1.4, yaw: -0.08, pitch: 0, roll: 0),
            positioning: .individual,
            zIndex: nextZIndex
        )
        nextZIndex += 1
        windows = [settings, environments]
        selectedWindowID = settings.id
        scheduleSave()
    }

    private func defaultPlacement(index: Int) -> WindowPlacement {
        let column = index % 2
        let row = (index / 2) % 3
        return WindowPlacement(
            x: Float(column) * 2.8 - 1.4,
            y: 0.55 - Float(row) * 1.55,
            z: -3.7 - Float(row) * 0.35,
            width: 2.5,
            height: 1.42,
            yaw: column == 0 ? 0.06 : -0.06,
            pitch: 0,
            roll: 0
        ).clamped()
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            self?.flush()
        }
    }
}
