import SwiftUI
import UIKit
import ClaudeWatchKit

private let accent = Color(red: 0.85, green: 0.47, blue: 0.34)

@main
struct ClaudeWatchPhoneApp: App {
    @State private var model = AppModel()
    /// A pairing link that arrived from outside (Camera QR scan or paste) waiting for the user's OK.
    @State private var pending: Pairing?
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                if model.pairing == nil { PhonePairView(pending: $pending) } else { PhoneHomeView() }
            }
            .environment(model)
            .tint(accent)
            .onOpenURL { url in
                // Never re-pair silently from a link: show the host and ask first.
                if let p = Pairing(link: url.absoluteString) { pending = p }
            }
            .alert("Pair with this Mac?", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }), presenting: pending) { p in
                Button("Pair") {
                    model.pair(p)
                    PairingSync.shared.send(p)
                }
                Button("Cancel", role: .cancel) {}
            } message: { p in
                if let current = model.pairing, current.host != p.host {
                    Text("This replaces your pairing with \(current.host). New relay: \(p.host). Only pair with a code from your own Mac.")
                } else {
                    Text("Relay: \(p.host). Only pair with a code from your own Mac.")
                }
            }
            .task {
                PairingSync.shared.activate()
                if let p = model.pairing { PairingSync.shared.send(p) }
            }
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

struct PhonePairView: View {
    @Binding var pending: Pairing?
    @State private var error: String?

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Image(systemName: "applewatch.radiowaves.left.and.right")
                        .font(.system(size: 44))
                        .foregroundStyle(accent)
                    Text("Claude Code on your wrist").font(.title2.bold())
                    Text("Follow every Claude Code session from your Apple Watch, approve permissions, reply and stop — from anywhere.")
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 8)
            }
            Section("Pair") {
                Label("On your Mac run `claudewatch pair`", systemImage: "1.circle")
                Label("Scan the QR code with the Camera app", systemImage: "2.circle")
                Label("Confirm here, and the watch gets paired too", systemImage: "3.circle")
            }
            Section {
                Button {
                    if let s = UIPasteboard.general.string, let p = Pairing(link: s.trimmingCharacters(in: .whitespacesAndNewlines)) {
                        pending = p
                    } else {
                        error = "The clipboard doesn't hold a ClaudeWatch pairing link."
                    }
                } label: {
                    Label("Paste pairing link", systemImage: "doc.on.clipboard")
                }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
            }
        }
        .navigationTitle("ClaudeWatch")
    }
}

struct PhoneHomeView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmUnpair = false
    @State private var watchStatus = PairingSync.shared.watchStatus
    @State private var message: String?

    var body: some View {
        List {
            Section("Relay") {
                LabeledContent("Mac", value: model.pairing?.host ?? "—")
                LabeledContent("Status") {
                    HStack(spacing: 6) {
                        Circle().fill(model.connection == .live ? .green : model.connection == .connecting ? .yellow : .red).frame(width: 8, height: 8)
                        Text(model.connection.label)
                    }
                }
                if let away = model.away {
                    Picker("Away mode", selection: Binding(get: { away.mode }, set: { m in Task { _ = await model.setAway(m) } })) {
                        ForEach(AwayMode.allCases) { Text($0.label).tag($0) }
                    }
                }
            }
            Section("Apple Watch") {
                LabeledContent("Watch", value: watchStatus)
                Button("Send pairing to watch") {
                    if let p = model.pairing { PairingSync.shared.send(p) }
                    watchStatus = PairingSync.shared.watchStatus
                }
            }
            if !model.permissions.isEmpty {
                Section("Needs you") {
                    ForEach(model.permissions) { p in
                        VStack(alignment: .leading, spacing: 6) {
                            Text([p.project ?? "", p.tool].filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption.weight(.semibold)).foregroundStyle(.orange)
                            Text(p.detail.isEmpty ? p.summary : p.detail).font(.system(.footnote, design: .monospaced))
                            if p.remote {
                                HStack {
                                    Button("Allow") { decide(p, true) }.buttonStyle(.borderedProminent).tint(.green)
                                    Button("Deny", role: .destructive) { decide(p, false) }.buttonStyle(.bordered)
                                }
                            } else {
                                Text("Answer at your Mac").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            Section("Sessions") {
                if model.sessions.isEmpty { Text("No recent sessions").foregroundStyle(.secondary) }
                ForEach(model.sessions) { s in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(s.project).font(.caption.weight(.semibold)).foregroundStyle(accent)
                            Spacer()
                            Text(s.status.label).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(s.title).font(.subheadline).lineLimit(1)
                        Text(s.preview).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
            }
            if let message { Section { Text(message).font(.footnote) } }
            Section {
                Button("Unpair", role: .destructive) { confirmUnpair = true }
            }
        }
        .navigationTitle("ClaudeWatch")
        .refreshable { try? await model.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: PairingSync.didChange)) { _ in
            watchStatus = PairingSync.shared.watchStatus
        }
        .confirmationDialog("Unpair this iPhone?", isPresented: $confirmUnpair) {
            Button("Unpair", role: .destructive) { model.unpair(); PairingSync.shared.clear() }
        }
    }

    private func decide(_ p: PermissionRequest, _ allow: Bool) {
        Task { message = await model.decide(p, allow: allow) }
    }
}
