import AppKit
import Foundation

let iconset = URL(fileURLWithPath: CommandLine.arguments[1])
let statusIcon = CommandLine.arguments.count > 2 ? URL(fileURLWithPath: CommandLine.arguments[2]) : nil
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

struct IconStyle {
    let size: CGFloat
    var cyan: NSColor { NSColor(calibratedRed: 0.28, green: 0.95, blue: 0.96, alpha: 1) }
    var blue: NSColor { NSColor(calibratedRed: 0.15, green: 0.49, blue: 0.98, alpha: 1) }
    var glow: NSColor { NSColor(calibratedRed: 0.10, green: 0.80, blue: 1.00, alpha: 0.28) }
    var dark: NSColor { NSColor(calibratedRed: 0.08, green: 0.11, blue: 0.13, alpha: 1) }
}

func savePng(_ image: NSImage, to url: URL) throws {
    guard let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "LocalBrainIcon", code: 1)
    }
    try png.write(to: url)
}

func drawStroked(_ path: NSBezierPath, color: NSColor, width: CGFloat) {
    color.setStroke()
    path.lineWidth = width
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    path.stroke()
}

func roundedSquare(_ rect: NSRect, radius: CGFloat) -> NSBezierPath {
    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
}

func brainPath(_ size: CGFloat) -> NSBezierPath {
    let p = NSBezierPath()
    p.move(to: NSPoint(x: 0.27 * size, y: 0.45 * size))
    p.curve(to: NSPoint(x: 0.34 * size, y: 0.61 * size), controlPoint1: NSPoint(x: 0.24 * size, y: 0.52 * size), controlPoint2: NSPoint(x: 0.27 * size, y: 0.60 * size))
    p.curve(to: NSPoint(x: 0.46 * size, y: 0.68 * size), controlPoint1: NSPoint(x: 0.34 * size, y: 0.68 * size), controlPoint2: NSPoint(x: 0.42 * size, y: 0.69 * size))
    p.curve(to: NSPoint(x: 0.53 * size, y: 0.66 * size), controlPoint1: NSPoint(x: 0.48 * size, y: 0.73 * size), controlPoint2: NSPoint(x: 0.52 * size, y: 0.72 * size))
    p.curve(to: NSPoint(x: 0.71 * size, y: 0.54 * size), controlPoint1: NSPoint(x: 0.63 * size, y: 0.68 * size), controlPoint2: NSPoint(x: 0.72 * size, y: 0.62 * size))
    p.curve(to: NSPoint(x: 0.63 * size, y: 0.43 * size), controlPoint1: NSPoint(x: 0.77 * size, y: 0.53 * size), controlPoint2: NSPoint(x: 0.78 * size, y: 0.43 * size))
    p.curve(to: NSPoint(x: 0.57 * size, y: 0.30 * size), controlPoint1: NSPoint(x: 0.62 * size, y: 0.36 * size), controlPoint2: NSPoint(x: 0.58 * size, y: 0.35 * size))
    p.curve(to: NSPoint(x: 0.43 * size, y: 0.27 * size), controlPoint1: NSPoint(x: 0.52 * size, y: 0.25 * size), controlPoint2: NSPoint(x: 0.46 * size, y: 0.24 * size))
    p.curve(to: NSPoint(x: 0.31 * size, y: 0.35 * size), controlPoint1: NSPoint(x: 0.34 * size, y: 0.25 * size), controlPoint2: NSPoint(x: 0.28 * size, y: 0.29 * size))
    p.curve(to: NSPoint(x: 0.27 * size, y: 0.45 * size), controlPoint1: NSPoint(x: 0.24 * size, y: 0.34 * size), controlPoint2: NSPoint(x: 0.23 * size, y: 0.43 * size))
    return p
}

func headPath(_ size: CGFloat) -> NSBezierPath {
    let p = NSBezierPath()
    p.move(to: NSPoint(x: 0.64 * size, y: 0.25 * size))
    p.curve(to: NSPoint(x: 0.67 * size, y: 0.33 * size), controlPoint1: NSPoint(x: 0.65 * size, y: 0.29 * size), controlPoint2: NSPoint(x: 0.65 * size, y: 0.32 * size))
    p.curve(to: NSPoint(x: 0.77 * size, y: 0.34 * size), controlPoint1: NSPoint(x: 0.72 * size, y: 0.34 * size), controlPoint2: NSPoint(x: 0.76 * size, y: 0.32 * size))
    p.curve(to: NSPoint(x: 0.80 * size, y: 0.43 * size), controlPoint1: NSPoint(x: 0.79 * size, y: 0.37 * size), controlPoint2: NSPoint(x: 0.79 * size, y: 0.41 * size))
    p.curve(to: NSPoint(x: 0.76 * size, y: 0.55 * size), controlPoint1: NSPoint(x: 0.75 * size, y: 0.47 * size), controlPoint2: NSPoint(x: 0.76 * size, y: 0.52 * size))
    p.curve(to: NSPoint(x: 0.70 * size, y: 0.61 * size), controlPoint1: NSPoint(x: 0.75 * size, y: 0.59 * size), controlPoint2: NSPoint(x: 0.73 * size, y: 0.61 * size))
    return p
}

