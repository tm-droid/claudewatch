import Foundation

/// Mirrors the relay's JSON (see relay/src/store.js). Times are Unix milliseconds.

public enum SessionStatus: String, Codable, Sendable, CaseIterable {
    case needsYou = "needs_you", listening, running, done, idle

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionStatus(rawValue: raw) ?? .idle
    }

    public var label: String {
        switch self {
        case .needsYou: "Needs you"
        case .listening: "Listening"
        case .running: "Working"
        case .done: "Done"
        case .idle: "Idle"
        }
    }

    public var sortRank: Int { SessionStatus.allCases.firstIndex(of: self)! }
}

public struct CurrentTool: Codable, Hashable, Sendable {
    public var name: String
    public var icon: String
    public var summary: String
    public var since: Double
}

public struct SessionSummary: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var project: String
    public var cwd: String
    public var title: String
    public var status: SessionStatus
    public var lastActivity: Double
    public var preview: String
    public var currentTool: CurrentTool?
    public var canReply: Bool
    public var stopRequested: Bool
    public var queuedReplies: Int

    public var lastActivityDate: Date { Date(ms: lastActivity) }
}

public struct ToolInfo: Codable, Hashable, Sendable {
    public enum Status: String, Codable, Sendable { case running, ok, error }
    public var name: String
    public var icon: String
    public var summary: String
    public var detail: String
    public var status: Status
    public var result: String?
    public var children: Int?
}

public struct FeedEvent: Codable, Hashable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable { case prompt, text, tool, thinking, unknown
        public init(from decoder: Decoder) throws {
            self = Kind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }
    public var id: String
    public var seq: Int
    public var ts: Double
    public var kind: Kind
    public var text: String?
    public var parent: String?
    public var via: String?
    public var tool: ToolInfo?

    public var date: Date { Date(ms: ts) }
}

public struct PermissionRequest: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var sessionId: String
    public var project: String?
    public var tool: String
    public var icon: String
    public var summary: String
    public var detail: String
    public var ts: Double
    /// true: Claude is waiting for the watch. false: the Mac is showing its own dialog.
    public var remote: Bool
    public var canAlwaysAllow: Bool

    enum CodingKeys: String, CodingKey { case id, sessionId, project, tool, icon, summary, detail, ts, remote, suggestions }

    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        project = try c.decodeIfPresent(String.self, forKey: .project)
        tool = try c.decode(String.self, forKey: .tool)
        icon = try c.decode(String.self, forKey: .icon)
        summary = try c.decode(String.self, forKey: .summary)
        detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
        ts = try c.decode(Double.self, forKey: .ts)
        remote = try c.decode(Bool.self, forKey: .remote)
        canAlwaysAllow = ((try? c.decode([JSONAny].self, forKey: .suggestions)) ?? []).isEmpty == false
    }

    public func encode(to e: Encoder) throws {
        var c = e.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(sessionId, forKey: .sessionId)
        try c.encodeIfPresent(project, forKey: .project); try c.encode(tool, forKey: .tool)
        try c.encode(icon, forKey: .icon); try c.encode(summary, forKey: .summary)
        try c.encode(detail, forKey: .detail); try c.encode(ts, forKey: .ts); try c.encode(remote, forKey: .remote)
        try c.encode(canAlwaysAllow ? [JSONAny()] : [], forKey: .suggestions)
    }
}

/// Swallows any JSON value; only used to count array elements.
struct JSONAny: Codable, Hashable, Sendable {
    init() {}
    init(from decoder: Decoder) throws {}
    func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encodeNil() }
}

public enum AwayMode: String, Codable, Sendable, CaseIterable, Identifiable {
    case auto, away, desk
    public var id: String { rawValue }
    public var label: String {
        switch self { case .auto: "Auto"; case .away: "Away"; case .desk: "At desk" }
    }
}

public struct AwayState: Codable, Hashable, Sendable {
    public var mode: AwayMode
    public var effective: Bool
    public var idleSeconds: Double?
}

public struct RelayState: Codable, Sendable {
    public var away: AwayState
    public var sessions: [SessionSummary]
    public var permissions: [PermissionRequest]
    public var serverTime: Double?
}

public struct FeedPage: Codable, Sendable {
    public var session: SessionSummary
    public var events: [FeedEvent]
    public var hasMore: Bool
}

public struct ResolvedPermission: Codable, Sendable {
    public var id: String
    public var sessionId: String
    public var outcome: String
}

public struct StreamedEvent: Codable, Sendable {
    public var sessionId: String
    public var event: FeedEvent
}

public extension Date {
    init(ms: Double) { self.init(timeIntervalSince1970: ms / 1000) }
}
