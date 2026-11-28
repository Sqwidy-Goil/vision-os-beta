import SwiftUI

enum Theme {
    static let backgroundTop = Color(hex: 0x101D35)
    static let backgroundBottom = Color(hex: 0x03060D)
    static let ink = Color.white.opacity(0.96)
    static let secondaryInk = Color.white.opacity(0.64)
    static let hairline = Color.white.opacity(0.16)
    static let cyan = Color(hex: 0x67E8F9)
    static let violet = Color(hex: 0x818CF8)
    static let danger = Color(hex: 0xFB7185)
    static let corner: CGFloat = 26
    static let spacing: CGFloat = 18
    static let animation = Animation.spring(response: 0.38, dampingFraction: 0.82)
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

struct Typography {
    static let largeTitle = Font.system(size: 34, weight: .semibold, design: .rounded)
    static let title = Font.system(size: 22, weight: .semibold, design: .rounded)
    static let headline = Font.system(size: 16, weight: .semibold, design: .rounded)
    static let body = Font.system(size: 15, weight: .regular, design: .rounded)
    static let caption = Font.system(size: 12, weight: .medium, design: .rounded)
    static let mono = Font.system(size: 12, weight: .medium, design: .monospaced)
}

struct GlassPanel<Content: View>: View {
    private let cornerRadius: CGFloat
    private let content: Content

    init(cornerRadius: CGFloat = Theme.corner, @ViewBuilder content: () -> Content) {
        self.cornerRadius = cornerRadius
        self.content = content()
    }

    var body: some View {
        content
            .background {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .background(
                        LinearGradient(
                            colors: [Color.white.opacity(0.12), Color.white.opacity(0.025)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                            .stroke(
                                LinearGradient(
                                    colors: [Color.white.opacity(0.4), Color.white.opacity(0.08)],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                ),
                                lineWidth: 1
                            )
                    }
                    .shadow(color: .black.opacity(0.32), radius: 28, x: 0, y: 16)
            }
    }
}

extension View {
    func glassPanel(cornerRadius: CGFloat = Theme.corner) -> some View {
        GlassPanel(cornerRadius: cornerRadius) { self }
    }

    func spatialStatus() -> some View {
        font(Typography.caption)
            .foregroundStyle(Theme.secondaryInk)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial, in: Capsule())
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typography.headline)
            .foregroundStyle(Color(hex: 0x04121C))
            .padding(.horizontal, 22)
            .padding(.vertical, 13)
            .background(
                LinearGradient(colors: [Theme.cyan, Color(hex: 0xA5F3FC)], startPoint: .topLeading, endPoint: .bottomTrailing),
                in: Capsule()
            )
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(Theme.animation, value: configuration.isPressed)
    }
}

struct QuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typography.headline)
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().stroke(Theme.hairline, lineWidth: 1))
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(Theme.animation, value: configuration.isPressed)
    }
}
