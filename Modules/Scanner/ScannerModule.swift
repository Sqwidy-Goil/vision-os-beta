import SwiftUI
import ARKit
import SceneKit
import UniformTypeIdentifiers

struct ScannerModuleView: View {
    @ObservedObject var coordinator: AppCoordinator
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var scanner = ScannerService()
    @State private var scanName = "Room"
    @State private var showingImporter = false
    @State private var files: [URL] = []

    var body: some View {
        ZStack(alignment: .bottom) {
            ScannerSceneView(session: scanner.session)

            if !scanner.isSessionActive {
                VStack(spacing: 12) {
                    Image(systemName: "arkit").font(.system(size: 56)).foregroundStyle(Theme.cyan)
                    Text("Feature-point spatial scan").font(Typography.title).foregroundStyle(Theme.ink)
                    Text("Uses ARKit planes and raw feature points. iPhone 16e does not provide a LiDAR depth mesh.")
                        .font(Typography.caption).foregroundStyle(Theme.secondaryInk)
                        .multilineTextAlignment(.center)
                }
                .padding(24)
                .frame(maxWidth: 440)
                .glassPanel()
            }

            VStack(spacing: 10) {
                HStack(spacing: 12) {
                    StatusPill(text: "\(scanner.featurePointCount) feature points", color: Theme.cyan)
                    StatusPill(text: "\(scanner.planeCount) plane estimates", color: Theme.violet)
                    StatusPill(text: scanner.trackingState, color: scanner.trackingState == "Normal" ? Theme.cyan : .orange)
                    Spacer()
                    TextField("Scan name", text: $scanName)
                        .textFieldStyle(.plain).frame(width: 150).foregroundStyle(Theme.ink)
                }
                .padding(12)
                .glassPanel(cornerRadius: 18)

                HStack(spacing: 12) {
                    if !scanner.isSessionActive {
                        Button("Start Scan") { Task { await scanner.start() } }.buttonStyle(PrimaryButtonStyle())
                    } else {
                        Button("Save World Map + Points") { Task { await scanner.saveScan(name: scanName); files = scanner.scanFiles() } }
                            .buttonStyle(PrimaryButtonStyle())
                        Button("Stop") { scanner.stop() }.buttonStyle(QuietButtonStyle())
                    }
                    Button("Load World Map") { showingImporter = true; files = scanner.scanFiles() }.buttonStyle(QuietButtonStyle())
                    if let error = scanner.error {
                        Text(error).font(Typography.caption).foregroundStyle(Theme.danger).frame(maxWidth: 260)
                    }
                }
                .padding(.horizontal, 12)

                HStack(spacing: 12) {
                    if !files.isEmpty {
                        Menu("Saved Scans (\(files.count))") {
                            ForEach(files, id: \.self) { file in
                                Button(file.lastPathComponent) {
                                    Task { await scanner.loadScan(file) }
                                }
                            }
                        }
                        .buttonStyle(QuietButtonStyle())
                    }
                    if let metadata = scanner.loadedMetadata {
                        Text("\(metadata.featurePointCount) saved points • \(metadata.createdAt.formatted(date: .abbreviated, time: .shortened))")
                            .font(Typography.caption).foregroundStyle(Theme.secondaryInk)
                    }
                    Spacer()
                }
                .padding(.horizontal, 12)
            }
            .padding(16)
            .background(LinearGradient(colors: [.clear, Theme.backgroundBottom.opacity(0.85)], startPoint: .top, endPoint: .bottom))
        }
        .fileImporter(isPresented: $showingImporter, allowedContentTypes: [UTType(filenameExtension: "visionmap") ?? .data]) { result in
            if case .success(let url) = result {
                Task {
                    await scanner.loadScan(url)
                    files = scanner.scanFiles()
                }
            }
        }
        .onAppear {
            coordinator.stopCameraSession()
            files = scanner.scanFiles()
        }
        .onDisappear {
            scanner.stop()
            if scenePhase == .active {
                Task { await coordinator.restartCameraIfNeeded() }
            }
        }
    }
}

private struct ScannerSceneView: UIViewRepresentable {
    let session: ARSession

    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView(frame: .zero)
        view.session = session
        view.delegate = context.coordinator
        view.autoenablesDefaultLighting = true
        view.scene.background.contents = UIColor.black
        return view
    }

    func updateUIView(_ uiView: ARSCNView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, ARSCNViewDelegate {
        func renderer(_ renderer: SCNSceneRenderer, didAdd node: SCNNode, for anchor: ARAnchor) {
            addPlane(to: node, anchor: anchor)
        }

        func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
            guard anchor is ARPlaneAnchor else { return }
            node.childNodes.forEach { $0.removeFromParentNode() }
            addPlane(to: node, anchor: anchor)
        }

        private func addPlane(to node: SCNNode, anchor: ARAnchor) {
            guard let plane = anchor as? ARPlaneAnchor else { return }
            let geometry = SCNPlane(width: CGFloat(plane.extent.x), height: CGFloat(plane.extent.z))
            let material = SCNMaterial()
            material.diffuse.contents = UIColor.cyan.withAlphaComponent(0.16)
            material.isDoubleSided = true
            geometry.materials = [material]
            let planeNode = SCNNode(geometry: geometry)
            planeNode.transform = SCNMatrix4MakeRotation(-Float.pi / 2, 1, 0, 0)
            node.addChildNode(planeNode)
        }
    }
}
