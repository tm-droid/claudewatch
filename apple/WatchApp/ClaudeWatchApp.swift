import SwiftUI
import WatchKit
import ClaudeWatchKit

@main
struct ClaudeWatchApp: App {
    @State private var model = AppModel()
    @State private var presented: PermissionRequest?
    @Environment(\.scenePhase) private var phase
    @AppStorage("showThinking") private var showThinking = false

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                if model.pairing == nil {
                    PairView()
                } else {
                    SessionsView()
                }
            }
            .environment(model)
            .tint(Theme.accent)
            .sheet(item: $presented) { p in
                NavigationStack { PermissionView(permission: p) }
                    .environment(model)
            }
            .onChange(of: model.permissions) { _, perms in
                // Close the sheet if the request got answered elsewhere.
                if let p = presented, !perms.contains(where: { $0.id == p.id }) { presented = nil }
            }
            .task {
                model.showThinking = showThinking
                model.onSignal = { signal in
                    switch signal {
                    case .permission(let p):
                        WKInterfaceDevice.current().play(.notification)
                        if p.remote, presented == nil { presented = p }
                    case .listening:
                        WKInterfaceDevice.current().play(.directionUp)
                    case .finished:
                        WKInterfaceDevice.current().play(.success)
                    }
                }
                // Developer install path: `devicectl device process launch … -- -cwPairLink '<link>'`
                // (launch arguments need developer access to this watch, unlike a tapped URL).
                if model.pairing == nil, let link = UserDefaults.standard.string(forKey: "cwPairLink"), let p = Pairing(link: link) {
                    model.pair(p)
                }
                PairingSync.shared.onReceive = { model.pair($0) }
                PairingSync.shared.onUnpair = { model.unpair() }
                PairingSync.shared.activate()
            }
            .onChange(of: showThinking) { _, v in model.showThinking = v }
            // No onOpenURL pairing here: a tapped link must never silently re-point the watch at another relay.
            // Pairing arrives from the iPhone app (which confirms it) or a link pasted by hand.
        }
        .onChange(of: phase, initial: true) { _, p in
            switch p {
            case .active: model.resume()
            case .background: model.pause()
            default: break
            }
        }
    }
}
