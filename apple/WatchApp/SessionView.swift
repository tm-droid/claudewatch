import SwiftUI
import WatchKit
import ClaudeWatchKit

struct SessionView: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @State private var replying = false
    @State private var confirmStop = false
    @State private var toast: String?
    @State private var loadingOlder = false

    private var session: SessionSummary? { model.session(sessionId) }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if model.hasMore[sessionId] == true {
                    Button {
                        loadingOlder = true
                        Task { await model.loadOlder(sessionId); loadingOlder = false }
                    } label: {
                        Label(loadingOlder ? "Loading…" : "Earlier messages", systemImage: "arrow.up.circle")
                            .font(.footnote)
                    }
                    .buttonStyle(.bordered)
                    .disabled(loadingOlder)
                }
                ForEach(model.topLevel(sessionId)) { e in
                    EventRow(event: e, sessionId: sessionId)
                }
                if let p = model.permission(for: sessionId) {
                    PermissionBanner(permission: p)
                }
                if let s = session { LiveFooter(session: s) }
            }
            .padding(.horizontal, 2)
        }
        .defaultScrollAnchor(.bottom)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .navigationTitle(session?.project ?? "Session")
        .toolbar {
            ToolbarItemGroup(placement: .bottomBar) {
                Button { replying = true } label: { Image(systemName: "mic.fill").foregroundStyle(.white) }
                    .accessibilityLabel("Reply")
                Spacer()
                Button(role: .destructive) { confirmStop = true } label: { Image(systemName: "stop.fill").foregroundStyle(.white) }
                    .accessibilityLabel("Stop")
                    .disabled(session?.status != .running && session?.status != .listening && session?.status != .needsYou)
            }
        }
        .sheet(isPresented: $replying) {
            ReplyView(sessionId: sessionId) { msg in show(msg) }
        }
        .confirmationDialog("Stop Claude in \(session?.project ?? "this session")?", isPresented: $confirmStop) {
            Button("Stop", role: .destructive) {
                Task {
                    let err = await model.stop(sessionId)
                    WKInterfaceDevice.current().play(err == nil ? .stop : .failure)
                    show(err ?? "Stopping at the next step")
                }
            }
        }
        .overlay(alignment: .top) {
            if let toast {
                Text(toast)
                    .font(.footnote.weight(.medium))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(.ultraThinMaterial, in: Capsule())
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .task {
            // Re-entering after the stream stopped carrying this session: load fresh instead of leaving a gap.
            let fresh = model.focused != sessionId
            model.focused = sessionId
            await model.loadFeed(sessionId, reset: fresh)
        }
    }

    private func show(_ text: String) {
        withAnimation { toast = text }
        Task {
            try? await Task.sleep(for: .seconds(2.5))
            withAnimation { if toast == text { toast = nil } }
        }
    }
}

/// "Running Bash · 12s", "Listening…", "Done".
struct LiveFooter: View {
    let session: SessionSummary

    var body: some View {
        Group {
            switch session.status {
            case .running:
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    HStack(spacing: 6) {
                        Image(systemName: session.currentTool?.icon ?? "sparkle")
                            .symbolEffect(.pulse)
                            .foregroundStyle(Theme.accent)
                        if let t = session.currentTool {
                            Text("\(t.name) · \(Self.elapsed(since: t.since, now: ctx.date))")
                        } else {
                            Text("Thinking…")
                        }
                    }
                }
            case .listening:
                Label("Listening for your reply", systemImage: "ear").foregroundStyle(.cyan)
            case .needsYou:
                Label("Waiting for permission", systemImage: "hand.raised.fill").foregroundStyle(.orange)
            case .done:
                Label("Done · \(session.lastActivityDate.shortAgo)", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            case .idle:
                Label("Idle", systemImage: "moon.zzz").foregroundStyle(.secondary)
            }
        }
        .font(.footnote.weight(.medium))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
        .accessibilityElement(children: .combine)
    }

    static func elapsed(since ms: Double, now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince(Date(ms: ms))))
        return s < 60 ? "\(s)s" : "\(s / 60)m \(s % 60)s"
    }
}

struct PermissionBanner: View {
    let permission: PermissionRequest

    var body: some View {
        NavigationLink {
            PermissionView(permission: permission)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Label("Permission needed", systemImage: "hand.raised.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
                Text("\(permission.tool): \(permission.summary)")
                    .font(.footnote)
                    .lineLimit(3)
                Text(permission.remote ? "Tap to review" : "Answer at your Mac")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.bordered)
        .tint(.orange)
    }
}
