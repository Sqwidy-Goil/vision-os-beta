import UIKit
import SwiftUI

private extension WindowPlacement {
    var size: CGSize {
        CGSize(width: max(CGFloat(width) * 256, 1), height: max(CGFloat(height) * 256, 1))
    }
}

enum WindowTextureFactory {
    private struct Layout {
        let scale: CGFloat
        let margin: CGFloat
        let corner: CGFloat
        let headerY: CGFloat
        let controlsY: CGFloat
        let statusY: CGFloat
        let contentY: CGFloat
        let contentHeight: CGFloat
        let footerY: CGFloat
        let controlDiameter: CGFloat
        let titleSize: CGFloat
        let bodySize: CGFloat
        let iconSize: CGFloat

        init(size: CGSize) {
            let compact = size.width / size.height > 3
            scale = min(size.width / 640, size.height / 360)
            margin = 18 * scale
            corner = (compact ? 22 : 30) * scale
            headerY = 20 * scale
            controlsY = 20 * scale
            controlDiameter = 24 * scale
            titleSize = (compact ? 15 : 21) * scale
            bodySize = (compact ? 9 : 12) * scale
            iconSize = (compact ? 28 : 40) * scale
            if compact {
                statusY = 25 * scale
                contentY = 50 * scale
                contentHeight = size.height - 74 * scale
                footerY = 24 * scale
            } else {
                statusY = 66 * scale
                contentY = 102 * scale
                contentHeight = size.height - 146 * scale
                footerY = size.height - 37 * scale
            }
        }
    }

    private struct Palette {
        let accent: UIColor
        let top: UIColor
        let bottom: UIColor

        init(module: AppModule) {
            switch module {
            case .browser:
                accent = UIColor(red: 0.337, green: 0.722, blue: 1, alpha: 1)
                top = UIColor(red: 0.045, green: 0.13, blue: 0.24, alpha: 0.93)
                bottom = UIColor(red: 0.015, green: 0.035, blue: 0.075, alpha: 0.97)
            case .photos:
                accent = UIColor(red: 1, green: 0.494, blue: 0.659, alpha: 1)
                top = UIColor(red: 0.20, green: 0.055, blue: 0.14, alpha: 0.93)
                bottom = UIColor(red: 0.045, green: 0.018, blue: 0.055, alpha: 0.97)
            case .video:
                accent = UIColor(red: 0.655, green: 0.545, blue: 0.98, alpha: 1)
                top = UIColor(red: 0.105, green: 0.065, blue: 0.23, alpha: 0.94)
                bottom = UIColor(red: 0.025, green: 0.02, blue: 0.07, alpha: 0.97)
            case .camera:
                accent = UIColor(red: 0.369, green: 0.918, blue: 0.831, alpha: 1)
                top = UIColor(red: 0.025, green: 0.17, blue: 0.16, alpha: 0.93)
                bottom = UIColor(red: 0.012, green: 0.04, blue: 0.055, alpha: 0.97)
            case .music:
                accent = UIColor(red: 0.984, green: 0.443, blue: 0.522, alpha: 1)
                top = UIColor(red: 0.24, green: 0.045, blue: 0.12, alpha: 0.94)
                bottom = UIColor(red: 0.045, green: 0.015, blue: 0.055, alpha: 0.97)
            case .scanner:
                accent = UIColor(red: 0.639, green: 0.902, blue: 0.208, alpha: 1)
                top = UIColor(red: 0.075, green: 0.16, blue: 0.035, alpha: 0.94)
                bottom = UIColor(red: 0.018, green: 0.04, blue: 0.025, alpha: 0.97)
            case .files:
                accent = UIColor(red: 0.984, green: 0.749, blue: 0.141, alpha: 1)
                top = UIColor(red: 0.20, green: 0.12, blue: 0.025, alpha: 0.94)
                bottom = UIColor(red: 0.045, green: 0.03, blue: 0.015, alpha: 0.97)
            case .settings:
                accent = UIColor(red: 0.58, green: 0.647, blue: 0.722, alpha: 1)
                top = UIColor(red: 0.075, green: 0.095, blue: 0.14, alpha: 0.95)
                bottom = UIColor(red: 0.02, green: 0.028, blue: 0.05, alpha: 0.97)
            case .environments:
                accent = UIColor(red: 0.506, green: 0.553, blue: 0.973, alpha: 1)
                top = UIColor(red: 0.07, green: 0.07, blue: 0.23, alpha: 0.94)
                bottom = UIColor(red: 0.02, green: 0.025, blue: 0.075, alpha: 0.97)
            case .windows:
                accent = UIColor(red: 0.404, green: 0.91, blue: 0.973, alpha: 1)
                top = UIColor(red: 0.025, green: 0.13, blue: 0.18, alpha: 0.94)
                bottom = UIColor(red: 0.012, green: 0.035, blue: 0.06, alpha: 0.97)
            }
        }
    }

    private static let white = UIColor.white.withAlphaComponent(0.95)
    private static let secondary = UIColor.white.withAlphaComponent(0.59)
    private static let tertiary = UIColor.white.withAlphaComponent(0.34)

    static func image(for window: SpatialWindow, status: String? = nil) -> UIImage {
        let layout = Layout(size: window.placement.size)
        return render(size: window.placement.size, minimized: window.lifecycle == .minimized) { context, size in
            let palette = Palette(module: window.module)
            let outer = roundedRect(CGRect(origin: .zero, size: size), radius: layout.corner)
            context.saveGState()
            context.setShadow(offset: CGSize(width: 0, height: 10 * layout.scale), blur: 26 * layout.scale, color: UIColor.black.withAlphaComponent(0.4).cgColor)
            fill(outer, color: UIColor.black.withAlphaComponent(0.4))
            context.restoreGState()

            context.saveGState()
            outer.addClip()
            drawGlassGradient(in: size, palette: palette)
            drawHighlights(in: size, layout: layout, palette: palette)

            let compact = window.lifecycle == .minimized
            let titleRect = titleRect(in: size, layout: layout, compact: compact, pinned: window.isPinned)
            drawIcon(window.module.symbol, color: palette.accent, pointSize: layout.iconSize, in: iconRect(in: size, layout: layout, compact: compact))
            drawText(window.module.title, in: titleRect, size: layout.titleSize, weight: .semibold, color: white)
            if !compact {
                let subtitleRect = CGRect(x: 64 * layout.scale, y: 49 * layout.scale, width: max(0, size.width - 176 * layout.scale), height: 18 * layout.scale)
                drawText(window.module.subtitle, in: subtitleRect, size: 11 * layout.scale, weight: .medium, color: secondary)
                let label = status.flatMap { $0.isEmpty ? nil : $0 } ?? defaultStatus(for: window.module)
                drawText(label, in: statusRect(in: size, layout: layout), size: 10 * layout.scale, weight: .semibold, color: palette.accent)
                let content = CGRect(x: layout.margin, y: layout.contentY, width: size.width - layout.margin * 2, height: layout.contentHeight)
                context.saveGState()
                roundedRect(content, radius: 18 * layout.scale).addClip()
                drawContent(window.module, in: content, scale: layout.scale, palette: palette)
                context.restoreGState()
                stroke(roundedRect(content, radius: 18 * layout.scale), color: UIColor.white.withAlphaComponent(0.13), lineWidth: layout.scale)
                drawFooter(in: size, layout: layout)
            } else {
                drawMinimizedContent(window.module, in: minimizedContentRect(in: size, layout: layout), layout: layout, palette: palette)
            }
            context.restoreGState()

            stroke(
                roundedRect(CGRect(origin: .zero, size: size).insetBy(dx: 0.5 * layout.scale, dy: 0.5 * layout.scale), radius: layout.corner),
                color: UIColor.white.withAlphaComponent(0.29),
                lineWidth: layout.scale
            )
            drawControls(in: size, layout: layout, minimized: compact)
        }
    }

