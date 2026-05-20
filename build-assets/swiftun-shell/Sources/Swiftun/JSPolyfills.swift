/*
 * JSPolyfills — Node-compat surface installed on top of JSContext so
 * pure-logic eliza modules can run in-process. Builds on the JSRuntime
 * scaffold (JSRuntime.swift) — that file holds JSContext lifecycle +
 * the prototype; this file holds the Node/Bun surface bridges.
 *
 * What's polyfilled in this first cut:
 *   - node:path        (pure JS port, no native ops)
 *   - node:os          (Swift bridge via ProcessInfo + Foundation)
 *   - node:fs sync     (Swift bridge via FileManager + Data)
 *   - node:fs/promises (same, returning JS Promises)
 *   - process.env / .argv / .platform / .cwd()
 *   - setTimeout / setInterval / clearTimeout / clearInterval (real timers)
 *   - Buffer (string-only stub via Uint8Array — enough for most eliza paths)
 *
 * Out of scope for this commit (next milestones):
 *   - node:crypto      (CryptoKit bridge — separate file)
 *   - node:http / fetch (URLSession-backed — separate file)
 *   - node:net         (Network.framework — separate file)
 *   - Bun.spawn        (Process + Pipe — separate file)
 *   - Bun.serve        (NWListener — separate file)
 *
 * Wiring: install via JSPolyfills.installAll(in:) right after
 * JSRuntime.init's installBasePolyfills().
 */

import Foundation
import JavaScriptCore

enum JSPolyfills {
    /// Install every polyfill onto a JSContext. Idempotent — second
    /// call is a no-op since the bridge objects already exist.
    static func installAll(in context: JSContext) {
        installModuleRegistry(in: context)
        installNodePath(in: context)
        installNodeOs(in: context)
        installNodeFs(in: context)
        installProcess(in: context)
        installTimers(in: context)
        installBuffer(in: context)
    }

    // MARK: - require() / module registry

    /// Lightweight CommonJS-style `require()` that returns one of the
    /// polyfill modules. Real eliza source uses ESM imports, but
    /// transpilers often turn those into `require(...)` calls; we
    /// support both by exposing the modules on both `require("node:fs")`
    /// AND `globalThis.__nodePolyfills["node:fs"]`.
    private static func installModuleRegistry(in context: JSContext) {
        let registry = JSValue(newObjectIn: context)
        context.setObject(registry, forKeyedSubscript: "__nodePolyfills" as NSString)
        let require: @convention(block) (String) -> JSValue? = { id in
            let normalized = id.hasPrefix("node:") ? id : "node:\(id)"
            return context.objectForKeyedSubscript("__nodePolyfills").objectForKeyedSubscript(normalized)
        }
        context.setObject(require, forKeyedSubscript: "require" as NSString)
    }

    // MARK: - node:path

    /// Pure-JS port of the parts of node:path we actually use.
    /// Posix-style throughout (macOS-native; we don't need Windows).
    private static func installNodePath(in context: JSContext) {
        let js = """
        (function(){
          const SEP = '/';
          function normalize(p) {
            if (p.length === 0) return '.';
            const absolute = p.startsWith(SEP);
            const trailing = p.endsWith(SEP) && p.length > 1;
            const parts = p.split(SEP).filter(s => s.length > 0);
            const stack = [];
            for (const part of parts) {
              if (part === '.') continue;
              if (part === '..') {
                if (stack.length > 0 && stack[stack.length-1] !== '..') stack.pop();
                else if (!absolute) stack.push('..');
              } else stack.push(part);
            }
            let result = stack.join(SEP);
            if (absolute) result = SEP + result;
            if (trailing && !result.endsWith(SEP)) result += SEP;
            return result.length === 0 ? (absolute ? SEP : '.') : result;
          }
          function join(...parts) {
            return normalize(parts.filter(p => typeof p === 'string' && p.length > 0).join(SEP));
          }
          function resolve(...parts) {
            let result = '';
            for (let i = parts.length - 1; i >= 0 && !result.startsWith(SEP); i--) {
              const p = parts[i];
              if (typeof p !== 'string' || p.length === 0) continue;
              result = p + (result ? SEP + result : '');
            }
            if (!result.startsWith(SEP)) result = (globalThis.process && process.cwd() || '/') + SEP + result;
            return normalize(result);
          }
          function dirname(p) {
            if (p === '/' || p === '') return p || '.';
            const i = p.lastIndexOf(SEP);
            if (i < 0) return '.';
            if (i === 0) return '/';
            return p.slice(0, i);
          }
          function basename(p, ext) {
            const i = p.lastIndexOf(SEP);
            let base = i >= 0 ? p.slice(i+1) : p;
            if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
            return base;
          }
          function extname(p) {
            const b = basename(p);
            const i = b.lastIndexOf('.');
            return (i <= 0) ? '' : b.slice(i);
          }
          function relative(from, to) {
            from = resolve(from); to = resolve(to);
            const fp = from.split(SEP), tp = to.split(SEP);
            let i = 0;
            while (i < fp.length && i < tp.length && fp[i] === tp[i]) i++;
            const up = new Array(fp.length - i).fill('..');
            return up.concat(tp.slice(i)).join(SEP) || '.';
          }
          const path = { sep: SEP, delimiter: ':', posix: null, win32: null,
            normalize, join, resolve, dirname, basename, extname, relative,
            isAbsolute: p => p.startsWith(SEP),
            parse: p => ({
              root: p.startsWith(SEP) ? SEP : '',
              dir: dirname(p), base: basename(p),
              ext: extname(p), name: basename(p, extname(p))
            }),
          };
          path.posix = path;
          __nodePolyfills["node:path"] = path;
          __nodePolyfills["path"] = path;
        })();
        """
        context.evaluateScript(js, withSourceURL: URL(string: "detour://js/polyfill/path.js"))
    }

