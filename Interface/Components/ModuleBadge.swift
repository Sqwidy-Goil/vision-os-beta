import SwiftUI

struct ModuleBadge: View {
    let module: AppModule
    var size: CGFloat = 52

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(module.tint.opacity(0.2))
            .overlay {
                RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                    .stroke(module.tint.opacity(0.4), lineWidth: 1)
            }
            .overlay {
                Image(systemName: module.symbol)
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(module.tint)
            }
            .frame(width: size, height: size)
    }
}

struct StatusPill: View {
    let text: String
    var color: Color = Theme.cyan

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text).font(Typography.caption).foregroundStyle(Theme.secondaryInk)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial, in: Capsule())
    }
}
