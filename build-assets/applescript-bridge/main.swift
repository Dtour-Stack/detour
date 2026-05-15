/*
 * DetourBridge — a faceless companion app that gives Detour a real
 * AppleScript surface.
 *
 * Why this exists:
 *   Electrobun's launcher has no NSScriptCommand bridge. macOS only
 *   dispatches AppleScript events to apps that register at the Cocoa
 *   level via NSScriptCommand subclasses + an sdef in Info.plist. We
 *   can't extend Electrobun's launcher without forking it, so the
 *   pragmatic path is to ship a tiny Swift app bundle that DOES have
 *   the scripting surface and forwards every command to the real
 *   Detour.app via the `detour://` URL scheme.
 *
 *   Users type `tell application "Detour Bridge" to ask agent "..."`
 *   instead of `tell application "Detour" to ...`. Functionally
 *   identical to using the URL scheme directly, but discoverable via
 *   Script Editor's library and cleanly typed.
 *
 * Architecture:
 *   - LSUIElement = YES → no Dock icon, no menu bar presence, runs
 *     faceless. macOS auto-launches us when an AppleScript event
 *     arrives.
 *   - Six NSScriptCommand subclasses, one per sdef command.
 *   - Each command percent-encodes its parameters and opens the
 *     corresponding `detour://` URL via NSWorkspace.
 *   - On idle, the process exits after EXIT_AFTER_IDLE_SECONDS so we
 *     don't leak a Swift process forever. macOS relaunches us on the
 *     next event.
 */

import Cocoa

private let EXIT_AFTER_IDLE_SECONDS: TimeInterval = 60

// MARK: - URL forwarding

private func openDetourURL(_ url: String) -> Bool {
    guard let u = URL(string: url) else {
        return false
    }
    return NSWorkspace.shared.open(u)
}

private func percentEncode(_ value: String) -> String {
    return value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
}

// MARK: - Idle timer

/// Schedules a one-shot timer that kills the process after a period
/// of inactivity. Reset on every command so a burst of AppleScript
/// calls keeps the bridge warm without restarting.
private final class IdleTimer {
    static let shared = IdleTimer()
    private var timer: Timer?

    func bump() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(
            withTimeInterval: EXIT_AFTER_IDLE_SECONDS,
            repeats: false
        ) { _ in
            NSLog("[DetourBridge] idle timeout — exiting")
            exit(0)
        }
        // Run on the main RunLoop in .common so AppleScript events
        // don't interleave with the timer in a bad way.
        if let t = timer {
            RunLoop.main.add(t, forMode: .common)
        }
    }
}

// MARK: - Command base

/// Shared base for our scripting commands. Pulls the direct parameter
/// (the first string positional, e.g. `ask agent "hi"` → "hi") and
/// any optional named parameters from `evaluatedArguments`. Internal
/// access — its @objc subclasses must be at least internal so the
/// Objective-C runtime can find them by name.
class DetourBaseCommand: NSScriptCommand {
    func directString() -> String {
        if let s = directParameter as? String {
            return s
        }
        return ""
    }

    func namedString(_ key: String) -> String? {
        guard let args = evaluatedArguments else { return nil }
        if let raw = args[key] as? String, !raw.isEmpty {
            return raw
        }
        return nil
    }

    /// All commands bump the idle timer on entry so the process
    /// stays alive through bursts of AppleScript invocations.
    func bumpIdle() {
        IdleTimer.shared.bump()
    }
}

// MARK: - Concrete commands

@objc(AskAgentCommand)
final class AskAgentCommand: DetourBaseCommand {
    override func performDefaultImplementation() -> Any? {
        bumpIdle()
        let prompt = directString()
        guard !prompt.isEmpty else {
            scriptErrorNumber = -1715  // errAEDescNotFound
            scriptErrorString = "ask agent requires a prompt string"
            return false
        }
        let ok = openDetourURL("detour://chat?text=\(percentEncode(prompt))&submit=1")
        return ok
    }
}

@objc(DraftPromptCommand)
final class DraftPromptCommand: DetourBaseCommand {
    override func performDefaultImplementation() -> Any? {
        bumpIdle()
        let prompt = directString()
        guard !prompt.isEmpty else {
            scriptErrorNumber = -1715
            scriptErrorString = "draft prompt requires a string"
            return false
        }
        return openDetourURL("detour://chat?text=\(percentEncode(prompt))")
    }
}

@objc(SearchMemoryCommand)
final class SearchMemoryCommand: DetourBaseCommand {
    override func performDefaultImplementation() -> Any? {
        bumpIdle()
        let query = directString()
        guard !query.isEmpty else {
            scriptErrorNumber = -1715
            scriptErrorString = "search memory requires a query string"
            return false
        }
        return openDetourURL("detour://pensieve/search?q=\(percentEncode(query))")
    }
}

@objc(OpenWindowCommand)
final class OpenWindowCommand: DetourBaseCommand {
    override func performDefaultImplementation() -> Any? {
        bumpIdle()
        let target = directString()
        let validTargets: Set<String> = [
            "chat", "settings", "pensieve", "activity", "browser",
            "agents", "pet", "gallery", "portless", "workspace",
            "command-palette",
        ]
        guard validTargets.contains(target) else {
            scriptErrorNumber = -1715
            scriptErrorString = "open window: unknown target '\(target)'"
            return false
        }
        return openDetourURL("detour://window?target=\(percentEncode(target))")
    }
}

@objc(OpenSettingCommand)
final class OpenSettingCommand: DetourBaseCommand {
    override func performDefaultImplementation() -> Any? {
        bumpIdle()
        let tab = directString()
        guard !tab.isEmpty else {
            scriptErrorNumber = -1715
            scriptErrorString = "open setting requires a tab path"
            return false
        }
        return openDetourURL("detour://settings?tab=\(percentEncode(tab))")
    }
}

@objc(RunActionCommand)
final class RunActionCommand: DetourBaseCommand {
    override func performDefaultImplementation() -> Any? {
        bumpIdle()
        let name = directString()
        guard !name.isEmpty else {
            scriptErrorNumber = -1715
            scriptErrorString = "run action requires an action name"
            return false
        }
        var url = "detour://action?name=\(percentEncode(name))"
        if let args = evaluatedArguments?["parm"] as? [String: Any] {
            for (k, v) in args {
                let encodedK = percentEncode(k)
                let encodedV = percentEncode(String(describing: v))
                url += "&\(encodedK)=\(encodedV)"
            }
        }
        return openDetourURL(url)
    }
}

@objc(PingCommand)
final class PingCommand: DetourBaseCommand {
    override func performDefaultImplementation() -> Any? {
        bumpIdle()
        NSLog("[DetourBridge] ping")
        return true
    }
}

// MARK: - App boot

/// AppDelegate just keeps the RunLoop alive long enough to receive
/// AppleScript events. No windows, no menus.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_: Notification) {
        NSLog("[DetourBridge] ready (pid=\(getpid()))")
        IdleTimer.shared.bump()
    }
}

let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
