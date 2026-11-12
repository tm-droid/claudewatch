import Foundation

public struct APIError: LocalizedError, Sendable {
    public var status: Int
    public var message: String
    public var errorDescription: String? { message }
}

public final class APIClient: Sendable {
    public let pairing: Pairing
    private let session: URLSession
    private let streamSession: URLSession

    public init(pairing: Pairing) {
        self.pairing = pairing
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 15
        c.waitsForConnectivity = false
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: c)
        let s = URLSessionConfiguration.default
        s.timeoutIntervalForRequest = 45 // > 15 s heartbeat
        s.timeoutIntervalForResource = 60 * 60 * 6
        s.requestCachePolicy = .reloadIgnoringLocalCacheData
        streamSession = URLSession(configuration: s)
    }

    private func request(_ path: String, method: String = "GET", query: [URLQueryItem] = [], body: [String: Any]? = nil) throws -> URLRequest {
        var comps = URLComponents(url: pairing.url.appending(path: "api" + path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query }
        var r = URLRequest(url: comps.url!)
        r.httpMethod = method
        r.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return r
    }

    private func send<T: Decodable>(_ r: URLRequest, as: T.Type) async throws -> T {
        let (data, resp) = try await session.data(for: r)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            throw APIError(status: code, message: msg ?? (code == 401 ? "Pairing rejected — pair again." : "Relay error \(code)"))
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private struct OK: Decodable {}

    public func state() async throws -> RelayState {
        try await send(request("/state"), as: RelayState.self)
    }

    public func feed(_ id: String, before: Int? = nil, limit: Int = 60, thinking: Bool = false) async throws -> FeedPage {
        var q = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { q.append(URLQueryItem(name: "before", value: String(before))) }
        if thinking { q.append(URLQueryItem(name: "thinking", value: "1")) }
        return try await send(request("/sessions/\(id)", query: q), as: FeedPage.self)
    }

    public func decide(_ permissionId: String, allow: Bool, always: Bool = false, message: String? = nil) async throws {
        var body: [String: Any] = ["behavior": allow ? "allow" : "deny", "always": always]
        if let message, !message.isEmpty { body["message"] = message }
        _ = try await send(request("/permissions/\(permissionId)", method: "POST", body: body), as: OK.self)
    }

    public struct ReplyResult: Decodable, Sendable { public var result: String }

    public func reply(_ sessionId: String, text: String) async throws -> String {
        try await send(request("/sessions/\(sessionId)/reply", method: "POST", body: ["text": text]), as: ReplyResult.self).result
    }

    public func stop(_ sessionId: String) async throws {
        _ = try await send(request("/sessions/\(sessionId)/stop", method: "POST", body: [:]), as: OK.self)
    }

    public func setAway(_ mode: AwayMode) async throws {
        _ = try await send(request("/away", method: "POST", body: ["mode": mode.rawValue]), as: OK.self)
    }

    /// Server-sent events. `session` limits event bodies to one session (saves battery).
    public func stream(session: String?) -> AsyncThrowingStream<SSEMessage, Error> {
        let req: URLRequest
        do {
            var r = try request("/stream", query: session.map { [URLQueryItem(name: "session", value: $0)] } ?? [])
            r.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            req = r
        } catch {
            return AsyncThrowingStream { $0.finish(throwing: error) }
        }
        let s = streamSession
        return AsyncThrowingStream { cont in
            let task = Task {
                do {
                    let (bytes, resp) = try await s.bytes(for: req)
                    let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                    guard code == 200 else { throw APIError(status: code, message: code == 401 ? "Pairing rejected — pair again." : "Stream error \(code)") }
                    var parser = SSEParser()
                    var line = Data()
                    // Not `bytes.lines`: it skips empty lines, which delimit SSE messages.
                    for try await b in bytes {
                        if b == UInt8(ascii: "\n") {
                            if let m = parser.feed(String(decoding: line, as: UTF8.self)) { cont.yield(m) }
                            line.removeAll(keepingCapacity: true)
                        } else {
                            line.append(b)
                        }
                    }
                    cont.finish()
                } catch {
                    cont.finish(throwing: error)
                }
            }
            cont.onTermination = { _ in task.cancel() }
        }
    }
}
