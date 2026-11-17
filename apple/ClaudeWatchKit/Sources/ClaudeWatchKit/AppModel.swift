import Foundation
import Observation
#if canImport(WidgetKit)
import WidgetKit
#endif

public enum Connection: Equatable, Sendable {
    case unpaired, connecting, live, offline(String)

    public var label: String {
        switch self {
        case .unpaired: "Not paired"
        case .connecting: "Connecting…"
        case .live: "Live"
        case .offline(let why): why
        }
    }
}

public enum Signal: Sendable {
    case permission(PermissionRequest)
    case finished(SessionSummary)
    case listening(SessionSummary)
}

/// Small summary for the complication / Smart Stack widget.
public struct WidgetSnapshot: Codable, Sendable, Equatable {
    public var needsYou: Int
    public var running: Int
    public var topProject: String?
    public var topTitle: String?
    public var topStatus: SessionStatus?
    public var updated: Date

    public static let empty = WidgetSnapshot(needsYou: 0, running: 0, updated: .distantPast)

    public init(needsYou: Int, running: Int, topProject: String? = nil, topTitle: String? = nil, topStatus: SessionStatus? = nil, updated: Date) {
        self.needsYou = needsYou; self.running = running
        self.topProject = topProject; self.topTitle = topTitle; self.topStatus = topStatus; self.updated = updated
    }

    public init(state: RelayState, now: Date = .now) {
        let s = state.sessions
        let top = s.first { $0.status == .needsYou || $0.status == .listening || $0.status == .running } ?? s.first
        self.init(
            needsYou: s.filter { $0.status == .needsYou || $0.status == .listening }.count,
            running: s.filter { $0.status == .running }.count,
            topProject: top?.project, topTitle: top?.title, topStatus: top?.status, updated: now
        )
    }

    public static func load() -> WidgetSnapshot {
        KeychainBox.load(WidgetSnapshot.self, account: "widget") ?? .empty
    }

    public func save() { KeychainBox.save(self, account: "widget") }
}

@MainActor
@Observable
public final class AppModel {
    public private(set) var pairing: Pairing?
    public private(set) var sessions: [SessionSummary] = []
    public private(set) var permissions: [PermissionRequest] = []
    public private(set) var away: AwayState?
    public private(set) var connection: Connection = .unpaired
    public private(set) var feeds: [String: [FeedEvent]] = [:]
    public private(set) var hasMore: [String: Bool] = [:]
    public private(set) var lastUpdated: Date?

    /// Session whose feed is on screen; the stream carries event bodies only for it.
    public var focused: String? {
        didSet { if focused != oldValue { reconnect() } }
    }
    public var showThinking = false {
        didSet { if showThinking != oldValue, let f = focused { Task { await loadFeed(f, reset: true) } } }
    }
    public var onSignal: ((Signal) -> Void)?

    private var client: APIClient?
    private var streamTask: Task<Void, Never>?
    private var active = false
    private var lastWidget: WidgetSnapshot?

    public init(pairing: Pairing? = PairingStore.load()) {
        self.pairing = pairing
        if pairing != nil { connection = .connecting; loadCache() }
        client = pairing.map(APIClient.init)
    }

    // MARK: lifecycle

    public func pair(_ p: Pairing) {
        guard p != pairing else { return }
        PairingStore.save(p)
        pairing = p
        client = APIClient(pairing: p)
        sessions = []; permissions = []; feeds = [:]
        connection = .connecting
        if active { reconnect() }
    }

    public func unpair() {
        PairingStore.clear()
        streamTask?.cancel()
        pairing = nil; client = nil
        sessions = []; permissions = []; feeds = [:]; away = nil
        connection = .unpaired
    }

    public func resume() {
        active = true
        reconnect()
    }

    public func pause() {
        active = false
        streamTask?.cancel()
        streamTask = nil
        saveCache()
    }

