#if canImport(WatchConnectivity)
import Foundation
import WatchConnectivity

/// Moves the pairing from the iPhone app to the watch app.
public final class PairingSync: NSObject, WCSessionDelegate, @unchecked Sendable {
    public static let shared = PairingSync()
    /// Called on the main queue when the counterpart sends a pairing (watch side).
    public var onReceive: ((Pairing) -> Void)?
    /// iPhone side: last pairing to deliver; re-sent once the session activates or the watch app appears.
    private var current: Pairing?

    public func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// iPhone side: push the pairing to the watch (delivered even if the watch app isn't running).
    public func send(_ p: Pairing) {
        current = p
        guard WCSession.isSupported(), let data = try? JSONEncoder().encode(p) else { return }
        let s = WCSession.default
        guard s.activationState == .activated else { return }
        #if os(iOS)
        guard s.isPaired, s.isWatchAppInstalled else { return }
        #endif
        try? s.updateApplicationContext(["pairing": data])
        if s.isReachable { s.sendMessage(["pairing": data], replyHandler: nil) }
    }

    public var watchStatus: String {
        guard WCSession.isSupported() else { return "Not supported" }
        let s = WCSession.default
        #if os(iOS)
        if !s.isPaired { return "No Apple Watch paired" }
        if !s.isWatchAppInstalled { return "Watch app not installed" }
        #endif
        return s.isReachable ? "Watch connected" : "Watch will sync when awake"
    }

    private func receive(_ dict: [String: Any]) {
        guard let data = dict["pairing"] as? Data, let p = try? JSONDecoder().decode(Pairing.self, from: data) else { return }
        DispatchQueue.main.async { self.onReceive?(p) }
    }

    public func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        #if os(iOS)
        if let p = current { send(p) }
        #else
        if !session.receivedApplicationContext.isEmpty { receive(session.receivedApplicationContext) }
        #endif
    }
    public func session(_ session: WCSession, didReceiveApplicationContext ctx: [String: Any]) { receive(ctx) }
    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) { receive(message) }

    #if os(iOS)
    public func sessionDidBecomeInactive(_ session: WCSession) {}
    public func sessionDidDeactivate(_ session: WCSession) { WCSession.default.activate() }
    public func sessionWatchStateDidChange(_ session: WCSession) { if let p = current { send(p) } }
    #endif
}
#endif
