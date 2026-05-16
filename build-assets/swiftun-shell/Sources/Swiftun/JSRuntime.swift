/*
 * JSRuntime — JavaScriptCore-backed JS runtime that lives INSIDE the
 * Swift Detour binary. The medium-term architectural target: collapse
 * the Bun child process into this in-process runtime so Detour runs as
 * one PID, with direct function calls instead of HTTP/SSE between
 * Swift UI and the agent code.
 *
 * STATUS: scaffold + working prototype. Not production. The full
 * migration off `Bun spawn` is multi-week (see surface audit below).
 *
 * Bun / Node API surface eliza depends on (audited 2026-05):
 *
 *   Bun.spawn           102 call sites   — process spawning (coding-tools, llama, pty)
 *   Bun.build            31 sites        — bundling agent projects
 *   Bun.serve            14 sites        — http servers (api on 2138)
 *   Bun.Worker            3 sites        — carrot host
 *   Bun.file              2 sites
 *
 *   node:path           635 imports
 *   node:fs             489 imports
 *   node:fs/promises    150 imports
 *   node:os             221 imports
 *   node:url            218 imports
 *   node:http           171 imports
 *   node:crypto         155 imports
 *   node:net             60 imports
 *   node:process         52 imports
 *   node:module          47 imports
 *   node:util            31 imports
 *   …                    + lower-volume modules
 *
 * Polyfill priority (incremental, by leverage):
 *   1.  node:path        — pure JS, port directly (no native ops)
 *   2.  node:os          — wrap NSProcessInfo + Foundation
 *   3.  node:fs (sync)   — bridge to FileManager + Data(contentsOf:)
 *   4.  node:fs/promises — same, async wrapper
 *   5.  node:crypto      — CryptoKit (HMAC, SHA, AES, etc)
 *   6.  node:http        — URLSession-backed
 *   7.  node:net         — Network.framework / sockets
 *   8.  Bun.spawn        — Process + Pipe, signal handling
 *   9.  Bun.serve        — NWListener-based HTTP server
 *   10. node:url         — pure JS port of URL parsing
 *   11. node:module      — minimal CommonJS resolver
 *   12. node:process     — env, argv, exit handlers
 *   13. node:util        — pure JS port (most of it is)
 *   14. Bun.build        — last; only needed for agent-project scaffolding
 *
 * The prototype below loads a small JS module that mirrors the
 * freeform-planner's parser logic — pure-string-manipulation code with
 * NO Node/Bun dependencies. If we can run THAT in-process, the rest is
 * incremental polyfill work, not a fundamental feasibility question.
 */

import Foundation
import JavaScriptCore

@MainActor
final class JSRuntime {
    static let shared = JSRuntime()

    private let context: JSContext

    init() {
        guard let ctx = JSContext() else {
            fatalError("[JSRuntime] could not create JSContext")
        }
        self.context = ctx
        installBasePolyfills()
        // Node-compat surface: node:path, node:os, node:fs (sync +
        // promises), process.env/argv/cwd/exit/nextTick/hrtime,
        // setTimeout/setInterval, minimal Buffer. Built incrementally
        // as eliza modules need them.
        JSPolyfills.installAll(in: ctx)
        // Round 2: node:crypto (CryptoKit), node:url (WHATWG-backed),
        // node:http + node:https (URLSession shims).
        JSPolyfillsExtras.installAll(in: ctx)
    }

    // MARK: - Public API

    /// Evaluate a JS string. Returns the JSValue result or nil on
    /// exception (exception details routed to NSLog).
    @discardableResult
    func eval(_ source: String, name: String = "<eval>") -> JSValue? {
        context.exception = nil
        guard let value = context.evaluateScript(source, withSourceURL: URL(string: "detour://js/\(name)")) else {
            return nil
        }
        if let exc = context.exception {
            NSLog("[JSRuntime] exception in \(name): \(exc)")
            context.exception = nil
            return nil
        }
        return value
    }

    /// Call a function defined in the runtime, passing JS-encodable args.
    /// Returns nil on missing function or thrown exception.
    func call(_ functionName: String, args: [Any] = []) -> JSValue? {
        guard let fn = context.objectForKeyedSubscript(functionName),
              !fn.isUndefined else {
            NSLog("[JSRuntime] no function \(functionName)")
            return nil
        }
        context.exception = nil
        let result = fn.call(withArguments: args)
        if let exc = context.exception {
            NSLog("[JSRuntime] exception calling \(functionName): \(exc)")
            context.exception = nil
            return nil
        }
        return result
    }

    // MARK: - Polyfills