    private func reconnect() {
        streamTask?.cancel()
        guard active, let client else { return }
        let session = focused
        streamTask = Task { [weak self] in
            var delay: Double = 1
            while !Task.isCancelled {
                do {
                    for try await msg in client.stream(session: session) {
                        guard let self else { return }
                        if self.connection != .live { self.connection = .live }
                        delay = 1
                        self.handle(msg)
                    }
                    if Task.isCancelled { return }
                    self?.connection = .offline("Reconnecting…")
                } catch {
                    if Task.isCancelled { return }
                    guard let self else { return }
                    self.connection = .offline(Self.describe(error))
                    // Keep the list fresh even if streaming is blocked on this network.
                    try? await self.refresh()
                }
                try? await Task.sleep(for: .seconds(delay))
                delay = min(delay * 2, 15)
            }
        }
    }

    static func describe(_ error: Error) -> String {
        if let e = error as? APIError { return e.message }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain {
            switch ns.code {
            case NSURLErrorNotConnectedToInternet: return "No internet"
            case NSURLErrorTimedOut: return "Relay timed out"
            case NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost: return "Mac unreachable"
            default: break
            }
        }
        return "Offline"
    }

    // MARK: data

    public func refresh() async throws {
        guard let client else { return }
        apply(try await client.state())
        if let f = focused { await loadFeed(f) }
    }

    public func loadFeed(_ id: String, reset: Bool = false) async {
        guard let client else { return }
        guard let page = try? await client.feed(id, thinking: showThinking) else { return }
        // Keep events streamed in while the page was loading; drop the rest, the page replaces them.
        if reset {
            let newest = page.events.map(\.seq).max() ?? -1
            feeds[id] = (feeds[id] ?? []).filter { $0.seq > newest }
        }
        merge(id, page.events)
        if reset || hasMore[id] == nil { hasMore[id] = page.hasMore }
        upsert(page.session)
    }

    public func loadOlder(_ id: String) async {
        guard let client, let first = feeds[id]?.first else { return }
        guard let page = try? await client.feed(id, before: first.seq, thinking: showThinking) else { return }
        merge(id, page.events)
        hasMore[id] = page.hasMore
    }

    public func topLevel(_ id: String) -> [FeedEvent] {
        (feeds[id] ?? []).filter { $0.parent == nil && (showThinking || $0.kind != .thinking) }
    }

    public func children(_ id: String, of toolId: String) -> [FeedEvent] {
        (feeds[id] ?? []).filter { $0.parent == toolId }
    }

    public func session(_ id: String) -> SessionSummary? { sessions.first { $0.id == id } }

    public func permission(for sessionId: String) -> PermissionRequest? {
        permissions.first { $0.sessionId == sessionId }
    }

    public var needsYouCount: Int { sessions.filter { $0.status == .needsYou || $0.status == .listening }.count }

    // MARK: actions (return an error message to show, or nil)

    public func decide(_ p: PermissionRequest, allow: Bool, always: Bool = false, message: String? = nil) async -> String? {
        guard let client else { return "Not paired" }
        do {
            try await client.decide(p.id, allow: allow, always: always, message: message)
            permissions.removeAll { $0.id == p.id }
            return nil
        } catch let e as APIError where e.status == 410 {
            permissions.removeAll { $0.id == p.id }
            return e.message
        } catch {
            return Self.describe(error)
        }
    }

    /// Returns (ok, message).
    public func reply(_ sessionId: String, text: String) async -> (Bool, String) {
        guard let client else { return (false, "Not paired") }
        do {
            let r = try await client.reply(sessionId, text: text)
            return (true, r == "delivered" ? "Sent — Claude is on it" : "Queued — Claude gets it when it pauses")
        } catch {
            return (false, Self.describe(error))
        }
    }

    public func stop(_ sessionId: String) async -> String? {
        guard let client else { return "Not paired" }
        do { try await client.stop(sessionId); return nil } catch { return Self.describe(error) }
    }

    public func setAway(_ mode: AwayMode) async -> String? {
        guard let client else { return "Not paired" }
        away?.mode = mode
        do { try await client.setAway(mode); return nil } catch { return Self.describe(error) }
    }

