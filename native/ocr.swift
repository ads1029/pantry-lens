import Foundation
import Vision
import ImageIO

struct Box: Codable { let x: Double; let y: Double; let width: Double; let height: Double }
struct Line: Codable { let text: String; let confidence: Float; let box: Box }
struct Result: Codable { let engine: String; let languages: [String]; let width: Int; let height: Int; let lines: [Line] }
do {
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "PantryOCR", code: 1, userInfo: [NSLocalizedDescriptionKey: "One local image path is required"]) }
    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    guard let imageSource = CGImageSourceCreateWithURL(url as CFURL, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int,
          width > 0, height > 0, width <= 12000, height <= 12000, width * height <= 40000000
    else { throw NSError(domain: "PantryOCR", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid image or image exceeds 40 megapixels / 12000 pixels per side"]) }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
    request.usesLanguageCorrection = true
    // Apple Vision executes on this Mac. No external provider or networking code.
    let orientation = CGImagePropertyOrientation(rawValue: (properties[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1) ?? .up
    try VNImageRequestHandler(url: url, orientation: orientation, options: [:]).perform([request])
    let lines = (request.results ?? []).compactMap { observation -> Line? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let b = observation.boundingBox
        return Line(text: candidate.string, confidence: candidate.confidence, box: Box(x: b.minX, y: b.minY, width: b.width, height: b.height))
    }.sorted { abs($0.box.y - $1.box.y) < 0.012 ? $0.box.x < $1.box.x : $0.box.y > $1.box.y }
    let output = Result(engine: "Apple Vision VNRecognizeTextRequest", languages: request.recognitionLanguages, width: width, height: height, lines: lines)
    FileHandle.standardOutput.write(try JSONEncoder().encode(output))
} catch {
    FileHandle.standardError.write(Data(("LOCAL_OCR_ERROR: " + error.localizedDescription + "\n").utf8))
    exit(1)
}