    /// Install the minimum surface so JS code that's PURE LOGIC can
    /// run: console.log, setTimeout/clearTimeout, and a `detour`
    /// namespace for Swift bridges.
    private func installBasePolyfills() {
        // console.log → NSLog
        let consoleLog: @convention(block) (String) -> Void = { msg in
            NSLog("[JS] \(msg)")
        }
        let console = JSValue(newObjectIn: context)
        console?.setObject(consoleLog, forKeyedSubscript: "log" as NSString)
        console?.setObject(consoleLog, forKeyedSubscript: "warn" as NSString)
        console?.setObject(consoleLog, forKeyedSubscript: "error" as NSString)
        console?.setObject(consoleLog, forKeyedSubscript: "info" as NSString)
        context.setObject(console, forKeyedSubscript: "console" as NSString)

        // setTimeout — minimal version (no clearTimeout for the prototype).
        let setTimeout: @convention(block) (JSValue, Double) -> Void = { fn, ms in
            DispatchQueue.main.asyncAfter(deadline: .now() + ms / 1000) {
                fn.call(withArguments: [])
            }
        }
        context.setObject(setTimeout, forKeyedSubscript: "setTimeout" as NSString)

        // `detour` namespace: where Swift bridges land. Adding more
        // bridges (vault read, pensieve search, etc) goes here.
        let detour = JSValue(newObjectIn: context)
        context.setObject(detour, forKeyedSubscript: "detour" as NSString)

        // detour.bridge.appVersion() — proof of concept: JS calls into Swift.
        let bridge = JSValue(newObjectIn: context)
        let appVersion: @convention(block) () -> String = {
            return "Detour Swift+JSC \(ProcessInfo.processInfo.operatingSystemVersionString)"
        }
        bridge?.setObject(appVersion, forKeyedSubscript: "appVersion" as NSString)
        detour?.setObject(bridge, forKeyedSubscript: "bridge" as NSString)
    }

    /// Run an end-to-end exercise of the polyfill layer. Tests real
    /// Node-style calls so we know each bridge works before we ask
    /// eliza modules to depend on them.
    @discardableResult
    func runPolyfillTest() -> Bool {
        let js = """
        (function(){
          const path = require('node:path');
          const os = require('node:os');
          const fs = require('node:fs');
          const crypto = require('node:crypto');
          const url = require('node:url');
          const home = os.homedir();
          const tmpFile = path.join(os.tmpdir(), 'detour-jsc-polyfill.test');
          fs.writeFileSync(tmpFile, 'hello from jsc');
          const read = fs.readFileSync(tmpFile, 'utf8');
          const stat = fs.statSync(tmpFile);
          fs.unlinkSync(tmpFile);
          // node:crypto roundtrip
          const h = crypto.createHash('sha256').update('detour').digest('hex');
          const uuid = crypto.randomUUID();
          // node:url roundtrip
          const parsed = url.parse('https://detour.app/foo?x=1');
          console.log(JSON.stringify({
            home, platform: os.platform(), arch: os.arch(),
            cpus: os.cpus().length,
            cwd: process.cwd(),
            roundtrip: read,
            statSize: stat && stat.size,
            pathTest: path.resolve('/a/b', '../c', './d') === '/a/c/d',
            sha256: h,
            uuidShape: /^[0-9a-f-]{36}$/.test(uuid),
            urlHost: parsed.hostname,
          }));
        })();
        """
        eval(js, name: "polyfill-test.js")
        return context.exception == nil
    }

    /// Run the prototype: load + execute a pure-JS module that mirrors
    /// the parseFreeformResponse logic. Proves we can host real
    /// product code in JSC. Returns true on success.
    @discardableResult
    func runPrototype() -> Bool {
        let prototypeJS = """
        // Pure-JS port of freeform-planner's parseFreeformResponse.
        // No node:* imports. No Bun globals. Runs in any JS engine.
        globalThis.parseFreeform = function(raw, validActions) {
          if (!raw || raw.trim().length === 0) return null;
          let text = raw.replace(/<think>[\\s\\S]*?<\\/think>/gi, '').trim();
          text = text.replace(/^```[a-z]*\\s*/i, '').replace(/\\s*```$/i, '');
          const actionsMatch = text.match(/^\\s*ACTIONS:\\s*(.+?)(?:\\r?\\n|$)/im);
          const replyMatch = text.match(/^\\s*REPLY:\\s*([\\s\\S]+?)(?=^\\s*(?:ACTIONS|THOUGHT):|\\s*$)/im);
          const thoughtMatch = text.match(/^\\s*THOUGHT:\\s*(.+?)(?:\\r?\\n|$)/im);
          const validSet = new Set(validActions.map(s => s.toUpperCase()));
          let actions = [];
          if (actionsMatch) {
            actions = actionsMatch[1]
              .split(/[,;]/)
              .map(s => s.trim().toUpperCase())
              .filter(s => s.length > 0 && validSet.has(s));
          }
          if (actions.length === 0) actions = ['REPLY'];
          const reply = (replyMatch ? replyMatch[1] : '').trim();
          const thought = (thoughtMatch ? thoughtMatch[1] : 'Free-form planner').trim();
          return { actions, reply, thought };
        };
        // Verify the Swift bridge is reachable.
        console.log('JSC runtime up — bridge says: ' + detour.bridge.appVersion());
        """
        eval(prototypeJS, name: "freeform-prototype.js")
        // Drive the function with a sample LLM response.
        let demo = """
        ACTIONS: PENSIEVE_SEARCH, REPLY
        REPLY: Here's what I found in memory.
        THOUGHT: User wants to recall something stored.
        """
        let validActions = ["REPLY", "PENSIEVE_SEARCH", "VAULT_LIST"]
        guard let result = call("parseFreeform", args: [demo, validActions]) else {
            NSLog("[JSRuntime] prototype: parseFreeform returned nil")
            return false
        }
        if let dict = result.toDictionary() as? [String: Any] {
            NSLog("[JSRuntime] prototype OK — parsed actions=\(dict["actions"] ?? "?"), reply=\(dict["reply"] ?? "?")")
            return true
        }
        return false
    }
}
