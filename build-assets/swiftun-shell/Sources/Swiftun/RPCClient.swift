/*
 * RPCClient — typed JSON-RPC 2.0 client over a Unix domain socket.
 * The Detour 2026 IPC primitive. Per-call latency ~80µs vs the
 * ~1ms HTTP loopback we used to use.
 *
 * Wire format (newline-delimited):
 *
 *   // Request:
 *   {"jsonrpc":"2.0","id":42,"method":"eval.send","params":{...}}\n
 *   // Response:
 *   {"jsonrpc":"2.0","id":42,"result":{...}}\n
 *   // Server-pushed event (no id, no response):
 *   {"jsonrpc":"2.0","method":"event.agentNarrate","params":{...}}\n
 *
 * Reconnects with exponential backoff if the socket drops. Pending
 * requests resolve in order on next-connection. Events arrive via
 * registered notification handlers.
 *
 * Socket path resolves to ~/.detour/rpc.sock; the bun side opens it
 * in `core/rpc-socket.ts`.
 */

import Foundation
import Network

@MainActor
final class RPCClient {
    static let shared = RPCClient()

    private let socketPath: String
    private var connection: NWConnection?
    private var buffer: Data = Data()
    private var nextRequestID: Int = 1
    private var hasLoggedConnectionLost: Bool = false
    /// Pending continuations resolve with raw JSON-RPC `result` data
    /// (serialized back to bytes so we cross the Sendable boundary
    /// safely; callers decode on their side).
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var notificationHandlers: [String: (Any?) -> Void] = [:]
    private var connected: Bool = false
    private var reconnectDelay: TimeInterval = 0.5

    init(socketPath: String = NSString(string: "~/.detour/rpc.sock").expandingTildeInPath) {
        self.socketPath = socketPath
    }

    func connect() {
        if connection != nil { return }
        let endpoint = NWEndpoint.unix(path: socketPath)
        let params = NWParameters.tcp  // Network framework uses .tcp params for unix sockets
        let conn = NWConnection(to: endpoint, using: params)
        conn.stateUpdateHandler = { [weak self] state in
            Task { @MainActor [weak self] in
                self?.handleState(state)
            }
        }
        conn.start(queue: .global(qos: .userInitiated))
        self.connection = conn
    }

    private func handleState(_ state: NWConnection.State) {
        switch state {
        case .ready:
            connected = true
            reconnectDelay = 0.5
            hasLoggedConnectionLost = false
            NSLog("[RPCClient] connected to \(socketPath)")
            startReceiveLoop()
        case .failed(let err):
            // Log once per disconnect cycle, not on every retry.
            if !hasLoggedConnectionLost {
                NSLog("[RPCClient] failed: \(err.localizedDescription); reconnecting")
                hasLoggedConnectionLost = true
            }
            self.connected = false
            self.connection?.cancel()
            self.connection = nil
            scheduleReconnect()
        case .cancelled:
            self.connected = false
            self.connection = nil
        case .waiting(_):
            // Network.framework parks Unix-socket connections in
            // .waiting when the file doesn't exist yet. Reschedule
            // without spamming the log — bun's startup race is normal.
            self.connected = false
            self.connection?.cancel()
            self.connection = nil
            scheduleReconnect()
        default:
            break
        }
    }

    private func scheduleReconnect() {
        let delay = reconnectDelay
        reconnectDelay = min(10, reconnectDelay * 2)
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            self?.connect()
        }
    }

    private func startReceiveLoop() {
        guard let conn = connection else { return }
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, err in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let data = data, !data.isEmpty {
                    self.buffer.append(data)
                    self.drainBuffer()
                }
                if isComplete || err != nil {
                    self.connected = false
                    self.connection = nil
                    self.scheduleReconnect()
                    return
                }
                self.startReceiveLoop()
            }
        }
    }

    private func drainBuffer() {
        while let nlIdx = buffer.firstIndex(of: 0x0a) {  // 0x0a = '\n'
            let lineRange = buffer.startIndex..<nlIdx
            let lineData = buffer.subdata(in: lineRange)
            buffer.removeSubrange(buffer.startIndex...nlIdx)
            guard let json = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any]
            else { continue }
            handleMessage(json)
        }
    }

    private func handleMessage(_ msg: [String: Any]) {
        if let idAny = msg["id"], let id = idAny as? Int {
            guard let cont = pending.removeValue(forKey: id) else { return }
            if let errDict = msg["error"] as? [String: Any] {
                let message = (errDict["message"] as? String) ?? "rpc error"
                cont.resume(throwing: RPCError.remoteError(message))
                return
            }
            let result = msg["result"] ?? NSNull()
            do {
                let data = try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed])
                cont.resume(returning: data)
            } catch {
                cont.resume(throwing: RPCError.remoteError("could not re-encode result: \(error.localizedDescription)"))
            }
            return
        }
        if let method = msg["method"] as? String {
            let params = msg["params"]
            if let handler = notificationHandlers[method] {
                handler(params)
            }
        }
    }

    // MARK: - Public API

    @discardableResult
    func call(_ method: String, params: [String: Any] = [:], timeoutSeconds: Double = 15.0) async throws -> Data {
        // Wait up to 30s for the connection to be ready. Polls every
        // 100ms. Covers the cold-start race (Swift wins boot vs bun)
        // without spamming retries via the @MainActor reconnect path.
        if !connected {
            connect()
            for _ in 0..<300 {
                if connected { break }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        guard let conn = connection, connected else {
            throw RPCError.notConnected
        }
        let id = nextRequestID
        nextRequestID += 1
        let frame: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        ]
        var data = try JSONSerialization.data(withJSONObject: frame)
        data.append(0x0a)

        // Arm a timeout: if no response in `timeoutSeconds`, look up the
        // pending continuation and fail it. Cancelled on success below
        // so a successful call doesn't double-resume the continuation.
        let timeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
            if Task.isCancelled { return }
            guard let self else { return }
            if let cont = self.pending.removeValue(forKey: id) {
                cont.resume(throwing: RPCError.timedOut(method, timeoutSeconds))
            }
        }
        defer { timeoutTask.cancel() }

        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            self.pending[id] = cont
            conn.send(content: data, completion: .contentProcessed { err in
                if let err = err {
                    Task { @MainActor [weak self] in
                        if let cont = self?.pending.removeValue(forKey: id) {
                            cont.resume(throwing: RPCError.sendFailed(err.localizedDescription))
                        }
                    }
                }
            })
        }
    }

    /// Register a handler for a server-pushed notification (e.g.
    /// "event.chatComplete", "event.agentNarrate"). Replaces SSE.
    func onNotification(_ method: String, handler: @escaping (Any?) -> Void) {
        notificationHandlers[method] = handler
    }

    /// Convenience: typed-decode the JSON-RPC result into a Decodable.
    func callTyped<T: Decodable>(_ method: String, params: [String: Any] = [:], as type: T.Type) async throws -> T {
        let data = try await call(method, params: params)
        return try JSONDecoder().decode(T.self, from: data)
    }
}

enum RPCError: LocalizedError {
    case notConnected
    case sendFailed(String)
    case remoteError(String)
    case timedOut(String, Double)
    var errorDescription: String? {
        switch self {
        case .notConnected: return "RPC socket not connected"
        case .sendFailed(let m): return "RPC send failed: \(m)"
        case .remoteError(let m): return "RPC remote error: \(m)"
        case .timedOut(let m, let s): return "RPC \(m) timed out after \(Int(s))s"
        }
    }
}
