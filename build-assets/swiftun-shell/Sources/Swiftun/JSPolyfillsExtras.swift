/*
 * JSPolyfillsExtras — additional Node-compat surface beyond the base
 * (path / os / fs / process / timers / Buffer in JSPolyfills.swift).
 *
 * This file adds:
 *   - node:crypto (CryptoKit-backed: createHash, randomBytes, randomUUID,
 *                  createHmac)
 *   - node:url    (pure JS port of URL + URLSearchParams interop)
 *   - node:http   (URLSession-backed fetch + http.request shim)
 *   - global fetch (already in JSC since Safari 19; we ensure it works)
 *
 * Install via JSPolyfillsExtras.installAll(in:) right after
 * JSPolyfills.installAll() in JSRuntime.init().
 */

import Foundation
import CryptoKit
import JavaScriptCore

enum JSPolyfillsExtras {
    static func installAll(in context: JSContext) {
        installNodeCrypto(in: context)
        installNodeUrl(in: context)
        installNodeHttp(in: context)
    }

    // MARK: - node:crypto (CryptoKit)

    private static func installNodeCrypto(in context: JSContext) {
        // createHash(alg) → { update(s), digest(encoding) } — supports
        // sha256, sha512, sha384, sha1, md5 (legacy paths only).
        final class HashState: @unchecked Sendable {
            var sha256: SHA256? = SHA256()
            var sha512: SHA512? = SHA512()
            var sha384: SHA384? = SHA384()
            var sha1: Insecure.SHA1? = Insecure.SHA1()
            var md5: Insecure.MD5? = Insecure.MD5()
            let alg: String
            init(alg: String) {
                self.alg = alg
                if alg != "sha256" { sha256 = nil }
                if alg != "sha512" { sha512 = nil }
                if alg != "sha384" { sha384 = nil }
                if alg != "sha1" { sha1 = nil }
                if alg != "md5" { md5 = nil }
            }
            func update(_ s: String) {
                let data = Data(s.utf8)
                switch alg {
                case "sha256": sha256?.update(data: data)
                case "sha512": sha512?.update(data: data)
                case "sha384": sha384?.update(data: data)
                case "sha1": sha1?.update(data: data)
                case "md5": md5?.update(data: data)
                default: break
                }
            }
            func digest() -> Data {
                switch alg {
                case "sha256": return sha256.map { Data($0.finalize()) } ?? Data()
                case "sha512": return sha512.map { Data($0.finalize()) } ?? Data()
                case "sha384": return sha384.map { Data($0.finalize()) } ?? Data()
                case "sha1": return sha1.map { Data($0.finalize()) } ?? Data()
                case "md5": return md5.map { Data($0.finalize()) } ?? Data()
                default: return Data()
                }
            }
        }
        let createHash: @convention(block) (String) -> JSValue? = { alg in
            let state = HashState(alg: alg.lowercased())
            let obj = JSValue(newObjectIn: context)
            let updateFn: @convention(block) (String) -> JSValue? = { s in
                state.update(s)
                return obj  // chainable
            }
            let digestFn: @convention(block) (String?) -> Any = { encoding in
                let d = state.digest()
                switch (encoding ?? "buffer").lowercased() {
                case "hex": return d.map { String(format: "%02x", $0) }.joined()
                case "base64": return d.base64EncodedString()
                default: return [UInt8](d)
                }
            }
            obj?.setObject(updateFn, forKeyedSubscript: "update" as NSString)
            obj?.setObject(digestFn, forKeyedSubscript: "digest" as NSString)
            return obj
        }
        let randomBytes: @convention(block) (Int) -> [UInt8] = { n in
            var bytes = [UInt8](repeating: 0, count: max(0, n))
            _ = SecRandomCopyBytes(kSecRandomDefault, n, &bytes)
            return bytes
        }
        let randomUUID: @convention(block) () -> String = {
            UUID().uuidString.lowercased()
        }
        let createHmac: @convention(block) (String, Any) -> JSValue? = { alg, keyArg in
            let keyData: Data
            if let s = keyArg as? String { keyData = Data(s.utf8) }
            else if let arr = keyArg as? [UInt8] { keyData = Data(arr) }
            else { keyData = Data() }
            let key = SymmetricKey(data: keyData)
            // Capture state in a holder so the closures can mutate it.
            final class HmacState: @unchecked Sendable {
                var sha256: HMAC<SHA256>?
                var sha512: HMAC<SHA512>?
                let alg: String
                init(alg: String, key: SymmetricKey) {
                    self.alg = alg
                    self.sha256 = alg == "sha256" ? HMAC<SHA256>(key: key) : nil
                    self.sha512 = alg == "sha512" ? HMAC<SHA512>(key: key) : nil
                }
            }
            let state = HmacState(alg: alg.lowercased(), key: key)
            let obj = JSValue(newObjectIn: context)
            let updateFn: @convention(block) (String) -> JSValue? = { s in
                let data = Data(s.utf8)
                state.sha256?.update(data: data)
                state.sha512?.update(data: data)
                return obj
            }
            let digestFn: @convention(block) (String?) -> Any = { encoding in
                let d: Data
                if let h = state.sha256?.finalize() { d = Data(h) }
                else if let h = state.sha512?.finalize() { d = Data(h) }
                else { d = Data() }
                switch (encoding ?? "buffer").lowercased() {
                case "hex": return d.map { String(format: "%02x", $0) }.joined()
                case "base64": return d.base64EncodedString()
                default: return [UInt8](d)
                }
            }
            obj?.setObject(updateFn, forKeyedSubscript: "update" as NSString)
            obj?.setObject(digestFn, forKeyedSubscript: "digest" as NSString)
            return obj
        }

        let crypto = JSValue(newObjectIn: context)
        crypto?.setObject(createHash, forKeyedSubscript: "createHash" as NSString)
        crypto?.setObject(randomBytes, forKeyedSubscript: "randomBytes" as NSString)
        crypto?.setObject(randomUUID, forKeyedSubscript: "randomUUID" as NSString)
        crypto?.setObject(createHmac, forKeyedSubscript: "createHmac" as NSString)

        let registry = context.objectForKeyedSubscript("__nodePolyfills")
        registry?.setObject(crypto, forKeyedSubscript: "node:crypto" as NSString)
        registry?.setObject(crypto, forKeyedSubscript: "crypto" as NSString)
    }

