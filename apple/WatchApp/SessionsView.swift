import SwiftUI
import ClaudeWatchKit

struct SessionsView: View {
    @Environment(AppModel.self) private var model

    private var attention: [SessionSummary] { model.sessions.filter { $0.status == .needsYou || $0.status == .listening } }
    private var rest: [SessionSummary] { model.sessions.filter { $0.status != .needsYou && $0.status != .listening } }

    var body: some View {
        List {
            Section {
                ConnectionHeader()
            }
            .listRowBackground(Color.clear)

            if !attention.isEmpty {
                Section("Needs you") {
                    ForEach(attention) { s in row(s) }
                }
            }
            Section(attention.isEmpty ? "Sessions" : "Other sessions") {
                if model.sessions.isEmpty {
                    emptyState
                } else {
                    ForEach(rest) { s in row(s) }
                }
            }
        }
        .navigationTitle("Claude")
        .navigationDestination(for: String.self) { id in SessionView(sessionId: id) }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink { SettingsView() } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Settings")
            }
        }
        .refreshable { try? await model.refresh() }
        .onAppear { model.focused = nil } // back on the list: stream summaries only
    }

    private func row(_ s: SessionSummary) -> some View {
        NavigationLink(value: s.id) { SessionRow(session: s, permission: model.permission(for: s.id)) }
    }

    @ViewBuilder private var emptyState: some View {
        if case .connecting = model.connection {
            HStack { ProgressView().frame(width: 20); Text("Connecting…").foregroundStyle(.secondary) }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text("No recent sessions").font(.headline)
                Text("Start Claude Code on your Mac and it shows up here.").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }
}

struct SessionRow: View {
    let session: SessionSummary
    let permission: PermissionRequest?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                StatusDot(status: session.status)
                Text(session.project)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Theme.color(session.status))
                    .lineLimit(1)
                Spacer(minLength: 0)
                Text(session.lastActivityDate.shortAgo)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Text(session.title)
                .font(.system(.headline, design: .rounded))
                .lineLimit(2)
            subtitle
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder private var subtitle: some View {
        if let p = permission {
            Label { Text("\(p.tool): \(p.summary)") } icon: { Image(systemName: "hand.raised.fill") }
                .foregroundStyle(.orange)
        } else if session.status == .listening {
            Label("Waiting for your reply", systemImage: "ear")
                .foregroundStyle(.cyan)
        } else if session.status == .running, let t = session.currentTool {
            Label { Text(t.summary.isEmpty ? t.name : "\(t.name) · \(t.summary)") } icon: { Image(systemName: t.icon) }
        } else {
            Text(session.preview)
        }
    }
}

struct ConnectionHeader: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(model.connection == .live ? Color.green : model.connection == .connecting ? .yellow : .red)
                .frame(width: 6, height: 6)
            Text(model.connection.label)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 4)
            if let away = model.away {
                NavigationLink { AwayModeView() } label: {
                    Label(away.effective ? "Away" : "At desk", systemImage: away.effective ? "figure.walk" : "desktopcomputer")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(Capsule().fill(away.effective ? Theme.accent.opacity(0.3) : Theme.card))
                }
                .buttonStyle(.plain)
                .accessibilityHint("Away mode lets Claude wait for your watch")
            }
        }
    }
}

struct AwayModeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            ForEach(AwayMode.allCases) { m in
                Button {
                    Task { _ = await model.setAway(m); dismiss() }
                } label: {
                    HStack {
                        Label(m.label, systemImage: Self.icon(m))
                        Spacer()
                        if model.away?.mode == m { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
                    }
                }
            }
            Text("Away: Claude waits for your watch on permissions and when it finishes. Auto turns on after 3 idle minutes on the Mac.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .listRowBackground(Color.clear)
        }
        .navigationTitle("Away mode")
    }

    static func icon(_ m: AwayMode) -> String {
        switch m { case .auto: "wand.and.stars"; case .away: "figure.walk"; case .desk: "desktopcomputer" }
    }
}
