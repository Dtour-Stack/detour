/*
 * AppleScriptCommands — NSScriptCommand subclasses ported from
 * build-assets/applescript-bridge/main.swift. Compiled into Swiftun's
 * binary so AppleScript dispatch lands in-process. Resources/Detour.sdef
 * + Info.plist (NSAppleScriptEnabled + OSAScriptingDefinition) make the
 * runtime expose these to Script Editor.
 *
 * Each command percent-encodes its arguments and opens the corresponding
 * `detour://` URL — the in-process url-scheme handler picks it back up.
 * (Keeps a single dispatch path: AppleScript, Shortcuts, raw `open`
 * commands all hit the same router.)
 */

import Cocoa

/// AppleScript-side detour:// dispatch. Same rationale as TrayController:
/// POST to the in-process dispatcher first so the URL is handled by THIS
/// bun instance, falling back to NSWorkspace if the endpoint isn't up yet.
/// Returns true if the dispatch was initiated — AppleScript callers
/// treat this as a success indicator, not a guarantee of completion.
private func openDetourURL(_ url: String) -> Bool {
    guard let _ = URL(string: url) else { return false }
    let dispatchURL = URL(string: "http://127.0.0.1:2138/api/url-scheme/dispatch")!
    var req = URLRequest(url: dispatchURL, timeoutInterval: 3.0)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["url": url])
    // Synchronous-ish: AppleScript wants a return value on this call.
    // Use a semaphore so the script gets a real answer for small calls.
    let sema = DispatchSemaphore(value: 0)
    var ok = false
    let task = URLSession.shared.dataTask(with: req) { _, response, _ in
        if let http = response as? HTTPURLResponse, http.statusCode == 200 {
            ok = true
        }
        sema.signal()
    }
    task.resume()
    _ = sema.wait(timeout: .now() + 4.0)
    if !ok, let u = URL(string: url) {
        return NSWorkspace.shared.open(u)
    }
    return ok
}

private func percentEncode(_ value: String) -> String {
    return value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
}

class DetourBaseCommand: NSScriptCommand {
    func directString() -> String {
        if let s = directParameter as? String { return s }
        return ""
    }
    func namedString(_ key: String) -> String? {
        guard let args = evaluatedArguments else { return nil }
        if let raw = args[key] as? String, !raw.isEmpty { return raw }
        return nil
    }
}

@objc(AskAgentCommand)
final class AskAgentCommand: DetourBaseCommand {
    override func performDefaultImplementation() -> Any? {
        let prompt = directString()
        guard !prompt.isEmpty else {
            scriptErrorNumber = -1715
            scriptErrorString = "ask agent requires a prompt string"
            return false
        }
        return openDetourURL("detour://chat?text=\(percentEncode(prompt))&submit=1")
    }
}

@objc(DraftPromptCommand)
final class DraftPromptCommand: DetourBaseCommand {
    override func performDefaultImplementation() -> Any? {
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
        let target = directString()
        // In-process window open via WindowFactory. Must hop to MainActor
        // since WindowFactory touches AppKit.
        let recognized = DispatchQueue.main.sync {
            MainActor.assumeIsolated { WindowFactory.shared.open(target: target) }
        }
        if !recognized {
            scriptErrorNumber = -1715
            scriptErrorString = "open window: unknown target '\(target)'"
            return false
        }
        return true
    }
}

@objc(OpenSettingCommand)
final class OpenSettingCommand: DetourBaseCommand {
    override func performDefaultImplementation() -> Any? {
        let tab = directString()
        guard !tab.isEmpty else {
            scriptErrorNumber = -1715
            scriptErrorString = "open setting requires a tab path"
            return false
        }
        DispatchQueue.main.sync {
            MainActor.assumeIsolated { WindowFactory.shared.openSettings(tab: tab) }
        }
        return true
    }
}

@objc(RunActionCommand)
final class RunActionCommand: DetourBaseCommand {
    override func performDefaultImplementation() -> Any? {
        let name = directString()
        guard !name.isEmpty else {
            scriptErrorNumber = -1715
            scriptErrorString = "run action requires an action name"
            return false
        }
        var url = "detour://action?name=\(percentEncode(name))"
        if let args = evaluatedArguments?["parm"] as? [String: Any] {
            for (k, v) in args {
                url += "&\(percentEncode(k))=\(percentEncode(String(describing: v)))"
            }
        }
        return openDetourURL(url)
    }
}

@objc(PingCommand)
final class PingCommand: DetourBaseCommand {
    override func performDefaultImplementation() -> Any? {
        NSLog("[Swiftun] AppleScript ping")
        return true
    }
}
