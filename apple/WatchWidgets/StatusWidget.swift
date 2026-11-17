import SwiftUI
import WidgetKit
import ClaudeWatchKit

@main
struct ClaudeWidgets: WidgetBundle {
    var body: some Widget { StatusWidget() }
}

struct StatusEntry: TimelineEntry {
    let date: Date
    let snap: WidgetSnapshot
    /// True when the relay fetch failed and the saved snapshot is missing or older than 15 minutes.
    var offline = false
    var relevance: TimelineEntryRelevance? {
        TimelineEntryRelevance(score: snap.needsYou > 0 ? 1 : snap.running > 0 ? 0.4 : 0)
    }
}

struct StatusProvider: TimelineProvider {
    func placeholder(in context: Context) -> StatusEntry {
        StatusEntry(date: .now, snap: WidgetSnapshot(needsYou: 1, running: 1, topProject: "claudewatch", topTitle: "Add the widget", topStatus: .needsYou, updated: .now))
    }

    func getSnapshot(in context: Context, completion: @escaping (StatusEntry) -> Void) {
        completion(StatusEntry(date: .now, snap: WidgetSnapshot.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StatusEntry>) -> Void) {
        Task {
            var snap = WidgetSnapshot.load()
            var fetched = false
            // The app pushes updates while open; when it isn't, fetch a fresh summary ourselves.
            if let p = PairingStore.load(), let state = try? await APIClient(pairing: p).state() {
                snap = WidgetSnapshot(state: state)
                snap.needsYou = max(snap.needsYou, Set(state.permissions.map(\.sessionId)).count)
                snap.save()
                fetched = true
            }
            let offline = !fetched && snap.updated < Date.now.addingTimeInterval(-15 * 60)
            let next = Date.now.addingTimeInterval(snap.needsYou + snap.running > 0 ? 5 * 60 : 15 * 60)
            completion(Timeline(entries: [StatusEntry(date: .now, snap: snap, offline: offline)], policy: .after(next)))
        }
    }
}

struct StatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ClaudeStatus", provider: StatusProvider()) { entry in
            StatusWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Claude Code")
        .description("Sessions that need you and what's running.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner])
    }
}

private let accent = Color(red: 0.85, green: 0.47, blue: 0.34)

struct StatusWidgetView: View {
    let entry: StatusEntry
    @Environment(\.widgetFamily) private var family

    private var snap: WidgetSnapshot { entry.snap }
    private var icon: String { entry.offline ? "wifi.slash" : snap.needsYou > 0 ? "hand.raised.fill" : snap.running > 0 ? "sparkle" : "checkmark" }
    private var tint: Color { entry.offline ? .gray : snap.needsYou > 0 ? .orange : snap.running > 0 ? accent : .green }
    private var headline: String {
        if entry.offline { return "Mac unreachable" }
        if snap.needsYou > 0 { return "\(snap.needsYou) need\(snap.needsYou == 1 ? "s" : "") you" }
        if snap.running > 0 { return "\(snap.running) working" }
        return "All quiet"
    }

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Image(systemName: icon).font(.system(size: 14, weight: .semibold)).foregroundStyle(tint)
                    if !entry.offline, snap.needsYou + snap.running > 0 {
                        Text("\(snap.needsYou > 0 ? snap.needsYou : snap.running)").font(.system(.title3, design: .rounded).weight(.bold))
                    }
                }
            }
            .widgetAccentable()
        case .accessoryCorner:
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(tint)
                .widgetLabel(headline)
        case .accessoryInline:
            Label("Claude: \(headline)", systemImage: icon)
        default:
            VStack(alignment: .leading, spacing: 1) {
                Label(headline, systemImage: icon)
                    .font(.headline)
                    .foregroundStyle(tint)
                    .widgetAccentable()
                if !entry.offline, let project = snap.topProject {
                    Text(project).font(.caption2.weight(.semibold))
                }
                if !entry.offline, let title = snap.topTitle {
                    Text(title).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