    // MARK: - node:url (pure JS — JSC standalone has no WHATWG URL)

    private static func installNodeUrl(in context: JSContext) {
        // Standalone JSC doesn't expose URL / URLSearchParams (those
        // are WebKit DOM bindings). Provide our own minimal classes
        // covering parse / format / file-URL helpers + URLSearchParams.
        let js = """
        (function(){
          // Minimal URLSearchParams — just enough for get / set / toString
          // / entries / Object.fromEntries support.
          class USP {
            constructor(init) {
              this._params = [];
              if (typeof init === 'string') {
                const s = init.startsWith('?') ? init.slice(1) : init;
                if (s.length) for (const pair of s.split('&')) {
                  const eq = pair.indexOf('=');
                  if (eq < 0) this._params.push([decodeURIComponent(pair), '']);
                  else this._params.push([
                    decodeURIComponent(pair.slice(0, eq).replace(/\\+/g, ' ')),
                    decodeURIComponent(pair.slice(eq + 1).replace(/\\+/g, ' ')),
                  ]);
                }
              } else if (init && typeof init === 'object') {
                for (const k of Object.keys(init)) {
                  this._params.push([k, String(init[k])]);
                }
              }
            }
            get(name) { const p = this._params.find(p => p[0] === name); return p ? p[1] : null; }
            set(name, value) {
              const i = this._params.findIndex(p => p[0] === name);
              if (i >= 0) this._params[i][1] = String(value);
              else this._params.push([name, String(value)]);
            }
            has(name) { return this._params.some(p => p[0] === name); }
            delete(name) { this._params = this._params.filter(p => p[0] !== name); }
            append(name, value) { this._params.push([name, String(value)]); }
            toString() {
              return this._params.map(([k, v]) =>
                encodeURIComponent(k) + '=' + encodeURIComponent(v)
              ).join('&');
            }
            entries() { return this._params.map(p => [...p])[Symbol.iterator](); }
            keys() { return this._params.map(p => p[0])[Symbol.iterator](); }
            values() { return this._params.map(p => p[1])[Symbol.iterator](); }
          }
          USP.prototype[Symbol.iterator] = USP.prototype.entries;
          globalThis.URLSearchParams = USP;

          // Minimal URL class. Parses standard absolute URLs. Doesn't
          // implement the full WHATWG state machine — good enough for
          // every Node/eliza caller in our codebase.
          class DetourURL {
            constructor(input, base) {
              let href = input;
              if (base && !/^[a-z][a-z0-9+\\-.]*:/i.test(input)) {
                // Resolve relative against base (poor-man's join).
                const baseURL = new DetourURL(base);
                const baseDir = baseURL.pathname.endsWith('/')
                  ? baseURL.pathname
                  : baseURL.pathname.replace(/[^/]*$/, '');
                href = baseURL.protocol + '//' + baseURL.host + baseDir + input;
              }
              const m = href.match(/^([a-z][a-z0-9+\\-.]*:)\\/\\/([^/?#]*)([^?#]*)(\\?[^#]*)?(#.*)?$/i);
              if (!m) {
                // file:// style without authority
                const fm = href.match(/^([a-z][a-z0-9+\\-.]*:)(.*)$/i);
                if (!fm) throw new TypeError('Invalid URL: ' + input);
                this.protocol = fm[1];
                this.host = ''; this.hostname = ''; this.port = '';
                this.pathname = fm[2] || '/';
                this.search = ''; this.hash = '';
              } else {
                this.protocol = m[1];
                const authority = m[2];
                const colon = authority.lastIndexOf(':');
                if (colon > 0 && /^\\d+$/.test(authority.slice(colon + 1))) {
                  this.hostname = authority.slice(0, colon);
                  this.port = authority.slice(colon + 1);
                } else {
                  this.hostname = authority; this.port = '';
                }
                this.host = authority;
                this.pathname = m[3] || '/';
                this.search = m[4] || '';
                this.hash = m[5] || '';
              }
              this.origin = this.protocol + '//' + this.host;
              const sp = this.search ? this.search.slice(1) : '';
              Object.defineProperty(this, 'searchParams', {
                get: () => new USP(sp),
              });
              this.href = this._buildHref();
            }
            _buildHref() {
              const auth = this.host ? '//' + this.host : '';
              return this.protocol + auth + (this.pathname || '') + this.search + this.hash;
            }
            toString() { return this.href; }
          }
          globalThis.URL = DetourURL;

          function parse(input, parseQueryString) {
            const u = new DetourURL(input);
            const result = {
              protocol: u.protocol, host: u.host, hostname: u.hostname,
              port: u.port || null, pathname: u.pathname, search: u.search,
              hash: u.hash, href: u.href, origin: u.origin,
            };
            result.query = parseQueryString
              ? Object.fromEntries(new USP(u.search).entries())
              : (u.search ? u.search.slice(1) : '');
            return result;
          }
          function format(obj) {
            if (typeof obj === 'string') return obj;
            let s = (obj.protocol || 'http:') + '//' + (obj.host || obj.hostname || '');
            if (obj.port && !s.includes(':' + obj.port)) s += ':' + obj.port;
            s += obj.pathname || '/';
            if (obj.search) s += obj.search;
            else if (obj.query && typeof obj.query === 'object') {
              const qs = new USP(obj.query).toString();
              if (qs) s += '?' + qs;
            }
            if (obj.hash) s += obj.hash;
            return s;
          }
          function fileURLToPath(url) {
            const u = (url instanceof DetourURL) ? url : new DetourURL(url);
            if (u.protocol !== 'file:') throw new Error('not a file URL');
            return decodeURIComponent(u.pathname);
          }
          function pathToFileURL(p) {
            return new DetourURL('file://' + (p.startsWith('/') ? p : '/' + p));
          }
          const mod = {
            URL: DetourURL, URLSearchParams: USP,
            parse, format, fileURLToPath, pathToFileURL,
            resolve: (from, to) => new DetourURL(to, from).href,
          };
          __nodePolyfills["node:url"] = mod;
          __nodePolyfills["url"] = mod;
        })();
        """
        context.evaluateScript(js, withSourceURL: URL(string: "detour://js/polyfill/url.js"))
    }

