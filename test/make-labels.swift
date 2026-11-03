import AppKit
import Foundation
// This creates artificial labels only. It never reads any user photograph.
let output = CommandLine.arguments[1]
let width = 1800, height = 1350
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
let context = NSGraphicsContext(bitmapImageRep: bitmap)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
NSColor.white.setFill(); NSRect(x: 0, y: 0, width: width, height: height).fill()
func text(_ value: String, _ x: Int, _ y: Int, _ size: CGFloat = 45) {
    (value as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: [.font: NSFont(name: "PingFang SC", size: size) ?? NSFont.systemFont(ofSize: size), .foregroundColor: NSColor.black])
}
text("SYNTHETIC TEST LABELS / 人工生成测试标签", 65, 1240, 36)
let labels = [
    ["品名：嫩豆腐", "净含量：300克", "已开封"],
    ["Product: Rolled Oats", "Net weight: 0.5 kg", "Opened"],
    ["品名：大米", "净含量：2千克", "未开封"],
    ["Product: Yogurt", "Net wt: 125 g", "Unopened"],
    ["品名：豆乳", "净含量：250毫升", "已开封"],
    ["Product: Apple Juice", "Net contents: 330 ml", "Opened"]
]
for (index, lines) in labels.enumerated() {
    let x = 80 + (index % 2) * 870, top = 1090 - (index / 2) * 380
    NSColor(white: 0.65, alpha: 1).setStroke()
    NSBezierPath(rect: NSRect(x: x - 20, y: top - 220, width: 800, height: 310)).stroke()
    for (n, line) in lines.enumerated() { text(line, x, top - n * 72) }
}
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
print("Generated synthetic label image: " + output)
