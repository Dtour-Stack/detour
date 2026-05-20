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
        // Inherit parent env, then layer ~/.detour/.env on top so the
        // user's local config (DETOUR_EVAL_TOKEN, provider keys, …)
        // reaches bun even when the app is launched from Finder (no
        // shell, no automatic .env merge).
        var env = ProcessInfo.processInfo.environment
        let dotEnv = NSString(string: "~/.detour/.env").expandingTildeInPath
        if let text = try? String(contentsOfFile: dotEnv, encoding: .utf8) {
            for line in text.split(separator: "\n") {
                let t = line.trimmingCharacters(in: .whitespaces)
                if t.isEmpty || t.hasPrefix("#") { continue }
                guard let eq = t.firstIndex(of: "=") else { continue }
                let key = String(t[..<eq]).trimmingCharacters(in: .whitespaces)
                var val = String(t[t.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
                if (val.hasPrefix("\"") && val.hasSuffix("\"")) || (val.hasPrefix("'") && val.hasSuffix("'")) {
                    val = String(val.dropFirst().dropLast())
                }
                if env[key] == nil { env[key] = val }
            }
        }
        p.environment = env
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
        // Bundled location: Swiftun.app/Contents/MacOS/bun. This is
        // where build-swiftun-app.ts drops the Electrobun-staged bun
        // binary, mirroring Electrobun's own launcher layout.
        let macosBun = Bundle.main.bundleURL
            .appendingPathComponent("Contents")
            .appendingPathComponent("MacOS")
            .appendingPathComponent("bun")
        if FileManager.default.isExecutableFile(atPath: macosBun.path) {
            return macosBun.path
        }
        // Legacy fallback in case packaging moves to Resources/bin/.
        let resourcesBinBun = Bundle.main.bundleURL
            .appendingPathComponent("Contents")
            .appendingPathComponent("Resources")
            .appendingPathComponent("bin")
            .appendingPathComponent("bun")
        if FileManager.default.isExecutableFile(atPath: resourcesBinBun.path) {
            return resourcesBinBun.path
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