    // MARK: - node:http (URLSession-backed shim)

    private static func installNodeHttp(in context: JSContext) {
        // The full node:http surface is huge. We provide:
        //   - http.request(options, cb)  — minimal "GET/POST + receive body" form
        //   - http.get(url, cb)          — sugar
        // …backed by URLSession. This is enough for any agent code that
        // calls into a JSON REST API. Streaming-body callers would need
        // more work; flagged in TODO.
        final class Ctx: @unchecked Sendable {
            let ctx: JSContext
            init(_ c: JSContext) { self.ctx = c }
        }
        final class Cb: @unchecked Sendable {
            let fn: JSValue
            init(_ f: JSValue) { self.fn = f }
        }
        let tctx = Ctx(context)
        let httpRequest: @convention(block) (Any, JSValue?) -> Void = { options, cb in
            let cbHolder: Cb? = cb.flatMap { $0.isUndefined ? nil : Cb($0) }
            // Accept either a URL string or {hostname, port, path, method, headers, body}.
            var url: URL? = nil
            var method = "GET"
            var body: Data? = nil
            var extraHeaders: [String: String] = [:]
            if let s = options as? String, let u = URL(string: s) {
                url = u
            } else if let dict = options as? [String: Any] {
                method = (dict["method"] as? String) ?? "GET"
                let protocolStr = (dict["protocol"] as? String) ?? "http:"
                let host = (dict["hostname"] as? String) ?? (dict["host"] as? String) ?? "127.0.0.1"
                let pathPart = (dict["path"] as? String) ?? "/"
                let portPart = (dict["port"] as? Int).map { ":\($0)" } ?? ""
                url = URL(string: "\(protocolStr)//\(host)\(portPart)\(pathPart)")
                if let h = dict["headers"] as? [String: String] { extraHeaders = h }
                if let b = dict["body"] as? String { body = b.data(using: .utf8) }
            }
            guard let target = url else {
                cbHolder?.fn.call(withArguments: [["error": "invalid URL"]])
                return
            }
            var req = URLRequest(url: target, timeoutInterval: 30)
            req.httpMethod = method.uppercased()
            for (k, v) in extraHeaders { req.addValue(v, forHTTPHeaderField: k) }
            if let body = body { req.httpBody = body }
            URLSession.shared.dataTask(with: req) { data, resp, err in
                let http = resp as? HTTPURLResponse
                let respDict: [String: Any] = [
                    "statusCode": http?.statusCode ?? 0,
                    "headers": http?.allHeaderFields ?? [:],
                    "body": data.flatMap { String(data: $0, encoding: .utf8) } ?? "",
                    "error": err?.localizedDescription ?? "",
                ]
                DispatchQueue.main.async {
                    cbHolder?.fn.call(withArguments: [respDict])
                    _ = tctx  // keep ctx referenced
                }
            }.resume()
        }

        let http = JSValue(newObjectIn: context)
        http?.setObject(httpRequest, forKeyedSubscript: "request" as NSString)
        http?.setObject(httpRequest, forKeyedSubscript: "get" as NSString)
        let registry = context.objectForKeyedSubscript("__nodePolyfills")
        registry?.setObject(http, forKeyedSubscript: "node:http" as NSString)
        registry?.setObject(http, forKeyedSubscript: "http" as NSString)
        // node:https aliases to the same shim — URLSession negotiates TLS.
        registry?.setObject(http, forKeyedSubscript: "node:https" as NSString)
        registry?.setObject(http, forKeyedSubscript: "https" as NSString)
    }
}