    // MARK: - node:os

    private static func installNodeOs(in context: JSContext) {
        let osHomedir: @convention(block) () -> String = {
            FileManager.default.homeDirectoryForCurrentUser.path
        }
        let osTmpdir: @convention(block) () -> String = {
            NSTemporaryDirectory()
        }
        let osHostname: @convention(block) () -> String = {
            ProcessInfo.processInfo.hostName
        }
        let osPlatform: @convention(block) () -> String = { "darwin" }
        let osArch: @convention(block) () -> String = {
            var info = utsname()
            uname(&info)
            let machine = withUnsafeBytes(of: &info.machine) { rawBuf -> String in
                let buf = rawBuf.bindMemory(to: CChar.self).baseAddress!
                return String(cString: buf)
            }
            return machine.hasPrefix("arm64") ? "arm64" : "x64"
        }
        let osTotalmem: @convention(block) () -> Double = {
            Double(ProcessInfo.processInfo.physicalMemory)
        }
        let osCpus: @convention(block) () -> [[String: Any]] = {
            let count = ProcessInfo.processInfo.activeProcessorCount
            return Array(repeating: ["model": "Apple Silicon", "speed": 3500], count: count)
        }
        let osEol: String = "\n"
        let osRelease: @convention(block) () -> String = {
            ProcessInfo.processInfo.operatingSystemVersionString
        }

        let os = JSValue(newObjectIn: context)
        os?.setObject(osHomedir, forKeyedSubscript: "homedir" as NSString)
        os?.setObject(osTmpdir, forKeyedSubscript: "tmpdir" as NSString)
        os?.setObject(osHostname, forKeyedSubscript: "hostname" as NSString)
        os?.setObject(osPlatform, forKeyedSubscript: "platform" as NSString)
        os?.setObject(osArch, forKeyedSubscript: "arch" as NSString)
        os?.setObject(osTotalmem, forKeyedSubscript: "totalmem" as NSString)
        os?.setObject(osCpus, forKeyedSubscript: "cpus" as NSString)
        os?.setObject(osEol, forKeyedSubscript: "EOL" as NSString)
        os?.setObject(osRelease, forKeyedSubscript: "release" as NSString)

        let registry = context.objectForKeyedSubscript("__nodePolyfills")
        registry?.setObject(os, forKeyedSubscript: "node:os" as NSString)
        registry?.setObject(os, forKeyedSubscript: "os" as NSString)
    }

    // MARK: - node:fs