    static func placeholder() -> UIImage {
        render(size: CGSize(width: 640, height: 360)) { _, size in
            let layout = Layout(size: size)
            let palette = Palette(module: .windows)
            let outer = roundedRect(CGRect(origin: .zero, size: size), radius: layout.corner)
            fill(outer, color: UIColor(red: 0.025, green: 0.045, blue: 0.075, alpha: 0.93))
            drawGlassGradient(in: size, palette: palette)
            drawHighlights(in: size, layout: layout, palette: palette)
            drawIcon("rectangle.on.rectangle", color: palette.accent, pointSize: 46, in: CGRect(x: 288, y: 98, width: 64, height: 64))
            drawCenteredText("No window open", in: CGRect(x: 40, y: 176, width: 560, height: 30), size: 22, weight: .semibold, color: white)
            drawCenteredText("Choose a module to begin", in: CGRect(x: 40, y: 211, width: 560, height: 22), size: 13, weight: .medium, color: secondary)
            drawCenteredText("Drag to move  •  Pinch to resize  •  Hold to open app", in: CGRect(x: 40, y: 300, width: 560, height: 22), size: 11, weight: .medium, color: secondary)
            stroke(roundedRect(CGRect(origin: .zero, size: size).insetBy(dx: 0.5, dy: 0.5), radius: layout.corner), color: UIColor.white.withAlphaComponent(0.25), lineWidth: 1)
        }
    }

