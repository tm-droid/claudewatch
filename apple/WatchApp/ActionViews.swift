import SwiftUI
import WatchKit
import ClaudeWatchKit

struct PermissionView: View {
    let permission: PermissionRequest
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    ToolGlyph(icon: permission.icon, status: .running)
                    Text(permission.tool).font(.headline)
                    Spacer(minLength: 0)
                }
                if let p = permission.project {
                    Text(p).font(.caption2.weight(.semibold)).foregroundStyle(Theme.accent)
                }
                Text(permission.summary).font(.footnote)
                // Always show the full command/path before Allow.
                if !permission.detail.isEmpty, permission.detail != permission.summary {
                    Text(permission.detail)
                        .font(Theme.monoSmall)
                        .padding(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 8))
                }

                if permission.remote {
                    Button { decide(allow: true) } label: { Label("Allow", systemImage: "checkmark") }
                        .tint(.green)
                    if permission.canAlwaysAllow {
                        Button { decide(allow: true, always: true) } label: { Label("Always allow", systemImage: "checkmark.seal") }
                    }
                    Button(role: .destructive) { decide(allow: false) } label: { Label("Deny", systemImage: "xmark") }
                    TextFieldLink(prompt: Text("Tell Claude what to do instead")) {
                        Label("Deny with note", systemImage: "text.bubble")
                    } onSubmit: { note in
                        decide(allow: false, message: note)
                    }
                } else {
                    Label {
                        Text("Your Mac is in use, so Claude asked there. Set Away mode to answer from your watch.")
                    } icon: {
                        Image(systemName: "desktopcomputer")
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
                if let error {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
            }
            .disabled(busy)
        }
        .navigationTitle("Permission")
    }

    private func decide(allow: Bool, always: Bool = false, message: String? = nil) {
        busy = true
        Task {
            let err = await model.decide(permission, allow: allow, always: always, message: message)
            busy = false
            if let err {
                WKInterfaceDevice.current().play(.failure)
                error = err
            } else {
                WKInterfaceDevice.current().play(allow ? .success : .click)
                dismiss()
            }
        }
    }
}

struct ReplyView: View {
    let sessionId: String
    let onResult: (String) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var error: String?

    static let quick = ["Continue", "Yes", "Run the tests", "Commit it"]

    var body: some View {
        List {
            if let s = model.session(sessionId), !s.canReply {
                Text("Claude isn't working in this session now. Replies land while it's working or listening.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            TextFieldLink(prompt: Text("Message Claude")) {
                Label("Dictate or type", systemImage: "mic.fill")
            } onSubmit: { send($0) }
            Section("Quick replies") {
                ForEach(Self.quick, id: \.self) { q in
                    Button(q) { send(q) }
                }
            }
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        }
        .disabled(busy)
        .navigationTitle("Reply")
    }

    private func send(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        busy = true
        Task {
            let (ok, msg) = await model.reply(sessionId, text: t)
            busy = false
            if ok {
                WKInterfaceDevice.current().play(.success)
                onResult(msg)
                dismiss()
            } else {
                WKInterfaceDevice.current().play(.failure)
                error = msg
            }
        }
    }
}

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("showThinking") private var showThinking = false
    @State private var confirmUnpair = false

    var body: some View {
        List {
            Section("Relay") {
                LabeledContent("Mac", value: model.pairing?.host ?? "—")
                LabeledContent("Status", value: model.connection.label)
                if let t = model.lastUpdated {
                    LabeledContent("Updated") { Text(t, style: .relative) }
                }
            }
            if let away = model.away {
                Section {
                    Picker("Away mode", selection: Binding(get: { away.mode }, set: { m in Task { _ = await model.setAway(m) } })) {
                        ForEach(AwayMode.allCases) { Text($0.label).tag($0) }
                    }
                } footer: {
                    Text("When away, Claude waits up to 9 minutes for your watch on permissions and when it finishes. Auto switches after 3 idle minutes on the Mac.")
                }
            }
            Section {
                Toggle("Show thinking", isOn: $showThinking)
            }
            Section {
                Button("Unpair", role: .destructive) { confirmUnpair = true }
            } footer: {
                Text("To pair again, use ClaudeWatch on your iPhone.")
            }
        }
        .navigationTitle("Settings")
        .confirmationDialog("Unpair from \(model.pairing?.host ?? "this Mac")?", isPresented: $confirmUnpair) {
            Button("Unpair", role: .destructive) { model.unpair() }
        }
    }
}

struct PairView: View {
    @Environment(AppModel.self) private var model
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Image(systemName: "applewatch.radiowaves.left.and.right")
                    .font(.largeTitle)
                    .foregroundStyle(Theme.accent)
                    .frame(maxWidth: .infinity)
                Text("Pair with your Mac").font(.headline)
                Text("On your Mac run `claudewatch pair`, scan the code with your iPhone, and ClaudeWatch on the iPhone sends it here.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                TextFieldLink(prompt: Text("claudewatch://pair?…")) {
                    Label("Paste link", systemImage: "link")
                } onSubmit: { text in
                    if let p = Pairing(link: text.trimmingCharacters(in: .whitespacesAndNewlines)) {
                        model.pair(p)
                    } else {
                        error = "That isn't a ClaudeWatch pairing link."
                    }
                }
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            }
        }
        .navigationTitle("ClaudeWatch")
    }
}