    private static func installNodeFs(in context: JSContext) {
        let fm = FileManager.default

        let existsSync: @convention(block) (String) -> Bool = { path in
            fm.fileExists(atPath: path)
        }
        let readFileSync: @convention(block) (String, String?) -> Any? = { path, encoding in
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
            if let enc = encoding, !enc.isEmpty {
                return String(data: data, encoding: .utf8) ?? ""
            }
            return [UInt8](data)
        }
        let writeFileSync: @convention(block) (String, Any) -> Bool = { path, content in
            let url = URL(fileURLWithPath: path)
            try? fm.createDirectory(at: url.deletingLastPathComponent(),
                                    withIntermediateDirectories: true)
            if let s = content as? String,
               let data = s.data(using: .utf8) {
                return (try? data.write(to: url)) != nil
            }
            if let bytes = content as? [UInt8] {
                return (try? Data(bytes).write(to: url)) != nil
            }
            return false
        }
        let mkdirSync: @convention(block) (String, Any?) -> Bool = { path, _ in
            (try? fm.createDirectory(atPath: path,
                                     withIntermediateDirectories: true)) != nil
        }
        let readdirSync: @convention(block) (String) -> [String] = { path in
            (try? fm.contentsOfDirectory(atPath: path)) ?? []
        }
        let statSync: @convention(block) (String) -> [String: Any]? = { path in
            guard let attrs = try? fm.attributesOfItem(atPath: path) else { return nil }
            let isDir = (attrs[.type] as? FileAttributeType) == .typeDirectory
            let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
            let mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
            return [
                "size": size,
                "mtime": mtime * 1000,
                "isDirectory": isDir,
                "isFile": !isDir,
            ]
        }
        let unlinkSync: @convention(block) (String) -> Bool = { path in
            (try? fm.removeItem(atPath: path)) != nil
        }
        let rmSync: @convention(block) (String, Any?) -> Bool = { path, _ in
            (try? fm.removeItem(atPath: path)) != nil
        }

        let fs = JSValue(newObjectIn: context)
        fs?.setObject(existsSync, forKeyedSubscript: "existsSync" as NSString)
        fs?.setObject(readFileSync, forKeyedSubscript: "readFileSync" as NSString)
        fs?.setObject(writeFileSync, forKeyedSubscript: "writeFileSync" as NSString)
        fs?.setObject(mkdirSync, forKeyedSubscript: "mkdirSync" as NSString)
        fs?.setObject(readdirSync, forKeyedSubscript: "readdirSync" as NSString)
        fs?.setObject(statSync, forKeyedSubscript: "statSync" as NSString)
        fs?.setObject(unlinkSync, forKeyedSubscript: "unlinkSync" as NSString)
        fs?.setObject(rmSync, forKeyedSubscript: "rmSync" as NSString)

        let registry = context.objectForKeyedSubscript("__nodePolyfills")
        registry?.setObject(fs, forKeyedSubscript: "node:fs" as NSString)
        registry?.setObject(fs, forKeyedSubscript: "fs" as NSString)

        // node:fs/promises — same surface, async wrappers.
        let promisesJS = """
        (function(){
          const fs = __nodePolyfills["node:fs"];
          function wrap(name) { return (...args) => new Promise((resolve, reject) => {
            try { resolve(fs[name](...args)); } catch (e) { reject(e); }
          }); }
          const promises = {
            readFile: wrap('readFileSync'),
            writeFile: wrap('writeFileSync'),
            mkdir: wrap('mkdirSync'),
            readdir: wrap('readdirSync'),
            stat: wrap('statSync'),
            unlink: wrap('unlinkSync'),
            rm: wrap('rmSync'),
            access: (path) => new Promise((resolve, reject) =>
              fs.existsSync(path) ? resolve() : reject(new Error('ENOENT: ' + path))),
          };
          __nodePolyfills["node:fs/promises"] = promises;
          __nodePolyfills["fs/promises"] = promises;
        })();
        """
        context.evaluateScript(promisesJS, withSourceURL: URL(string: "detour://js/polyfill/fs-promises.js"))
    }

    // MARK: - process

    private static func installProcess(in context: JSContext) {
        let env = JSValue(newObjectIn: context)
        for (k, v) in ProcessInfo.processInfo.environment {
            env?.setObject(v, forKeyedSubscript: k as NSString)
        }
        let cwd: @convention(block) () -> String = {
            FileManager.default.currentDirectoryPath
        }
        let chdir: @convention(block) (String) -> Bool = { p in
            FileManager.default.changeCurrentDirectoryPath(p)
        }
        let exit: @convention(block) (Int) -> Void = { code in
            NSLog("[JS process.exit] code=\(code) — ignored in embedded JSRuntime")
        }
        let nextTick: @convention(block) (JSValue) -> Void = { fn in
            // Wrap into a Sendable holder before crossing the dispatch
            // boundary. JSValue/JSContext aren't Sendable but JSC is
            // single-threaded so the hand-off is safe.
            final class FnHolder: @unchecked Sendable {
                let fn: JSValue
                init(_ f: JSValue) { self.fn = f }
            }
            let holder = FnHolder(fn)
            DispatchQueue.main.async { holder.fn.call(withArguments: []) }
        }
        let hrtime: @convention(block) () -> [Int64] = {
            let ns = DispatchTime.now().uptimeNanoseconds
            return [Int64(ns / 1_000_000_000), Int64(ns % 1_000_000_000)]
        }

        let proc = JSValue(newObjectIn: context)
        proc?.setObject(env, forKeyedSubscript: "env" as NSString)
        proc?.setObject(ProcessInfo.processInfo.arguments, forKeyedSubscript: "argv" as NSString)
        proc?.setObject("darwin", forKeyedSubscript: "platform" as NSString)
        proc?.setObject("v22.0.0", forKeyedSubscript: "version" as NSString)
        proc?.setObject(cwd, forKeyedSubscript: "cwd" as NSString)
        proc?.setObject(chdir, forKeyedSubscript: "chdir" as NSString)
        proc?.setObject(exit, forKeyedSubscript: "exit" as NSString)
        proc?.setObject(nextTick, forKeyedSubscript: "nextTick" as NSString)
        proc?.setObject(hrtime, forKeyedSubscript: "hrtime" as NSString)

        context.setObject(proc, forKeyedSubscript: "process" as NSString)
        let registry = context.objectForKeyedSubscript("__nodePolyfills")
        registry?.setObject(proc, forKeyedSubscript: "node:process" as NSString)
        registry?.setObject(proc, forKeyedSubscript: "process" as NSString)
    }

