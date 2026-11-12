import Foundation
import Testing
@testable import ClaudeWatchKit

private func fixture(_ name: String) throws -> Data {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try Data(contentsOf: url)
}

@Test func decodesRelayState() throws {
    let s = try JSONDecoder().decode(RelayState.self, from: fixture("state"))
    let first = try #require(s.sessions.first)
    #expect(first.title == "Login fix")
    #expect(first.project == "app")
    #expect(s.permissions.first?.remote == true)
    #expect(s.permissions.first?.canAlwaysAllow == false)
}

@Test func decodesFeedWithToolsAndSubagents() throws {
    let f = try JSONDecoder().decode(FeedPage.self, from: fixture("feed"))
    let bash = try #require(f.events.first { $0.id == "toolu_1" })
    #expect(bash.tool?.status == .error)
    #expect(bash.tool?.result == "1 failing")
    #expect(f.events.first { $0.id == "toolu_3" }?.tool?.children == 2)
    #expect(f.events.contains { $0.parent == "toolu_3" })
    #expect(f.events.contains { $0.kind == .thinking })
}

@Test func sseParser() {
    var p = SSEParser()
    var out: [SSEMessage] = []
    for l in ["retry: 2000", "event: hello", "data: {\"a\":1}", "", ": ping 1", "", "data: x", "data: y\r", ""] {
        if let m = p.feed(l) { out.append(m) }
    }
    #expect(out == [SSEMessage(event: "hello", data: "{\"a\":1}"), SSEMessage(event: "message", data: "x\ny")])
}

@Test func pairingLink() {
    let p = Pairing(link: "claudewatch://pair?u=https%3A%2F%2Fmac.tail1.ts.net&t=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG")
    #expect(p?.url.absoluteString == "https://mac.tail1.ts.net")
    #expect(Pairing(link: "claudewatch://pair?u=ftp%3A%2F%2Fx&t=abcdefghijklmnopqrstuvwxyz") == nil)
    #expect(Pairing(link: "https://evil.example") == nil)
}

@MainActor @Test func modelMergesStreamAndSignalsPermissions() throws {
    let m = AppModel(pairing: nil)
    var signals: [String] = []
    m.onSignal = { s in if case .permission(let p) = s { signals.append(p.id) } }
    let state = String(decoding: try fixture("state"), as: UTF8.self).replacingOccurrences(of: "\n", with: "")
    m.handle(SSEMessage(event: "hello", data: state))
    #expect(m.sessions.count == 1)
    m.handle(SSEMessage(event: "permission", data: #"{"id":"p2","sessionId":"s1","tool":"Bash","icon":"terminal","summary":"x","detail":"","ts":1,"remote":true,"suggestions":[{}]}"#))
    #expect(signals == ["p2"])
    #expect(m.permission(for: "s1") != nil)
    m.handle(SSEMessage(event: "permission_resolved", data: #"{"id":"p2","sessionId":"s1","outcome":"allow"}"#))
    m.handle(SSEMessage(event: "permission_resolved", data: #"{"id":"p1","sessionId":"s1","outcome":"allow"}"#))
    #expect(m.permissions.isEmpty)
}
