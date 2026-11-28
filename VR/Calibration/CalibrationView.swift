import SwiftUI

struct CalibrationView: View {
    @ObservedObject var settings: AppSettings
    @ObservedObject var motion: MotionTracker
    var onEnter: () -> Void
    var onCancel: () -> Void

    @State private var countdown = 0
    @State private var timer: Timer?

    var body: some View {
        ZStack {
            LinearGradient(colors: [Theme.backgroundTop, Theme.backgroundBottom], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            ScrollView {
                VStack(spacing: 20) {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("CARDBOARD CALIBRATION").font(Typography.caption).foregroundStyle(Theme.cyan)
                            Text("Fit your spatial view").font(Typography.largeTitle).foregroundStyle(Theme.ink)
                        }
                        Spacer()
                        Button("Cancel", action: onCancel).buttonStyle(QuietButtonStyle())
                    }

                    HStack(spacing: 24) {
                        VStack(alignment: .leading, spacing: 14) {
                            settingSlider("Eye separation", value: $settings.ipdMillimeters, range: 54...75, unit: "mm")
                            settingSlider("Screen distance", value: $settings.viewingDistance, range: 2.2...5.5, unit: "m")
                            settingSlider("Field of view", value: $settings.fieldOfView, range: 60...100, unit: "°")
                            settingSlider("Lens correction", value: $settings.lensDistortion, range: -0.35...0.35, unit: "")
                            Toggle("Motion look", isOn: $settings.motionEnabled).tint(Theme.cyan)
                            HStack {
                                Text("Motion: \(motionStatus)").font(Typography.caption).foregroundStyle(Theme.secondaryInk)
                                Button("Recalibrate", action: motion.calibrate).buttonStyle(QuietButtonStyle())
                            }
                        }
                        .padding(22)
                        .glassPanel()

                        VStack(spacing: 16) {
                            Image(systemName: "viewfinder")
                                .font(.system(size: 54, weight: .light))
                                .foregroundStyle(Theme.cyan)
                            Text("Place the phone in landscape inside your headset.")
                                .font(Typography.title)
                                .multilineTextAlignment(.center)
                            Text("Adjust the controls until both views feel centered and comfortable. Entering VR starts a three-second countdown so you can put the headset on.")
                                .font(Typography.body)
                                .foregroundStyle(Theme.secondaryInk)
                                .multilineTextAlignment(.center)
                            Button(countdown > 0 ? "Enter VR in \(countdown)…" : "Enter VR", action: beginCountdown)
                                .buttonStyle(PrimaryButtonStyle())
                                .accessibilityIdentifier("calibration-enter-vr")
                                .disabled(countdown > 0)
                            Text("In VR: gaze to select, dwell to focus, swipe up/down to cycle windows. Tap the upper-right exit icon in either eye or swipe down with three fingers to leave.")
                                .font(Typography.caption)
                                .foregroundStyle(Theme.secondaryInk)
                                .multilineTextAlignment(.center)
                        }
                        .padding(26)
                        .glassPanel()
                    }
                }
                .padding(32)
            }
        }
        .onAppear { motion.calibrate() }
        .onDisappear { timer?.invalidate() }
    }

    private func beginCountdown() {
        countdown = 3
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            countdown -= 1
            if countdown == 0 {
                timer?.invalidate()
                onEnter()
            }
        }
    }

    private var motionStatus: String {
        switch motion.status {
        case .unavailable: "unavailable"
        case .stopped: "stopped"
        case .running: "tracking"
        case .interrupted: "interrupted"
        case .failed: "sensor error"
        }
    }

    private func settingSlider(_ title: String, value: Binding<Double>, range: ClosedRange<Double>, unit: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title).font(Typography.headline).foregroundStyle(Theme.ink)
                Spacer()
                Text("\(Int(value.wrappedValue.rounded())) \(unit)").font(Typography.mono).foregroundStyle(Theme.cyan)
            }
            Slider(value: value, in: range).tint(Theme.cyan)
        }
    }
}