    // MARK: stream handling

    private let decoder = JSONDecoder()

    func handle(_ m: SSEMessage) {
        let data = Data(m.data.utf8)
        switch m.event {
        case "hello":
            if let s = try? decoder.decode(RelayState.self, from: data) {
                apply(s)
                // Events may have been missed while disconnected: reload the focused feed in full.
                if let f = focused { Task { await loadFeed(f, reset: true) } }
            }
        case "session":
            if let s = try? decoder.decode(SessionSummary.self, from: data) { upsert(s) }
        case "event":
            if let e = try? decoder.decode(StreamedEvent.self, from: data), feeds[e.sessionId] != nil {
                merge(e.sessionId, [e.event])
            }
        case "permission":
            if let p = try? decoder.decode(PermissionRequest.self, from: data) {
                let isNew = !permissions.contains { $0.id == p.id }
                if let i = permissions.firstIndex(where: { $0.id == p.id }) { permissions[i] = p } else { permissions.append(p) }
                if isNew { onSignal?(.permission(p)) }
            }
        case "permission_resolved":
            if let r = try? decoder.decode(ResolvedPermission.self, from: data) { permissions.removeAll { $0.id == r.id } }
        case "away":
            if let a = try? decoder.decode(AwayState.self, from: data) { away = a }
        default:
            break
        }
        lastUpdated = .now
        publishWidget()
    }

    func apply(_ s: RelayState) {
        sessions = s.sessions
        permissions = s.permissions
        away = s.away
        lastUpdated = .now
        publishWidget()
    }

    private func upsert(_ s: SessionSummary) {
        if let i = sessions.firstIndex(where: { $0.id == s.id }) {
            let old = sessions[i]
            sessions[i] = s
            if old.status == .running && s.status == .done { onSignal?(.finished(s)) }
            if old.status != .listening && s.status == .listening { onSignal?(.listening(s)) }
            if old.status != s.status { sessions.sort(by: Self.order) }
        } else {
            sessions.append(s)
            sessions.sort(by: Self.order)
        }
    }

    static func order(_ a: SessionSummary, _ b: SessionSummary) -> Bool {
        a.status.sortRank != b.status.sortRank ? a.status.sortRank < b.status.sortRank : a.lastActivity > b.lastActivity
    }

    private func merge(_ id: String, _ events: [FeedEvent]) {
        var list = feeds[id] ?? []
        var needsSort = false
        for e in events {
            if let i = list.firstIndex(where: { $0.id == e.id }) {
                list[i] = e
            } else {
                if let last = list.last, last.seq > e.seq { needsSort = true }
                list.append(e)
            }
        }
        if needsSort { list.sort { $0.seq < $1.seq } }
        feeds[id] = list
    }

    // MARK: persistence

    private static var cacheURL: URL { Shared.cacheURL.appending(path: "claudewatch-state.json") }

    private func loadCache() {
        guard let data = try? Data(contentsOf: Self.cacheURL), let s = try? decoder.decode(RelayState.self, from: data) else { return }
        sessions = s.sessions
        away = s.away
        // Permissions are never restored from cache: they may be long gone.
    }

    private func saveCache() {
        guard pairing != nil, let away else { return }
        let s = RelayState(away: away, sessions: sessions, permissions: [], serverTime: nil)
        try? JSONEncoder().encode(s).write(to: Self.cacheURL, options: .atomic)
    }

    private func publishWidget() {
        guard let away else { return }
        var snap = WidgetSnapshot(state: RelayState(away: away, sessions: sessions, permissions: permissions, serverTime: nil))
        snap.needsYou = max(snap.needsYou, Set(permissions.map(\.sessionId)).count)
        var cmp = snap; cmp.updated = lastWidget?.updated ?? snap.updated
        guard cmp != lastWidget else { return }
        lastWidget = snap
        snap.save()
        #if canImport(WidgetKit)
        WidgetCenter.shared.reloadAllTimelines()
        #endif
    }
}
