import SwiftUI
import ClaudeWatchKit

struct EventRow: View {
    let event: FeedEvent
    let sessionId: String

    var body: some View {
        switch event.kind {
        case .prompt:
            PromptBubble(text: event.text ?? "", fromWatch: event.via == "watch")
        case .text:
            MarkdownText(text: event.text ?? "")
        case .thinking:
            ThinkingRow(text: event.text ?? "")
        case .tool:
            if let tool = event.tool {
                if (tool.children ?? 0) > 0 {
                    NavigationLink { SubagentView(sessionId: sessionId, event: event) } label: { ToolRow(tool: tool, isGroup: true) }
                        .buttonStyle(.plain)
                } else {
                    NavigationLink { ToolDetailView(event: event) } label: { ToolRow(tool: tool) }
                        .buttonStyle(.plain)
                }
            }
        case .unknown:
            EmptyView()
        }
    }
}

struct PromptBubble: View {
    let text: String
    let fromWatch: Bool

    var body: some View {
        HStack {
            Spacer(minLength: 16)
            VStack(alignment: .trailing, spacing: 2) {
                if fromWatch {
                    Label("from watch", systemImage: "applewatch")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Text(text)
                    .font(.footnote)
                    .lineLimit(12)
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(Theme.bubble, in: RoundedRectangle(cornerRadius: 14))
        }
        .accessibilityLabel("You: \(text)")
    }
}

struct ToolRow: View {
    let tool: ToolInfo
    var isGroup = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            ToolGlyph(icon: tool.icon, status: tool.status)
            VStack(alignment: .leading, spacing: 1) {
                Text(tool.name)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(tool.status == .error ? .red : .secondary)
                Text(tool.summary.isEmpty ? tool.name : tool.summary)
                    .font(Theme.monoSmall)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            if isGroup {
                Text("\(tool.children ?? 0)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 5).padding(.horizontal, 7)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 9))
        .contentShape(Rectangle())
    }
}

struct ThinkingRow: View {
    let text: String
    @State private var expanded = false

    var body: some View {
        Button { withAnimation { expanded.toggle() } } label: {
            Label { Text(text).lineLimit(expanded ? nil : 3) } icon: { Image(systemName: "brain") }
                .font(.caption)
                .italic()
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
    }
}

struct MarkdownText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let s):
                    Text(Self.inline(s))
                case .heading(let s):
                    Text(Self.inline(s)).font(.headline)
                case .bullet(let s):
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text("•").foregroundStyle(Theme.accent)
                        Text(Self.inline(s))
                    }
                case .code(let s):
                    Text(s)
                        .font(Theme.monoSmall)
                        .padding(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .font(.footnote)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}

struct ToolDetailView: View {
    let event: FeedEvent

    var body: some View {
        let tool = event.tool
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    ToolGlyph(icon: tool?.icon ?? "wrench", status: tool?.status ?? .ok)
                    Text(tool?.name ?? "Tool").font(.headline)
                    Spacer()
                    Text(event.date, style: .time).font(.caption2).foregroundStyle(.secondary)
                }
                if let d = tool?.detail, !d.isEmpty {
                    Text(d)
                        .font(Theme.monoSmall)
                        .padding(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 8))
                }
                switch tool?.status {
                case .running:
                    Label("Running…", systemImage: "hourglass").font(.footnote).foregroundStyle(Theme.accent)
                case .error:
                    section("Error", tool?.result, color: .red)
                default:
                    section("Output", tool?.result, color: .secondary)
                }
            }
        }
        .navigationTitle(tool?.name ?? "Tool")
    }

    @ViewBuilder private func section(_ title: String, _ body: String?, color: Color) -> some View {
        if let body, !body.isEmpty {
            Text(title).font(.caption2.weight(.semibold)).foregroundStyle(color)
            Text(body).font(Theme.monoSmall).foregroundStyle(color == .red ? .red : .primary)
        }
    }
}

/// Everything a subagent (Agent/Task tool) did, grouped under its call.
struct SubagentView: View {
    let sessionId: String
    let event: FeedEvent
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if let s = event.tool?.summary { Text(s).font(.caption).foregroundStyle(.secondary) }
                ForEach(model.children(sessionId, of: event.id)) { e in
                    EventRow(event: e, sessionId: sessionId)
                }
                if let r = event.tool?.result, !r.isEmpty {
                    Divider()
                    Text("Result").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    MarkdownText(text: r)
                }
            }
        }
        .navigationTitle("Subagent")
    }
}
