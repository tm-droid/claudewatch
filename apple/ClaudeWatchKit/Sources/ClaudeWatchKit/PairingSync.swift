#if canImport(WatchConnectivity)
import Foundation
import WatchConnectivity

/// Moves the pairing from the iPhone app to the watch app.
public final class PairingSync: NSObject, WCSessionDelegate, @unchecked Sendable {
    public static let shared = PairingSync()
    /// Posted on the main queue when activation, pairing, install or reachability state changes.
    public static let didChange = Notification.Name("PairingSync.didChange")
    /// Called on the main queue when the counterpart sends a pairing (watch side).
    public var onReceive: ((Pairing) -> Void)?
    /// Called on the main queue when the iPhone unpairs (watch side).
    public var onUnpair: (() -> Void)?
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
        // "at" makes every send differ, so the watch can ignore replays of old contexts.
        let payload: [String: Any] = ["pairing": data, "at": Date().timeIntervalSince1970]
        try? s.updateApplicationContext(payload)
        if s.isReachable { s.sendMessage(payload, replyHandler: nil) }
    }

    #if os(iOS)
    /// iPhone side: tell the watch to forget its pairing.
    public func clear() {
        current = nil
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        guard s.activationState == .activated, s.isPaired, s.isWatchAppInstalled else { return }
        let payload: [String: Any] = ["unpair": true, "at": Date().timeIntervalSince1970]
        try? s.updateApplicationContext(payload)
        if s.isReachable { s.sendMessage(payload, replyHandler: nil) }
    }
    #endif

    public var watchStatus: String {
        guard WCSession.isSupported() else { return "Not supported" }
        let s = WCSession.default
        // isPaired/isWatchAppInstalled read false until activation completes.
        if s.activationState != .activated { return "Connecting…" }
        #if os(iOS)
        if !s.isPaired { return "No Apple Watch paired" }
        if !s.isWatchAppInstalled { return "Watch app not installed" }
        #endif
        return s.isReachable ? "Watch connected" : "Watch will sync when awake"
    }

    private func receive(_ dict: [String: Any]) {
        guard let at = dict["at"] as? Double else { return }
        let pairing = (dict["pairing"] as? Data).flatMap { try? JSONDecoder().decode(Pairing.self, from: $0) }
        let unpair = dict["unpair"] as? Bool == true
        guard pairing != nil || unpair else { return }
        DispatchQueue.main.async {
            // The same payload arrives as context and message, and the context is replayed at every launch.
            let key = "PairingSync.lastAt"
            guard at > UserDefaults.standard.double(forKey: key) else { return }
            UserDefaults.standard.set(at, forKey: key)
            if let pairing { self.onReceive?(pairing) } else { self.onUnpair?() }
        }
    }

    private func changed() {
        DispatchQueue.main.async { NotificationCenter.default.post(name: Self.didChange, object: nil) }
    }

    public func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        changed()
        #if os(iOS)
        if let p = current { send(p) }
        #else
        if !session.receivedApplicationContext.isEmpty { receive(session.receivedApplicationContext) }
        #endif
    }
    public func session(_ session: WCSession, didReceiveApplicationContext ctx: [String: Any]) { receive(ctx) }
    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) { receive(message) }
    public func sessionReachabilityDidChange(_ session: WCSession) { changed() }

    #if os(iOS)
    public func sessionDidBecomeInactive(_ session: WCSession) {}
    public func sessionDidDeactivate(_ session: WCSession) { WCSession.default.activate() }
    public func sessionWatchStateDidChange(_ session: WCSession) {
        changed()
        if let p = current { send(p) }
    }
    #endif
}
#endif
