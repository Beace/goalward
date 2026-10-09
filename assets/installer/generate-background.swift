#!/usr/bin/env swift
// Reproduce the Finder installer background on macOS:
//   swift assets/installer/generate-background.swift
// All coordinates are logical points in the Finder content area.
// Finder supplies the real app and Applications icons and their labels.

import AppKit

let canvasSize = NSSize(width: 660, height: 420)
let destination = URL(fileURLWithPath: #filePath).deletingLastPathComponent()

func color(_ hex: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255,
            green: CGFloat((hex >> 8) & 255) / 255,
            blue: CGFloat(hex & 255) / 255, alpha: 1)
}

// Finder uses black native filenames with a custom image background. A single
// neutral installation surface keeps them readable without individual labels.
let workspace = color(0xEAECE8)
let edge = color(0x141515)
let divider = color(0x2E3231)
let foreground = color(0xEAECE8)
let secondary = color(0xB1B7AE)
let muted = color(0x90998E)
let arrowColor = color(0x454B47)

func fill(_ rect: NSRect, with color: NSColor, radius: CGFloat = 0) {
    color.setFill()
    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
}

func text(_ value: String, at rect: NSRect, size: CGFloat,
          weight: NSFont.Weight = .regular, color: NSColor,
          alignment: NSTextAlignment = .center) {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = alignment
    paragraph.lineBreakMode = .byClipping
    NSAttributedString(string: value, attributes: [
        .font: NSFont.systemFont(ofSize: size, weight: weight),
        .foregroundColor: color,
        .paragraphStyle: paragraph,
    ]).draw(in: rect)
}

func render(scale: Int, name: String) throws {
    let width = Int(canvasSize.width) * scale
    let height = Int(canvasSize.height) * scale
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: width * 4, bitsPerPixel: 32
    ), let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else {
        fatalError("Unable to create the installer background bitmap")
    }
    bitmap.size = canvasSize
    NSGraphicsContext.saveGraphicsState()
    let cg = graphics.cgContext
    cg.translateBy(x: 0, y: CGFloat(height))
    cg.scaleBy(x: CGFloat(scale), y: -CGFloat(scale))
    NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)

    fill(NSRect(origin: .zero, size: canvasSize), with: workspace)
    fill(NSRect(x: 0, y: 0, width: 660, height: 116), with: edge)
    fill(NSRect(x: 0, y: 115, width: 660, height: 1), with: divider)

    text("Goalward", at: NSRect(x: 32, y: 36, width: 596, height: 30),
         size: 23, weight: .semibold, color: foreground)
    text("将 Goalward 拖到 Applications 完成安装",
         at: NSRect(x: 32, y: 78, width: 596, height: 20),
         size: 12, color: secondary)

    let arrow = NSBezierPath()
    arrow.lineWidth = 2
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    arrow.move(to: NSPoint(x: 294, y: 200))
    arrow.line(to: NSPoint(x: 366, y: 200))
    arrow.move(to: NSPoint(x: 355, y: 189))
    arrow.line(to: NSPoint(x: 366, y: 200))
    arrow.line(to: NSPoint(x: 355, y: 211))
    arrowColor.setStroke()
    arrow.stroke()

    fill(NSRect(x: 0, y: 324, width: 660, height: 96), with: edge)
    fill(NSRect(x: 32, y: 324, width: 596, height: 1), with: divider)
    text("安装后，从「应用程序」启动",
         at: NSRect(x: 32, y: 344, width: 596, height: 20),
         size: 12, color: secondary)
    text("Apple Silicon  ·  macOS 13.3 或更新版本",
         at: NSRect(x: 32, y: 375, width: 596, height: 18),
         size: 11, color: muted)

    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        fatalError("Unable to encode installer background PNG")
    }
    let output = destination.appendingPathComponent(name)
    try png.write(to: output)
    print("Created \(output.path): \(width)×\(height) px, 660×420 pt")
}

try render(scale: 1, name: "background.png")
try render(scale: 2, name: "background@2x.png")