    // MARK: - timers

    private static func installTimers(in context: JSContext) {
        // Tag every active timer with an id so clearTimeout works.
        let activeTimers = JSValue(newObjectIn: context)
        context.setObject(activeTimers, forKeyedSubscript: "__detourActiveTimers" as NSString)
        // JSValue / JSContext aren't Sendable; wrap them in an
        // unchecked-sendable holder we own for the closure lifetime.
        // JavaScriptCore is single-threaded so the hand-off is safe.
        final class TimerCtx: @unchecked Sendable {
            let ctx: JSContext
            init(_ c: JSContext) { self.ctx = c }
        }
        final class FnHolder: @unchecked Sendable {
            let fn: JSValue
            init(_ f: JSValue) { self.fn = f }
        }
        let tctx = TimerCtx(context)

        let setTimeout: @convention(block) (JSValue, Double) -> Int = { fn, ms in
            let id = Int(arc4random())
            let holder = FnHolder(fn)
            activeTimers?.setObject(true, forKeyedSubscript: "\(id)" as NSString)
            DispatchQueue.main.asyncAfter(deadline: .now() + ms / 1000) {
                let timers = tctx.ctx.objectForKeyedSubscript("__detourActiveTimers")
                if let t = timers?.objectForKeyedSubscript("\(id)"), !t.isUndefined {
                    holder.fn.call(withArguments: [])
                    timers?.deleteProperty("\(id)")
                }
            }
            return id
        }
        let clearTimeout: @convention(block) (Int) -> Void = { id in
            tctx.ctx.objectForKeyedSubscript("__detourActiveTimers")?.deleteProperty("\(id)")
        }
        let setInterval: @convention(block) (JSValue, Double) -> Int = { fn, ms in
            let id = Int(arc4random())
            let holder = FnHolder(fn)
            activeTimers?.setObject(true, forKeyedSubscript: "\(id)" as NSString)
            // Use a recursive Task so we don't capture `tick` itself
            // (avoids the Sendable-self warning on `func tick`).
            func tick() {
                DispatchQueue.main.asyncAfter(deadline: .now() + ms / 1000) {
                    let timers = tctx.ctx.objectForKeyedSubscript("__detourActiveTimers")
                    guard let active = timers?.objectForKeyedSubscript("\(id)"),
                          !active.isUndefined else { return }
                    holder.fn.call(withArguments: [])
                    tick()
                }
            }
            tick()
            return id
        }

        context.setObject(setTimeout, forKeyedSubscript: "setTimeout" as NSString)
        context.setObject(clearTimeout, forKeyedSubscript: "clearTimeout" as NSString)
        context.setObject(setInterval, forKeyedSubscript: "setInterval" as NSString)
        context.setObject(clearTimeout, forKeyedSubscript: "clearInterval" as NSString)
    }

    // MARK: - Buffer (minimal)

    private static func installBuffer(in context: JSContext) {
        // Minimal Buffer: just enough for code that does Buffer.from(s)
        // / Buffer.toString. Real implementation in production would
        // bridge to Data via NSData JSValue support.
        let js = """
        if (typeof Buffer === 'undefined') {
          globalThis.Buffer = {
            from: function(input, encoding) {
              if (typeof input === 'string') {
                if (encoding === 'base64') {
                  const bin = atob(input);
                  const out = new Uint8Array(bin.length);
                  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
                  return out;
                }
                return new TextEncoder().encode(input);
              }
              return new Uint8Array(input);
            },
            isBuffer: function(b) { return b instanceof Uint8Array; },
            byteLength: function(s, enc) {
              return new TextEncoder().encode(typeof s === 'string' ? s : '').length;
            }
          };
          Uint8Array.prototype.toString = function(encoding) {
            if (encoding === 'base64') {
              let s = '';
              for (let i = 0; i < this.length; i++) s += String.fromCharCode(this[i]);
              return btoa(s);
            }
            return new TextDecoder().decode(this);
          };
        }
        """
        context.evaluateScript(js, withSourceURL: URL(string: "detour://js/polyfill/buffer.js"))
    }
}