func drawCircuits(size: CGFloat, style: IconStyle, compact: Bool) {
    let lines: [[CGPoint]] = [
        [CGPoint(x: 0.34, y: 0.50), CGPoint(x: 0.43, y: 0.42), CGPoint(x: 0.54, y: 0.42), CGPoint(x: 0.64, y: 0.50)],
        [CGPoint(x: 0.36, y: 0.57), CGPoint(x: 0.43, y: 0.57), CGPoint(x: 0.43, y: 0.64)],
        [CGPoint(x: 0.58, y: 0.58), CGPoint(x: 0.64, y: 0.58), CGPoint(x: 0.68, y: 0.63)],
        [CGPoint(x: 0.36, y: 0.35), CGPoint(x: 0.45, y: 0.35), CGPoint(x: 0.45, y: 0.28)],
        [CGPoint(x: 0.52, y: 0.30), CGPoint(x: 0.52, y: 0.22)],
        [CGPoint(x: 0.58, y: 0.31), CGPoint(x: 0.58, y: 0.23)]
    ]
    for item in lines {
        let p = NSBezierPath()
        p.move(to: NSPoint(x: item[0].x * size, y: item[0].y * size))
        for point in item.dropFirst() {
            p.line(to: NSPoint(x: point.x * size, y: point.y * size))
        }
        drawStroked(p, color: style.cyan.withAlphaComponent(0.88), width: compact ? size * 0.035 : size * 0.018)
    }

    if compact { return }

    let nodes: [CGPoint] = [
        CGPoint(x: 0.34, y: 0.50), CGPoint(x: 0.43, y: 0.42), CGPoint(x: 0.54, y: 0.42), CGPoint(x: 0.64, y: 0.50),
        CGPoint(x: 0.43, y: 0.64), CGPoint(x: 0.68, y: 0.63), CGPoint(x: 0.45, y: 0.28), CGPoint(x: 0.52, y: 0.22), CGPoint(x: 0.58, y: 0.23)
    ]
    for node in nodes {
        let r = size * 0.018
        let rect = NSRect(x: node.x * size - r, y: node.y * size - r, width: r * 2, height: r * 2)
        style.cyan.setFill()
        NSBezierPath(ovalIn: rect).fill()
    }
}

func drawA(size: CGFloat, style: IconStyle, compact: Bool) {
    let p = NSBezierPath()
    p.move(to: NSPoint(x: 0.39 * size, y: 0.33 * size))
    p.line(to: NSPoint(x: 0.50 * size, y: 0.58 * size))
    p.line(to: NSPoint(x: 0.61 * size, y: 0.33 * size))
    drawStroked(p, color: style.blue, width: compact ? size * 0.11 : size * 0.07)

    let cross = NSBezierPath()
    cross.move(to: NSPoint(x: 0.45 * size, y: 0.42 * size))
    cross.line(to: NSPoint(x: 0.56 * size, y: 0.42 * size))
    drawStroked(cross, color: style.blue, width: compact ? size * 0.085 : size * 0.055)

    let light = NSBezierPath()
    light.move(to: NSPoint(x: 0.39 * size, y: 0.33 * size))
    light.line(to: NSPoint(x: 0.50 * size, y: 0.58 * size))
    light.line(to: NSPoint(x: 0.61 * size, y: 0.33 * size))
    light.move(to: NSPoint(x: 0.45 * size, y: 0.42 * size))
    light.line(to: NSPoint(x: 0.56 * size, y: 0.42 * size))
    drawStroked(light, color: NSColor.white.withAlphaComponent(0.86), width: compact ? size * 0.030 : size * 0.018)
}

func writeIcon(size: Int, name: String, transparent: Bool = false, compact: Bool = false) throws {
    let side = CGFloat(size)
    let style = IconStyle(size: side)
    let image = NSImage(size: NSSize(width: side, height: side))
    image.lockFocus()

    if !transparent {
        let rect = NSRect(x: 0, y: 0, width: side, height: side)
        style.dark.setFill()
        roundedSquare(rect.insetBy(dx: side * 0.10, dy: side * 0.10), radius: side * 0.18).fill()

        style.glow.setStroke()
        let glow = roundedSquare(rect.insetBy(dx: side * 0.10, dy: side * 0.10), radius: side * 0.18)
        glow.lineWidth = side * 0.075
        glow.stroke()

        let border = roundedSquare(rect.insetBy(dx: side * 0.14, dy: side * 0.14), radius: side * 0.16)
        drawStroked(border, color: style.cyan, width: side * 0.025)
    }

    let brain = brainPath(side)
    drawStroked(brain, color: style.glow, width: compact ? side * 0.13 : side * 0.08)
    drawStroked(brain, color: style.cyan, width: compact ? side * 0.055 : side * 0.026)

    let head = headPath(side)
    drawStroked(head, color: style.glow, width: compact ? side * 0.13 : side * 0.08)
    drawStroked(head, color: style.cyan, width: compact ? side * 0.055 : side * 0.026)

    drawCircuits(size: side, style: style, compact: compact)
    drawA(size: side, style: style, compact: compact)

    image.unlockFocus()
    try savePng(image, to: transparent ? URL(fileURLWithPath: name) : iconset.appendingPathComponent(name))
}

let icons: [(Int, String)] = [
    (16, "icon_16x16.png"),
    (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"),
    (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"),
    (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"),
    (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"),
    (1024, "icon_512x512@2x.png")
]

for icon in icons {
    try writeIcon(size: icon.0, name: icon.1)
}

if let statusIcon {
    try writeIcon(size: 72, name: statusIcon.path, transparent: true, compact: true)
}
