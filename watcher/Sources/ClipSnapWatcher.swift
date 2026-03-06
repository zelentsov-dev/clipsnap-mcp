import AppKit
import Foundation
import os
import Synchronization

// MARK: - Entry Point

@main
struct ClipSnapWatcher {
    private static let shouldStop = Atomic<Bool>(false)
    private static let logger = Logger(subsystem: "cc.clipsnap.watcher", category: "clipboard")

    static func main() async {
        let config = Config.parse()

        guard ensureDirectory(config.outputDir) else {
            emit(.error, ["message": "Cannot create output directory: \(config.outputDir)"])
            return
        }

        // Ignore default signal handlers, install custom ones via GCD
        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)

        let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
        sigintSource.setEventHandler { shouldStop.store(true, ordering: .releasing) }
        sigintSource.resume()

        let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
        sigtermSource.setEventHandler { shouldStop.store(true, ordering: .releasing) }
        sigtermSource.resume()

        emit(.start, [
            "dir": config.outputDir,
            "interval_ms": "\(config.intervalMs)",
            "max_files": "\(config.maxFiles)",
        ])

        let pasteboard = NSPasteboard.general
        var lastChangeCount = pasteboard.changeCount
        var totalCaptured = 0

        while !shouldStop.load(ordering: .acquiring) {
            let currentCount = pasteboard.changeCount

            if currentCount != lastChangeCount {
                lastChangeCount = currentCount

                if let pngData = readImageAsPNG(from: pasteboard) {
                    if let filename = save(pngData, to: config.outputDir) {
                        totalCaptured += 1
                        logger.info("Captured: \(filename) (\(pngData.count) bytes)")
                        emit(.capture, [
                            "file": filename,
                            "size": "\(pngData.count)",
                            "total": "\(totalCaptured)",
                        ])
                        pruneOldFiles(in: config.outputDir, keeping: config.maxFiles)
                    }
                }
                // Non-image clipboard changes are silently ignored
            }

            try? await Task.sleep(for: .milliseconds(config.intervalMs), tolerance: .milliseconds(100))
        }

        emit(.stop, ["total_captured": "\(totalCaptured)"])
        logger.info("Stopped. Total captured: \(totalCaptured)")

        // Keep signal sources alive until exit
        sigintSource.cancel()
        sigtermSource.cancel()
    }
}

// MARK: - Configuration

extension ClipSnapWatcher {
    struct Config: Sendable {
        let outputDir: String
        let intervalMs: Int
        let maxFiles: Int

        static func parse() -> Config {
            let args = CommandLine.arguments
            let home = FileManager.default.homeDirectoryForCurrentUser.path()
            return Config(
                outputDir: args.count > 1 ? args[1] : "\(home)/.clipsnap/clipboard-captures",
                intervalMs: args.count > 2 ? Int(args[2]) ?? 500 : 500,
                maxFiles: args.count > 3 ? Int(args[3]) ?? 50 : 50
            )
        }
    }
}

// MARK: - Image Capture

extension ClipSnapWatcher {
    /// Reads the current clipboard image and converts it to PNG data.
    /// Uses `canReadObject` as a cheap pre-check before allocating NSImage.
    static func readImageAsPNG(from pasteboard: NSPasteboard) -> Data? {
        guard pasteboard.canReadObject(forClasses: [NSImage.self], options: nil),
              let image = NSImage(pasteboard: pasteboard)
        else { return nil }

        guard let tiffData = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData),
              let pngData = bitmap.representation(using: .png, properties: [:])
        else { return nil }
        return pngData
    }
}

// MARK: - File Operations

extension ClipSnapWatcher {
    /// Creates directory with 0700 permissions if it doesn't exist.
    static func ensureDirectory(_ path: String) -> Bool {
        do {
            try FileManager.default.createDirectory(
                atPath: path,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            return true
        } catch {
            return false
        }
    }

    /// Saves PNG data to the output directory. Returns the filename on success.
    static func save(_ data: Data, to dir: String) -> String? {
        let timestamp = Int(Date().timeIntervalSince1970 * 1000)
        let uuid = String(UUID().uuidString.prefix(8)).lowercased()
        let filename = "clip-\(timestamp)-\(uuid).png"
        let path = "\(dir)/\(filename)"

        do {
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: path
            )
            return filename
        } catch {
            logger.error("Failed to save \(filename): \(error.localizedDescription)")
            emit(.error, ["message": "Save failed: \(error.localizedDescription)"])
            return nil
        }
    }

    /// Keeps only the newest `keeping` PNG files, deletes the rest.
    static func pruneOldFiles(in dir: String, keeping maxFiles: Int) {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(atPath: dir) else { return }

        let pngFiles = entries
            .filter { $0.hasSuffix(".png") }
            .sorted() // Filename contains timestamp — alphabetical = chronological

        guard pngFiles.count > maxFiles else { return }

        let toDelete = pngFiles.prefix(pngFiles.count - maxFiles)
        var deletedCount = 0
        for file in toDelete {
            try? fm.removeItem(atPath: "\(dir)/\(file)")
            deletedCount += 1
        }

        if deletedCount > 0 {
            emit(.cleanup, ["deleted": "\(deletedCount)", "remaining": "\(pngFiles.count - deletedCount)"])
        }
    }
}

// MARK: - Structured Logging (JSON lines to stderr)

extension ClipSnapWatcher {
    enum Event: String, Sendable {
        case start, capture, skip, cleanup, stop, error
    }

    private nonisolated(unsafe) static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func emit(_ event: Event, _ data: [String: String] = [:]) {
        var entry: [String: String] = [
            "event": event.rawValue,
            "ts": isoFormatter.string(from: Date()),
        ]
        for (k, v) in data { entry[k] = v }

        if let json = try? JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys]),
           let line = String(data: json, encoding: .utf8)
        {
            FileHandle.standardError.write(Data((line + "\n").utf8))
        }
    }
}