    private static func render(size: CGSize, minimized: Bool = false, body: (CGContext, CGSize) -> Void) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        format.preferredRange = .standard
        return UIGraphicsImageRenderer(size: size, format: format).image { rendererContext in
            let context = rendererContext.cgContext
            context.setAllowsAntialiasing(true)
            context.setShouldAntialias(true)
            body(context, size)
        }
    }

    private static func roundedRect(_ rect: CGRect, radius: CGFloat) -> UIBezierPath {
        UIBezierPath(roundedRect: rect, cornerRadius: max(0, min(radius, min(rect.width, rect.height) / 2)))
    }

    private static func fill(_ path: UIBezierPath, color: UIColor) {
        color.setFill()
        path.fill()
    }

    private static func stroke(_ path: UIBezierPath, color: UIColor, lineWidth: CGFloat) {
        color.setStroke()
        path.lineWidth = lineWidth
        path.stroke()
    }

    private static func drawGlassGradient(in size: CGSize, palette: Palette) {
        let colors = [palette.top.cgColor, palette.bottom.cgColor] as CFArray
        if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
            UIGraphicsGetCurrentContext()?.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width * 0.65, y: size.height), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        }
        UIColor(red: 0.45, green: 0.62, blue: 0.85, alpha: 0.055).setFill()
        UIGraphicsGetCurrentContext()?.fill(CGRect(origin: .zero, size: size))
    }

    private static func drawHighlights(in size: CGSize, layout: Layout, palette: Palette) {
        let context = UIGraphicsGetCurrentContext()
        context?.saveGState()
        context?.setBlendMode(.screen)
        palette.accent.withAlphaComponent(0.13).setFill()
        context?.fillEllipse(in: CGRect(x: -size.width * 0.12, y: -size.height * 0.45, width: size.width * 0.7, height: size.height * 0.9))
        UIColor.white.withAlphaComponent(0.07).setFill()
        context?.fillEllipse(in: CGRect(x: size.width * 0.45, y: -size.height * 0.4, width: size.width * 0.75, height: size.height * 0.85))
        context?.restoreGState()
        let sheen = UIBezierPath()
        sheen.move(to: CGPoint(x: layout.corner, y: 1 * layout.scale))
        sheen.addLine(to: CGPoint(x: size.width - layout.corner, y: 1 * layout.scale))
        UIColor.white.withAlphaComponent(0.19).setStroke()
        sheen.lineWidth = layout.scale
        sheen.stroke()
    }

    private static func defaultStatus(for module: AppModule) -> String {
        switch module {
        case .browser: "Ready • on-device controls"
        case .photos: "On-device library"
        case .video: "On-device playback"
        case .camera: "Preview only • not recording"
        case .music: "Local audio • stopped"
        case .scanner: "Scan ready • not capturing"
        case .files: "On-device storage"
        case .settings: "Display and motion controls"
        case .environments: "4 environment presets"
        case .windows: "Spatial arrangement"
        }
    }

    private static func iconRect(in size: CGSize, layout: Layout, compact: Bool) -> CGRect {
        compact
            ? CGRect(x: layout.margin, y: (size.height - layout.iconSize) / 2, width: layout.iconSize, height: layout.iconSize)
            : CGRect(x: layout.margin, y: 23 * layout.scale, width: layout.iconSize, height: layout.iconSize)
    }

    private static func titleRect(in size: CGSize, layout: Layout, compact: Bool, pinned: Bool) -> CGRect {
        let x = compact ? 57 * layout.scale : 64 * layout.scale
        let width = size.width - x - 110 * layout.scale - (pinned ? 16 * layout.scale : 0)
        return CGRect(x: x, y: compact ? (size.height - layout.titleSize) / 2 : layout.headerY, width: max(0, width), height: layout.titleSize + 8 * layout.scale)
    }

    private static func statusRect(in size: CGSize, layout: Layout) -> CGRect {
        CGRect(x: 64 * layout.scale, y: layout.statusY, width: max(0, size.width - 190 * layout.scale), height: 17 * layout.scale)
    }

    private static func minimizedContentRect(in size: CGSize, layout: Layout) -> CGRect {
        let width = max(0, size.width - 204 * layout.scale)
        return CGRect(x: size.width - width - 92 * layout.scale, y: 12 * layout.scale, width: width, height: size.height - 24 * layout.scale)
    }

    private static func drawIcon(_ symbol: String, color: UIColor, pointSize: CGFloat, in rect: CGRect) {
        let configuration = UIImage.SymbolConfiguration(pointSize: pointSize, weight: .semibold, scale: .medium)
        guard let image = UIImage(systemName: symbol, withConfiguration: configuration) else { return }
        let dimension = min(rect.width, rect.height) * 0.76
        let target = CGRect(x: rect.midX - dimension / 2, y: rect.midY - dimension / 2, width: dimension, height: dimension)
        color.setFill()
        image.withRenderingMode(.alwaysTemplate).draw(in: target, blendMode: .normal, alpha: 1)
    }

    private static func drawText(_ text: String, in rect: CGRect, size: CGFloat, weight: UIFont.Weight, color: UIColor) {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: size, weight: weight),
            .foregroundColor: color
        ]
        let attributed = NSAttributedString(string: text, attributes: attributes)
        let bounding = attributed.boundingRect(with: CGSize(width: rect.width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
        attributed.draw(in: CGRect(x: rect.minX, y: rect.midY - bounding.height / 2, width: rect.width, height: bounding.height))
    }

    private static func drawCenteredText(_ text: String, in rect: CGRect, size: CGFloat, weight: UIFont.Weight, color: UIColor) {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: size, weight: weight),
            .foregroundColor: color
        ]
        NSAttributedString(string: text, attributes: attributes).draw(in: rect)
    }

    private static func panel(_ rect: CGRect, scale: CGFloat, radius: CGFloat = 12, fill: UIColor = UIColor.white.withAlphaComponent(0.065)) -> UIBezierPath {
        let path = roundedRect(rect, radius: radius * scale)
        fill.setFill()
        path.fill()
        stroke(path, color: UIColor.white.withAlphaComponent(0.09), lineWidth: 0.7 * scale)
        return path
    }

    private static func line(_ from: CGPoint, _ to: CGPoint, color: UIColor, width: CGFloat) {
        let path = UIBezierPath()
        path.move(to: from)
        path.addLine(to: to)
        color.setStroke()
        path.lineWidth = width
        path.lineCapStyle = .round
        path.stroke()
    }

    private static func drawControls(in size: CGSize, layout: Layout, minimized: Bool) {
        let y = minimized ? (size.height - layout.controlDiameter) / 2 : layout.controlsY
        let close = CGRect(x: size.width - layout.margin - layout.controlDiameter, y: y, width: layout.controlDiameter, height: layout.controlDiameter)
        let minimize = CGRect(x: close.minX - 32 * layout.scale, y: y, width: layout.controlDiameter, height: layout.controlDiameter)
        for rect in [minimize, close] {
            let path = roundedRect(rect, radius: rect.height / 2)
            UIColor.black.withAlphaComponent(0.2).setFill()
            path.fill()
            stroke(path, color: UIColor.white.withAlphaComponent(0.17), lineWidth: 0.8 * layout.scale)
        }
        UIColor.white.withAlphaComponent(0.78).setStroke()
        let minimizeMark = UIBezierPath()
        minimizeMark.move(to: CGPoint(x: minimize.minX + 7 * layout.scale, y: minimize.midY + 2 * layout.scale))
        minimizeMark.addLine(to: CGPoint(x: minimize.maxX - 7 * layout.scale, y: minimize.midY + 2 * layout.scale))
        minimizeMark.lineWidth = 1.4 * layout.scale
        minimizeMark.lineCapStyle = .round
        minimizeMark.stroke()
        let closeMark = UIBezierPath()
        closeMark.move(to: CGPoint(x: close.minX + 7.5 * layout.scale, y: close.minY + 7.5 * layout.scale))
        closeMark.addLine(to: CGPoint(x: close.maxX - 7.5 * layout.scale, y: close.maxY - 7.5 * layout.scale))
        closeMark.move(to: CGPoint(x: close.maxX - 7.5 * layout.scale, y: close.minY + 7.5 * layout.scale))
        closeMark.addLine(to: CGPoint(x: close.minX + 7.5 * layout.scale, y: close.maxY - 7.5 * layout.scale))
        closeMark.lineWidth = 1.4 * layout.scale
        closeMark.stroke()
    }

    private static func drawFooter(in size: CGSize, layout: Layout) {
        let rect = CGRect(x: layout.margin, y: layout.footerY, width: size.width - layout.margin * 2, height: 17 * layout.scale)
        drawCenteredText("Illustrated preview   •   Hold to open full app", in: rect, size: 10 * layout.scale, weight: .medium, color: secondary)
    }

    private static func drawMinimizedContent(_ module: AppModule, in rect: CGRect, layout: Layout, palette: Palette) {
        let context = UIGraphicsGetCurrentContext()
        context?.saveGState()
        roundedRect(rect, radius: 8 * layout.scale).addClip()
        panel(rect, scale: layout.scale, radius: 8)
        let inset = rect.insetBy(dx: 8 * layout.scale, dy: 5 * layout.scale)
        let dotY = rect.midY
        palette.accent.withAlphaComponent(0.9).setFill()
        context?.fill(CGRect(x: inset.minX, y: dotY - 2 * layout.scale, width: 4 * layout.scale, height: 4 * layout.scale))
        drawText(defaultStatus(for: module), in: CGRect(x: inset.minX + 11 * layout.scale, y: rect.minY, width: max(0, inset.width - 12 * layout.scale), height: rect.height), size: layout.bodySize, weight: .medium, color: secondary)
        for index in 0..<8 {
            let height = CGFloat(4 + (index * 7 % 13)) * layout.scale
            let x = rect.maxX - CGFloat(48 - index * 5) * layout.scale
            palette.accent.withAlphaComponent(0.24 + Double(index % 3) * 0.17).setFill()
            context?.fill(CGRect(x: x, y: dotY - height / 2, width: 2 * layout.scale, height: height))
        }
        context?.restoreGState()
    }

    private static func drawContent(_ module: AppModule, in rect: CGRect, scale: CGFloat, palette: Palette) {
        switch module {
        case .browser:
            drawBrowser(in: rect, scale: scale, palette: palette)
        case .photos:
            drawPhotos(in: rect, scale: scale, palette: palette)
        case .video:
            drawVideo(in: rect, scale: scale, palette: palette)
        case .camera:
            drawCamera(in: rect, scale: scale, palette: palette)
        case .music:
            drawMusic(in: rect, scale: scale, palette: palette)
        case .scanner:
            drawScanner(in: rect, scale: scale, palette: palette)
        case .files:
            drawFiles(in: rect, scale: scale, palette: palette)
        case .settings:
            drawSettings(in: rect, scale: scale, palette: palette)
        case .environments:
            drawEnvironments(in: rect, scale: scale, palette: palette)
        case .windows:
            drawWindows(in: rect, scale: scale, palette: palette)
        }
    }

    private static func drawBrowser(in rect: CGRect, scale: CGFloat, palette: Palette) {
        let address = CGRect(x: 18 * scale, y: 16 * scale, width: rect.width - 36 * scale, height: 34 * scale)
        panel(address, scale: scale, radius: 17, fill: UIColor.black.withAlphaComponent(0.18))
        drawIcon("lock", color: secondary, pointSize: 11 * scale, in: CGRect(x: address.minX + 11 * scale, y: address.minY + 8 * scale, width: 17 * scale, height: 18 * scale))
        drawText("Search or enter a local address", in: CGRect(x: address.minX + 36 * scale, y: address.minY, width: address.width - 66 * scale, height: address.height), size: 11 * scale, weight: .medium, color: tertiary)
        var card = rect.insetBy(dx: 18 * scale, dy: 0).offsetBy(dx: 0, dy: 64 * scale)
        card.size.height = rect.height - 79 * scale
        panel(card, scale: scale, radius: 13, fill: palette.accent.withAlphaComponent(0.055))
        drawText("Start page", in: CGRect(x: card.minX + 17 * scale, y: card.minY + 9 * scale, width: card.width - 34 * scale, height: 23 * scale), size: 14 * scale, weight: .semibold, color: white)
        drawText("Illustrated start page", in: CGRect(x: card.minX + 17 * scale, y: card.minY + 34 * scale, width: card.width - 34 * scale, height: 19 * scale), size: 10 * scale, weight: .medium, color: secondary)
        let tileWidth = (card.width - 51 * scale) / 3
        for index in 0..<3 {
            let x = card.minX + 17 * scale + CGFloat(index) * (tileWidth + 8.5 * scale)
            panel(CGRect(x: x, y: card.minY + 67 * scale, width: tileWidth, height: 34 * scale), scale: scale, radius: 8, fill: UIColor.white.withAlphaComponent(0.045))
            let dot = CGRect(x: x + 10 * scale, y: card.minY + 78 * scale, width: 11 * scale, height: 11 * scale)
            palette.accent.withAlphaComponent(0.35 + Double(index) * 0.15).setFill()
            UIGraphicsGetCurrentContext()?.fillEllipse(in: dot)
            drawText(["Browser", "Website", "Address"][index], in: CGRect(x: x + 28 * scale, y: card.minY + 67 * scale, width: tileWidth - 33 * scale, height: 34 * scale), size: 9.5 * scale, weight: .medium, color: secondary)
        }
    }

    private static func drawPhotos(in rect: CGRect, scale: CGFloat, palette: Palette) {
        let gap = 9 * scale
        let leftWidth = (rect.width - gap * 2) * 0.61
        let rightWidth = rect.width - leftWidth - gap * 2
        let heights = [(rect.height - 38 * scale) * 0.46, (rect.height - 38 * scale) * 0.54]
        var y = rect.minY
        for index in 0..<2 {
            let tile = CGRect(x: rect.minX, y: y, width: leftWidth, height: heights[index])
            drawPhotoTile(tile, variant: index, scale: scale, palette: palette)
            y += tile.height + gap
        }
        let rightTop = CGRect(x: rect.minX + leftWidth + gap, y: rect.minY, width: rightWidth, height: rect.height * 0.55)
        let rightBottom = CGRect(x: rightTop.minX, y: rightTop.maxY + gap, width: rightWidth, height: rect.height - rightTop.height - gap)
        drawPhotoTile(rightTop, variant: 2, scale: scale, palette: palette)
        drawPhotoTile(rightBottom, variant: 3, scale: scale, palette: palette)
    }

    private static func drawPhotoTile(_ rect: CGRect, variant: Int, scale: CGFloat, palette: Palette) {
        let context = UIGraphicsGetCurrentContext()
        context?.saveGState()
        roundedRect(rect, radius: 12 * scale).addClip()
        let colors: [UIColor] = variant == 0
            ? [UIColor(red: 0.18, green: 0.42, blue: 0.55, alpha: 1), UIColor(red: 0.95, green: 0.51, blue: 0.39, alpha: 1)]
            : variant == 1
                ? [UIColor(red: 0.38, green: 0.18, blue: 0.45, alpha: 1), UIColor(red: 0.96, green: 0.61, blue: 0.48, alpha: 1)]
                : variant == 2
                    ? [UIColor(red: 0.08, green: 0.28, blue: 0.31, alpha: 1), UIColor(red: 0.32, green: 0.73, blue: 0.62, alpha: 1)]
                    : [UIColor(red: 0.25, green: 0.22, blue: 0.48, alpha: 1), UIColor(red: 0.74, green: 0.56, blue: 0.84, alpha: 1)]
        if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors.map(\.cgColor) as CFArray, locations: [0, 1]) {
            context?.drawLinearGradient(gradient, start: rect.origin, end: CGPoint(x: rect.maxX, y: rect.maxY), options: [])
        }
        UIColor.black.withAlphaComponent(0.38).setFill()
        context?.fillEllipse(in: CGRect(x: rect.maxX - 40 * scale, y: rect.minY + 15 * scale, width: 20 * scale, height: 20 * scale))
        let mountain = UIBezierPath()
        mountain.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        mountain.addLine(to: CGPoint(x: rect.minX + rect.width * 0.34, y: rect.minY + rect.height * 0.48))
        mountain.addLine(to: CGPoint(x: rect.minX + rect.width * 0.62, y: rect.maxY))
        mountain.close()
        UIColor(red: 0.06, green: 0.12, blue: 0.18, alpha: 0.55).setFill()
        mountain.fill()
        let foreground = UIBezierPath()
        foreground.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        foreground.addLine(to: CGPoint(x: rect.minX + rect.width * 0.62, y: rect.minY + rect.height * 0.64))
        foreground.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        foreground.close()
        UIColor(red: 0.025, green: 0.065, blue: 0.09, alpha: 0.72).setFill()
        foreground.fill()
        palette.accent.withAlphaComponent(0.16).setFill()
        context?.fillEllipse(in: rect.insetBy(dx: rect.width * 0.18, dy: rect.height * 0.12))
        context?.restoreGState()
        stroke(roundedRect(rect, radius: 12 * scale), color: UIColor.white.withAlphaComponent(0.18), lineWidth: 0.7 * scale)
    }

    private static func drawVideo(in rect: CGRect, scale: CGFloat, palette: Palette) {
        let stageHeight = rect.height - 62 * scale
        let stage = CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: stageHeight)
        let context = UIGraphicsGetCurrentContext()
        context?.saveGState()
        roundedRect(stage, radius: 13 * scale).addClip()
        let colors = [UIColor(red: 0.08, green: 0.045, blue: 0.18, alpha: 1).cgColor, UIColor(red: 0.31, green: 0.12, blue: 0.36, alpha: 1).cgColor] as CFArray
        if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
            context?.drawLinearGradient(gradient, start: stage.origin, end: CGPoint(x: stage.maxX, y: stage.maxY), options: [])
        }
        let sun = CGRect(x: stage.midX - 34 * scale, y: stage.minY + 30 * scale, width: 68 * scale, height: 68 * scale)
        palette.accent.withAlphaComponent(0.33).setFill()
        context?.fillEllipse(in: sun)
        for index in 0..<4 {
            let mountain = UIBezierPath()
            mountain.move(to: CGPoint(x: stage.minX, y: stage.maxY))
            mountain.addLine(to: CGPoint(x: stage.minX + stage.width * (0.2 + CGFloat(index) * 0.24), y: stage.minY + stageHeight * (0.52 + CGFloat(index % 2) * 0.12)))
            mountain.addLine(to: CGPoint(x: stage.maxX, y: stage.maxY))
            mountain.close()
            UIColor(red: 0.025 + CGFloat(index) * 0.01, green: 0.025, blue: 0.07 + CGFloat(index) * 0.015, alpha: 0.82).setFill()
            mountain.fill()
        }
        context?.restoreGState()
        let playDiameter = 44 * scale
        let play = CGRect(x: stage.midX - playDiameter / 2, y: stage.midY - playDiameter / 2, width: playDiameter, height: playDiameter)
        fill(roundedRect(play, radius: playDiameter / 2), color: UIColor.black.withAlphaComponent(0.42))
        stroke(roundedRect(play, radius: playDiameter / 2), color: UIColor.white.withAlphaComponent(0.25), lineWidth: scale)
        let triangle = UIBezierPath()
        triangle.move(to: CGPoint(x: play.midX - 4 * scale, y: play.midY - 8 * scale))
        triangle.addLine(to: CGPoint(x: play.midX + 9 * scale, y: play.midY))
        triangle.addLine(to: CGPoint(x: play.midX - 4 * scale, y: play.midY + 8 * scale))
        triangle.close()
        white.setFill()
        triangle.fill()
        drawText("A quiet horizon", in: CGRect(x: stage.minX + 15 * scale, y: stage.maxY - 27 * scale, width: stage.width - 30 * scale, height: 20 * scale), size: 11 * scale, weight: .semibold, color: white)
        let track = CGRect(x: rect.minX + 14 * scale, y: stage.maxY + 20 * scale, width: rect.width - 28 * scale, height: 3 * scale)
        panel(track, scale: scale, radius: 1.5, fill: UIColor.white.withAlphaComponent(0.13))
        panel(CGRect(x: track.minX, y: track.minY, width: track.width * 0.32, height: track.height), scale: scale, radius: 1.5, fill: palette.accent)
        palette.accent.setFill()
        UIGraphicsGetCurrentContext()?.fillEllipse(in: CGRect(x: track.minX + track.width * 0.32 - 4 * scale, y: track.midY - 4 * scale, width: 8 * scale, height: 8 * scale))
        drawText("0:00", in: CGRect(x: rect.minX, y: stage.maxY + 31 * scale, width: 42 * scale, height: 17 * scale), size: 9 * scale, weight: .medium, color: secondary)
        drawText("0:42", in: CGRect(x: rect.maxX - 42 * scale, y: stage.maxY + 31 * scale, width: 42 * scale, height: 17 * scale), size: 9 * scale, weight: .medium, color: secondary)
        drawCenteredText("Sample timeline • local playback", in: CGRect(x: rect.minX + 42 * scale, y: stage.maxY + 31 * scale, width: rect.width - 84 * scale, height: 17 * scale), size: 9 * scale, weight: .medium, color: secondary)
    }

    private static func drawCamera(in rect: CGRect, scale: CGFloat, palette: Palette) {
        let context = UIGraphicsGetCurrentContext()
        let stage = rect.insetBy(dx: 0, dy: 0)
        context?.saveGState()
        roundedRect(stage, radius: 13 * scale).addClip()
        let colors = [UIColor(red: 0.025, green: 0.055, blue: 0.07, alpha: 1).cgColor, UIColor(red: 0.06, green: 0.16, blue: 0.18, alpha: 1).cgColor] as CFArray
        if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
            context?.drawLinearGradient(gradient, start: stage.origin, end: CGPoint(x: stage.maxX, y: stage.maxY), options: [])
        }
        UIColor.white.withAlphaComponent(0.045).setStroke()
        for index in 1..<3 {
            let path = UIBezierPath()
            path.move(to: CGPoint(x: stage.minX + stage.width * CGFloat(index) / 3, y: stage.minY))
            path.addLine(to: CGPoint(x: stage.minX + stage.width * CGFloat(index) / 3, y: stage.maxY))
            path.move(to: CGPoint(x: stage.minX, y: stage.minY + stage.height * CGFloat(index) / 3))
            path.addLine(to: CGPoint(x: stage.maxX, y: stage.minY + stage.height * CGFloat(index) / 3))
            path.lineWidth = 0.6 * scale
            path.stroke()
        }
        let gridColors = [palette.accent.withAlphaComponent(0.25), UIColor(red: 0.45, green: 0.52, blue: 0.7, alpha: 0.18)]
        for row in 0..<5 {
            for column in 0..<12 {
                let x = stage.minX + stage.width * (0.1 + CGFloat(column) * 0.073) + CGFloat(row % 2) * 3 * scale
                let y = stage.minY + stage.height * (0.2 + CGFloat(row) * 0.135)
                gridColors[row % 2].setFill()
                context?.fillEllipse(in: CGRect(x: x, y: y, width: 2.2 * scale, height: 2.2 * scale))
            }
        }
        let hand = UIBezierPath()
        hand.move(to: CGPoint(x: stage.midX - 23 * scale, y: stage.minY + stage.height * 0.56))
        hand.addCurve(to: CGPoint(x: stage.midX - 55 * scale, y: stage.minY + stage.height * 0.42), controlPoint1: CGPoint(x: stage.midX - 55 * scale, y: stage.minY + stage.height * 0.5), controlPoint2: CGPoint(x: stage.midX - 48 * scale, y: stage.minY + stage.height * 0.45))
        hand.addCurve(to: CGPoint(x: stage.midX - 72 * scale, y: stage.minY + stage.height * 0.33), controlPoint1: CGPoint(x: stage.midX - 63 * scale, y: stage.minY + stage.height * 0.37), controlPoint2: CGPoint(x: stage.midX - 65 * scale, y: stage.minY + stage.height * 0.35))
        hand.addCurve(to: CGPoint(x: stage.midX - 37 * scale, y: stage.minY + stage.height * 0.28), controlPoint1: CGPoint(x: stage.midX - 76 * scale, y: stage.minY + stage.height * 0.31), controlPoint2: CGPoint(x: stage.midX - 61 * scale, y: stage.minY + stage.height * 0.27))
        hand.addCurve(to: CGPoint(x: stage.midX - 5 * scale, y: stage.minY + stage.height * 0.35), controlPoint1: CGPoint(x: stage.midX - 21 * scale, y: stage.minY + stage.height * 0.28), controlPoint2: CGPoint(x: stage.midX - 15 * scale, y: stage.minY + stage.height * 0.32))
        hand.addCurve(to: CGPoint(x: stage.midX + 40 * scale, y: stage.minY + stage.height * 0.48), controlPoint1: CGPoint(x: stage.midX + 8 * scale, y: stage.minY + stage.height * 0.39), controlPoint2: CGPoint(x: stage.midX + 18 * scale, y: stage.minY + stage.height * 0.45))
        hand.addCurve(to: CGPoint(x: stage.midX + 77 * scale, y: stage.minY + stage.height * 0.6), controlPoint1: CGPoint(x: stage.midX + 65 * scale, y: stage.minY + stage.height * 0.5), controlPoint2: CGPoint(x: stage.midX + 57 * scale, y: stage.minY + stage.height * 0.57))
        hand.addCurve(to: CGPoint(x: stage.midX + 23 * scale, y: stage.minY + stage.height * 0.56), controlPoint1: CGPoint(x: stage.midX + 85 * scale, y: stage.minY + stage.height * 0.63), controlPoint2: CGPoint(x: stage.midX + 48 * scale, y: stage.minY + stage.height * 0.61))
        hand.close()
        palette.accent.withAlphaComponent(0.26).setFill()
        hand.fill()
        palette.accent.withAlphaComponent(0.75).setStroke()
        hand.lineWidth = 1.1 * scale
        hand.stroke()
        let jointPositions = [CGPoint(x: stage.midX - 55 * scale, y: stage.minY + stage.height * 0.44), CGPoint(x: stage.midX - 23 * scale, y: stage.minY + stage.height * 0.56), CGPoint(x: stage.midX + 40 * scale, y: stage.minY + stage.height * 0.48), CGPoint(x: stage.midX + 23 * scale, y: stage.minY + stage.height * 0.56)]
        for point in jointPositions {
            palette.accent.setFill()
            context?.fillEllipse(in: CGRect(x: point.x - 2.5 * scale, y: point.y - 2.5 * scale, width: 5 * scale, height: 5 * scale))
        }
        context?.restoreGState()
        stroke(roundedRect(stage, radius: 13 * scale), color: UIColor.white.withAlphaComponent(0.13), lineWidth: scale)
        let badge = CGRect(x: stage.minX + 13 * scale, y: stage.minY + 12 * scale, width: 105 * scale, height: 24 * scale)
        panel(badge, scale: scale, radius: 12, fill: UIColor.black.withAlphaComponent(0.35))
        palette.accent.setFill()
        UIGraphicsGetCurrentContext()?.fillEllipse(in: CGRect(x: badge.minX + 10 * scale, y: badge.midY - 3 * scale, width: 6 * scale, height: 6 * scale))
        drawText("Illustrated preview", in: CGRect(x: badge.minX + 22 * scale, y: badge.minY, width: badge.width - 26 * scale, height: badge.height), size: 9 * scale, weight: .semibold, color: white)
        let bracketColor = white.withAlphaComponent(0.52)
        let left = stage.minX + 15 * scale
        let right = stage.maxX - 15 * scale
        let top = stage.minY + 15 * scale
        let bottom = stage.maxY - 15 * scale
        for (x, y, sx, sy) in [(left, top, 1, 1), (right, top, -1, 1), (left, bottom, 1, -1), (right, bottom, -1, -1)] {
            line(CGPoint(x: x + CGFloat(sx) * 12 * scale, y: y), CGPoint(x: x, y: y), color: bracketColor, width: scale)
            line(CGPoint(x: x, y: y), CGPoint(x: x, y: y + CGFloat(sy) * 12 * scale), color: bracketColor, width: scale)
        }
        drawCenteredText("Synthetic viewfinder • no camera feed", in: CGRect(x: stage.minX + 25 * scale, y: stage.maxY - 28 * scale, width: stage.width - 50 * scale, height: 19 * scale), size: 9 * scale, weight: .medium, color: secondary)
    }

    private static func drawMusic(in rect: CGRect, scale: CGFloat, palette: Palette) {
        let albumSize = rect.height
        let album = CGRect(x: rect.minX, y: rect.minY, width: albumSize, height: albumSize)
        let context = UIGraphicsGetCurrentContext()
        context?.saveGState()
        roundedRect(album, radius: 15 * scale).addClip()
        let colors = [UIColor(red: 0.38, green: 0.09, blue: 0.22, alpha: 1).cgColor, UIColor(red: 0.09, green: 0.035, blue: 0.12, alpha: 1).cgColor] as CFArray
        if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
            context?.drawLinearGradient(gradient, start: album.origin, end: CGPoint(x: album.maxX, y: album.maxY), options: [])
        }
        for index in 0..<5 {
            UIColor(red: 0.92, green: 0.31, blue: 0.45, alpha: 0.13 + Double(index) * 0.04).setStroke()
            let circle = UIBezierPath(ovalIn: CGRect(x: album.midX - (36 + CGFloat(index) * 10) * scale, y: album.midY - (36 + CGFloat(index) * 10) * scale, width: (72 + CGFloat(index) * 20) * scale, height: (72 + CGFloat(index) * 20) * scale))
            circle.lineWidth = 7 * scale
            circle.stroke()
        }
        drawIcon("music.note", color: white.withAlphaComponent(0.85), pointSize: 31 * scale, in: album)
        context?.restoreGState()
        stroke(roundedRect(album, radius: 15 * scale), color: UIColor.white.withAlphaComponent(0.2), lineWidth: scale)
        let detailsX = album.maxX + 19 * scale
        let detailsWidth = rect.maxX - detailsX
        drawText("Night Transit", in: CGRect(x: detailsX, y: rect.minY + 7 * scale, width: detailsWidth, height: 24 * scale), size: 15 * scale, weight: .semibold, color: white)
        drawText("Spatial Sessions", in: CGRect(x: detailsX, y: rect.minY + 32 * scale, width: detailsWidth, height: 19 * scale), size: 10 * scale, weight: .medium, color: secondary)
        let waveform = CGRect(x: detailsX, y: rect.minY + 63 * scale, width: detailsWidth, height: 37 * scale)
        panel(waveform, scale: scale, radius: 9, fill: UIColor.black.withAlphaComponent(0.12))
        let count = 36
        let step = waveform.width / CGFloat(count)
        for index in 0..<count {
            let amplitude = 0.2 + abs(sin(Double(index) * 1.7) * 0.48 + cos(Double(index) * 0.43) * 0.28)
            let height = max(3 * scale, waveform.height * amplitude)
            fill(
                roundedRect(CGRect(x: waveform.minX + CGFloat(index) * step, y: waveform.midY - height / 2, width: max(1.5 * scale, step * 0.46), height: height), radius: scale),
                color: palette.accent.withAlphaComponent(index < count * 3 / 10 ? 0.9 : 0.3)
            )
        }
        let transportY = rect.maxY - 41 * scale
        drawText("Local audio", in: CGRect(x: detailsX, y: transportY, width: detailsWidth / 3, height: 25 * scale), size: 9 * scale, weight: .medium, color: secondary)
        let playDiameter = 33 * scale
        let play = CGRect(x: detailsX + detailsWidth / 2 - playDiameter / 2, y: transportY - 4 * scale, width: playDiameter, height: playDiameter)
        fill(roundedRect(play, radius: playDiameter / 2), color: palette.accent)
        let triangle = UIBezierPath()
        triangle.move(to: CGPoint(x: play.midX - 3 * scale, y: play.midY - 6 * scale))
        triangle.addLine(to: CGPoint(x: play.midX + 7 * scale, y: play.midY))
        triangle.addLine(to: CGPoint(x: play.midX - 3 * scale, y: play.midY + 6 * scale))
        triangle.close()
        UIColor(red: 0.14, green: 0.025, blue: 0.07, alpha: 1).setFill()
        triangle.fill()
        drawText("Preview", in: CGRect(x: rect.maxX - detailsWidth / 3, y: transportY, width: detailsWidth / 3, height: 25 * scale), size: 9 * scale, weight: .medium, color: secondary)
        let track = CGRect(x: detailsX, y: rect.maxY - 7 * scale, width: detailsWidth, height: 2.5 * scale)
        panel(track, scale: scale, radius: 1, fill: UIColor.white.withAlphaComponent(0.13))
        panel(CGRect(x: track.minX, y: track.minY, width: track.width * 0.3, height: track.height), scale: scale, radius: 1, fill: palette.accent)
    }

    private static func drawScanner(in rect: CGRect, scale: CGFloat, palette: Palette) {
        let context = UIGraphicsGetCurrentContext()
        let plot = rect.insetBy(dx: 12 * scale, dy: 10 * scale)
        panel(plot, scale: scale, radius: 12, fill: UIColor.black.withAlphaComponent(0.12))
        context?.saveGState()
        roundedRect(plot, radius: 12 * scale).addClip()
        for row in 0..<7 {
            for column in 0..<19 {
                let normalizedX = CGFloat(column) / 18
                let normalizedY = CGFloat(row) / 6
                let arch = sqrt(max(0, 1 - ((normalizedX - 0.5) * 2) * ((normalizedX - 0.5) * 2)))
                let height = (0.35 + arch * 0.62) * (0.76 + sin(Double(row * 3 + column)) * 0.12)
                let point = CGPoint(x: plot.minX + 22 * scale + normalizedX * (plot.width - 44 * scale), y: plot.maxY - 22 * scale - normalizedY * (plot.height - 47 * scale) * height)
                let radius = (1.3 + abs(sin(Double(column * 7 + row * 11))) * 1.2) * scale
                palette.accent.withAlphaComponent(0.34 + normalizedY * 0.55).setFill()
                context?.fillEllipse(in: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2))
            }
        }
        palette.accent.withAlphaComponent(0.14).setStroke()
        for row in 0..<6 {
            let path = UIBezierPath()
            for column in 0..<19 {
                let normalizedX = CGFloat(column) / 18
                let normalizedY = CGFloat(row) / 6
                let arch = sqrt(max(0, 1 - ((normalizedX - 0.5) * 2) * ((normalizedX - 0.5) * 2)))
                let height = (0.35 + arch * 0.62) * (0.76 + sin(Double(row * 3 + column)) * 0.12)
                let point = CGPoint(x: plot.minX + 22 * scale + normalizedX * (plot.width - 44 * scale), y: plot.maxY - 22 * scale - normalizedY * (plot.height - 47 * scale) * height)
                if column == 0 { path.move(to: point) } else { path.addLine(to: point) }
            }
            path.lineWidth = 0.55 * scale
            path.stroke()
        }
        context?.restoreGState()
        drawText("ILLUSTRATIVE POINT CLOUD", in: CGRect(x: plot.minX + 14 * scale, y: plot.minY + 9 * scale, width: plot.width - 28 * scale, height: 18 * scale), size: 8.5 * scale, weight: .semibold, color: secondary)
        drawText("Static preview • not captured data", in: CGRect(x: plot.minX + 14 * scale, y: plot.maxY - 24 * scale, width: plot.width - 28 * scale, height: 17 * scale), size: 8.5 * scale, weight: .medium, color: tertiary)
        let metricsY = rect.maxY - 13 * scale
        drawText("Feature points", in: CGRect(x: rect.minX, y: metricsY - 14 * scale, width: rect.width / 3, height: 14 * scale), size: 8.5 * scale, weight: .medium, color: tertiary)
        drawText("Spatial anchors", in: CGRect(x: rect.minX + rect.width / 3, y: metricsY - 14 * scale, width: rect.width / 3, height: 14 * scale), size: 8.5 * scale, weight: .medium, color: tertiary)
        drawText("Preview only", in: CGRect(x: rect.minX + rect.width * 2 / 3, y: metricsY - 14 * scale, width: rect.width / 3, height: 14 * scale), size: 8.5 * scale, weight: .semibold, color: palette.accent)
    }

    private static func drawFiles(in rect: CGRect, scale: CGFloat, palette: Palette) {
        let rows = [
            ("doc.text", "Imported documents", "Text document"),
            ("photo", "Imported photos", "Image"),
            ("square.and.arrow.up", "Imported 3D assets", "3D asset")
        ]
        let rowHeight = (rect.height - 8 * scale) / 3
        for (index, row) in rows.enumerated() {
            let y = rect.minY + CGFloat(index) * rowHeight
            panel(CGRect(x: rect.minX, y: y, width: rect.width, height: rowHeight - 7 * scale), scale: scale, radius: 10, fill: UIColor.white.withAlphaComponent(index == 0 ? 0.075 : 0.045))
            drawIcon(row.0, color: palette.accent.withAlphaComponent(0.9), pointSize: 18 * scale, in: CGRect(x: rect.minX + 12 * scale, y: y + 8 * scale, width: 30 * scale, height: 30 * scale))
            drawText(row.1, in: CGRect(x: rect.minX + 53 * scale, y: y + 1 * scale, width: rect.width - 130 * scale, height: (rowHeight - 7 * scale) * 0.55), size: 11 * scale, weight: .semibold, color: white)
            drawText(row.2, in: CGRect(x: rect.minX + 53 * scale, y: y + (rowHeight - 7 * scale) * 0.5, width: rect.width - 130 * scale, height: (rowHeight - 7 * scale) * 0.4), size: 8.5 * scale, weight: .medium, color: secondary)
            drawText("LOCAL", in: CGRect(x: rect.maxX - 59 * scale, y: y, width: 45 * scale, height: rowHeight - 7 * scale), size: 8 * scale, weight: .semibold, color: tertiary)
        }
    }

    private static func drawSettings(in rect: CGRect, scale: CGFloat, palette: Palette) {
        let rows: [(String, String, String, CGFloat)] = [
            ("Eye separation", "eye", "Adjustable", 0.64),
            ("Screen distance", "rectangle.inset.filled.and.person.filled", "Adjustable", 0.56),
            ("Motion smoothing", "waveform.path", "Sensitivity", 0.7)
        ]
        let rowHeight = rect.height / 3
        for (index, row) in rows.enumerated() {
            let y = rect.minY + CGFloat(index) * rowHeight
            if index > 0 {
                line(CGPoint(x: rect.minX + 12 * scale, y: y), CGPoint(x: rect.maxX - 12 * scale, y: y), color: UIColor.white.withAlphaComponent(0.08), width: scale)
            }
            drawIcon(row.1, color: palette.accent, pointSize: 16 * scale, in: CGRect(x: rect.minX + 11 * scale, y: y + 7 * scale, width: 26 * scale, height: 26 * scale))
            drawText(row.0, in: CGRect(x: rect.minX + 46 * scale, y: y + 1 * scale, width: rect.width * 0.45, height: 21 * scale), size: 11 * scale, weight: .semibold, color: white)
            drawText(row.2, in: CGRect(x: rect.maxX - 92 * scale, y: y + 1 * scale, width: 80 * scale, height: 21 * scale), size: 9.5 * scale, weight: .medium, color: secondary)
            let track = CGRect(x: rect.minX + 46 * scale, y: y + rowHeight * 0.57, width: rect.width - 66 * scale, height: 5 * scale)
            panel(track, scale: scale, radius: 2.5, fill: UIColor.white.withAlphaComponent(0.13))
            panel(CGRect(x: track.minX, y: track.minY, width: track.width * row.3, height: track.height), scale: scale, radius: 2.5, fill: palette.accent.withAlphaComponent(0.8))
            palette.accent.setFill()
            UIGraphicsGetCurrentContext()?.fillEllipse(in: CGRect(x: track.minX + track.width * row.3 - 7 * scale, y: track.midY - 7 * scale, width: 14 * scale, height: 14 * scale))
        }
    }

    private static func drawEnvironments(in rect: CGRect, scale: CGFloat, palette: Palette) {
        let names = ["Light Studio", "Midnight Grid", "Aurora Field", "Panorama"]
        let symbols = ["circle.lefthalf.filled", "moon.stars", "sparkles", "pano"]
        let gap = 9 * scale
        let width = (rect.width - gap) / 2
        let height = (rect.height - gap) / 2
        for index in 0..<4 {
            let column = index % 2
            let row = index / 2
            let tile = CGRect(x: rect.minX + CGFloat(column) * (width + gap), y: rect.minY + CGFloat(row) * (height + gap), width: width, height: height)
            let context = UIGraphicsGetCurrentContext()
            context?.saveGState()
            roundedRect(tile, radius: 11 * scale).addClip()
            let tops: [UIColor] = [
                UIColor(red: 0.33, green: 0.42, blue: 0.56, alpha: 1),
                UIColor(red: 0.035, green: 0.055, blue: 0.12, alpha: 1),
                UIColor(red: 0.04, green: 0.25, blue: 0.26, alpha: 1),
                UIColor(red: 0.12, green: 0.16, blue: 0.23, alpha: 1)
            ]
            let bottoms: [UIColor] = [
                UIColor(red: 0.055, green: 0.08, blue: 0.14, alpha: 1),
                UIColor(red: 0.008, green: 0.012, blue: 0.035, alpha: 1),
                UIColor(red: 0.015, green: 0.055, blue: 0.08, alpha: 1),
                UIColor(red: 0.008, green: 0.02, blue: 0.045, alpha: 1)
            ]
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [tops[index].cgColor, bottoms[index].cgColor] as CFArray, locations: [0, 1]) {
                context?.drawLinearGradient(gradient, start: tile.origin, end: CGPoint(x: tile.midX, y: tile.maxY), options: [])
            }
            if index == 1 {
                UIColor(red: 0.2, green: 0.28, blue: 0.5, alpha: 0.2).setStroke()
                for grid in 0..<5 {
                    let path = UIBezierPath()
                    path.move(to: CGPoint(x: tile.midX, y: tile.minY + tile.height * 0.35))
                    path.addLine(to: CGPoint(x: tile.minX + CGFloat(grid) * tile.width / 4, y: tile.maxY))
                    path.stroke()
                    path.lineWidth = 0.6 * scale
                }
            } else if index == 2 {
                for star in 0..<16 {
                    let x = tile.minX + CGFloat(12 + (star * 37 % 100)) * scale
                    let y = tile.minY + CGFloat(10 + (star * 29 % 70)) * scale
                    palette.accent.withAlphaComponent(0.25 + Double(star % 4) * 0.15).setFill()
                    context?.fillEllipse(in: CGRect(x: x, y: y, width: 1.8 * scale, height: 1.8 * scale))
                }
            }
            UIColor.black.withAlphaComponent(0.3).setFill()
            context?.fill(CGRect(x: tile.minX, y: tile.maxY - 31 * scale, width: tile.width, height: 31 * scale))
            context?.restoreGState()
            drawIcon(symbols[index], color: white.withAlphaComponent(0.82), pointSize: 15 * scale, in: CGRect(x: tile.minX + 10 * scale, y: tile.minY + 10 * scale, width: 24 * scale, height: 24 * scale))
            drawText(names[index], in: CGRect(x: tile.minX + 12 * scale, y: tile.maxY - 29 * scale, width: tile.width - 24 * scale, height: 25 * scale), size: 10.5 * scale, weight: .semibold, color: white)
            stroke(roundedRect(tile, radius: 11 * scale), color: UIColor.white.withAlphaComponent(0.15), lineWidth: scale)
        }
    }

    private static func drawWindows(in rect: CGRect, scale: CGFloat, palette: Palette) {
        let names = ["Browser", "Photos", "3D Scanner"]
        let symbols = ["safari", "photo.on.rectangle", "arkit"]
        let cardWidth = rect.width * 0.51
        let cardHeight = rect.height * 0.59
        for index in 0..<3 {
            let offset = CGFloat(index) * 16 * scale
            let card = CGRect(x: rect.minX + 22 * scale + offset, y: rect.minY + 9 * scale + offset, width: cardWidth, height: cardHeight)
            let path = roundedRect(card, radius: 12 * scale)
            UIColor(red: 0.035, green: 0.07, blue: 0.11, alpha: 0.86 + Double(index) * 0.04).setFill()
            path.fill()
            stroke(path, color: palette.accent.withAlphaComponent(0.12 + Double(index) * 0.08), lineWidth: scale)
            for dot in 0..<3 {
                palette.accent.withAlphaComponent(0.3).setFill()
                UIGraphicsGetCurrentContext()?.fillEllipse(in: CGRect(x: card.minX + (11 + CGFloat(dot) * 8) * scale, y: card.minY + 11 * scale, width: 3.5 * scale, height: 3.5 * scale))
            }
            drawIcon(symbols[index], color: palette.accent.withAlphaComponent(0.75), pointSize: 22 * scale, in: CGRect(x: card.midX - 18 * scale, y: card.midY - 28 * scale, width: 36 * scale, height: 36 * scale))
            drawCenteredText(names[index], in: CGRect(x: card.minX + 10 * scale, y: card.midY + 10 * scale, width: card.width - 20 * scale, height: 20 * scale), size: 10.5 * scale, weight: .semibold, color: white.withAlphaComponent(0.78))
        }
        let summary = CGRect(x: rect.maxX - 156 * scale, y: rect.minY + 34 * scale, width: 136 * scale, height: rect.height - 55 * scale)
        panel(summary, scale: scale, radius: 12, fill: UIColor.black.withAlphaComponent(0.16))
        drawText("Window stack", in: CGRect(x: summary.minX + 13 * scale, y: summary.minY + 8 * scale, width: summary.width - 26 * scale, height: 22 * scale), size: 12 * scale, weight: .semibold, color: white)
        drawText("Shared scene", in: CGRect(x: summary.minX + 13 * scale, y: summary.minY + 31 * scale, width: summary.width - 26 * scale, height: 18 * scale), size: 9.5 * scale, weight: .medium, color: secondary)
        for index in 0..<3 {
            let y = summary.minY + (60 + CGFloat(index) * 25) * scale
            panel(CGRect(x: summary.minX + 13 * scale, y: y, width: summary.width - 26 * scale, height: 18 * scale), scale: scale, radius: 6, fill: palette.accent.withAlphaComponent(0.05 + Double(index) * 0.025))
            drawText(names[index], in: CGRect(x: summary.minX + 22 * scale, y: y, width: summary.width - 44 * scale, height: 18 * scale), size: 8.5 * scale, weight: .medium, color: secondary)
            drawText(String(index + 1), in: CGRect(x: summary.maxX - 33 * scale, y: y, width: 14 * scale, height: 18 * scale), size: 8 * scale, weight: .semibold, color: tertiary)
        }
    }
}
