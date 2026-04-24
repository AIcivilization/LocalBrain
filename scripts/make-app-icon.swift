import AppKit
import Foundation

let output = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

func writeIcon(size: Int, name: String) throws {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()

    let rect = NSRect(x: 0, y: 0, width: size, height: size)
    NSColor(calibratedRed: 0.07, green: 0.11, blue: 0.18, alpha: 1).setFill()
    NSBezierPath(roundedRect: rect, xRadius: CGFloat(size) * 0.22, yRadius: CGFloat(size) * 0.22).fill()

    NSColor(calibratedRed: 0.17, green: 0.74, blue: 0.92, alpha: 1).setStroke()
    let lineWidth = max(2.0, CGFloat(size) * 0.055)
    let path = NSBezierPath()
    path.lineWidth = lineWidth
    path.lineCapStyle = .round
    path.lineJoinStyle = .round

    let pad = CGFloat(size) * 0.24
    let mid = CGFloat(size) * 0.50
    path.move(to: NSPoint(x: pad, y: mid))
    path.curve(to: NSPoint(x: mid, y: CGFloat(size) - pad), controlPoint1: NSPoint(x: pad, y: CGFloat(size) * 0.74), controlPoint2: NSPoint(x: mid * 0.72, y: CGFloat(size) - pad))
    path.curve(to: NSPoint(x: CGFloat(size) - pad, y: mid), controlPoint1: NSPoint(x: CGFloat(size) * 0.72, y: CGFloat(size) - pad), controlPoint2: NSPoint(x: CGFloat(size) - pad, y: CGFloat(size) * 0.74))
    path.curve(to: NSPoint(x: mid, y: pad), controlPoint1: NSPoint(x: CGFloat(size) - pad, y: CGFloat(size) * 0.28), controlPoint2: NSPoint(x: CGFloat(size) * 0.72, y: pad))
    path.curve(to: NSPoint(x: pad, y: mid), controlPoint1: NSPoint(x: mid * 0.72, y: pad), controlPoint2: NSPoint(x: pad, y: CGFloat(size) * 0.28))
    path.stroke()

    NSColor.white.setFill()
    let font = NSFont.systemFont(ofSize: CGFloat(size) * 0.28, weight: .bold)
    let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
    let text = "LB" as NSString
    let textSize = text.size(withAttributes: attrs)
    text.draw(at: NSPoint(x: (CGFloat(size) - textSize.width) / 2, y: (CGFloat(size) - textSize.height) / 2), withAttributes: attrs)

    image.unlockFocus()

    guard let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "LocalBrainIcon", code: 1)
    }
    try png.write(to: output.appendingPathComponent(name))
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
