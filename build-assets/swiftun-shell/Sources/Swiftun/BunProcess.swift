/*
 * BunProcess — wraps spawning + lifecycle of the Bun child process
 * that runs Detour's agent core. Today Electrobun's launcher does
 * this for us; Swiftun owns it directly.
 *
 * Bun binary lookup order:
 *   1. DETOUR_BUN_PATH env var (explicit override)
 *   2. <Detour.app>/Contents/Resources/bin/bun (packaged location)
 *   3. `bun` on PATH (dev / Homebrew install)
 *
 * The Bun entry script is whatever the build pipeline drops at
 * Contents/Resources/app/bun/index.js — same convention Electrobun
 * uses today, so the existing bun/index.ts surface ports without
 * changes.
 */

import Foundation

final class BunProcess {
    private var process: Process?

    func start() throws {
        let binary = try locateBunBinary()
        let entry = try locateBunEntry()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: binary)
        p.arguments = ["run", entry]
        p.environment = ProcessInfo.processInfo.environment
        // Bun must be detached from stdin or it'll exit immediately
        // when the parent's stdin closes during launchd-style launches.
        p.standardInput = FileHandle.nullDevice
        // Inherit stdout/stderr so the dev can `tail -f` the logs of
        // Detour.app from Console.app. Bun's own pretty logger handles
        // formatting.
        try p.run()
        process = p
        NSLog("[Swiftun] Bun started (pid=\(p.processIdentifier))")
    }

    func stop() {
        guard let p = process, p.isRunning else { return }
        NSLog("[Swiftun] terminating Bun (pid=\(p.processIdentifier))")
        // SIGTERM first; Bun runs the `before-quit` cleanup hooks and
        // exits gracefully. If that doesn't happen in 5s, escalate.
        p.terminate()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            p.waitUntilExit()
            group.leave()
        }
        let result = group.wait(timeout: .now() + 5)
        if result == .timedOut, p.isRunning {
            NSLog("[Swiftun] Bun didn't exit on SIGTERM, sending SIGKILL")
            kill(p.processIdentifier, SIGKILL)
        }
        process = nil
    }

    // MARK: - Lookup

    private func locateBunBinary() throws -> String {
        if let env = ProcessInfo.processInfo.environment["DETOUR_BUN_PATH"], !env.isEmpty {
            if FileManager.default.isExecutableFile(atPath: env) {
                return env
            }
        }
        // Bundled location: Detour.app/Contents/Resources/bin/bun.
        // For the scaffold we look upward from the current executable.
        let appBundleBun = Bundle.main.bundleURL
            .appendingPathComponent("Contents")
            .appendingPathComponent("Resources")
            .appendingPathComponent("bin")
            .appendingPathComponent("bun")
        if FileManager.default.isExecutableFile(atPath: appBundleBun.path) {
            return appBundleBun.path
        }
        // Fall back to whatever's on PATH.
        let paths = ProcessInfo.processInfo.environment["PATH"]?.split(separator: ":") ?? []
        for p in paths {
            let candidate = "\(p)/bun"
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        throw NSError(domain: "Swiftun.BunProcess", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "bun binary not found (set DETOUR_BUN_PATH or install via brew)",
        ])
    }

    private func locateBunEntry() throws -> String {
        // Bundled: <App>/Contents/Resources/app/bun/index.js — matches
        // Electrobun's current copy-map output.
        let bundled = Bundle.main.bundleURL
            .appendingPathComponent("Contents")
            .appendingPathComponent("Resources")
            .appendingPathComponent("app")
            .appendingPathComponent("bun")
            .appendingPathComponent("index.js")
        if FileManager.default.fileExists(atPath: bundled.path) {
            return bundled.path
        }
        // Dev override — the project root checked-out tree.
        if let dev = ProcessInfo.processInfo.environment["DETOUR_BUN_ENTRY"], !dev.isEmpty {
            return dev
        }
        throw NSError(domain: "Swiftun.BunProcess", code: 2, userInfo: [
            NSLocalizedDescriptionKey: "Bun entry script not found at Contents/Resources/app/bun/index.js",
        ])
    }
}
