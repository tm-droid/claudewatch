import SwiftUI
import ClaudeWatchKit

enum Theme {
    static let accent = Color(red: 0.85, green: 0.47, blue: 0.34) // warm terracotta
    static let bubble = accent.opacity(0.22)
    static let card = Color.white.opacity(0.08)
    static let mono = Font.system(.footnote, design: .monospaced)
    static let monoSmall = Font.system(size: 12, design: .monospaced)

    static func color(_ s: SessionStatus) -> Color {
        switch s {
        case .needsYou: .orange
        case .listening: .cyan
        case .running: accent
        case .done: .green
        case .idle: .gray
        }
    }
}

struct StatusDot: View {
    let status: SessionStatus
    var size: CGFloat = 9

    var body: some View {
        Circle()
            .fill(Theme.color(status))
            .frame(width: size, height: size)
            .overlay {
                if status == .running || status == .needsYou || status == .listening {
                    Circle()
                        .stroke(Theme.color(status), lineWidth: 2)
                        .phaseAnimator([false, true]) { v, on in
                            v.scaleEffect(on ? 2.2 : 1).opacity(on ? 0 : 0.8)
                        } animation: { _ in .easeOut(duration: 1.3) }
                }
            }
            .accessibilityLabel(status.label)
    }
}

struct StatusBadge: View {
    let status: SessionStatus
    var body: some View {
        HStack(spacing: 4) {
            StatusDot(status: status, size: 7)
            Text(status.label).font(.caption2.weight(.semibold)).foregroundStyle(Theme.color(status))
        }
    }
}

/// "Edit" + "pencil" style glyph for a tool, tinted by its status.
struct ToolGlyph: View {
    let icon: String
    var status: ToolInfo.Status = .ok
    var body: some View {
        Image(systemName: icon)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(status == .error ? .red : status == .running ? Theme.accent : .secondary)
            .symbolEffect(.pulse, isActive: status == .running)
            .frame(width: 18)
    }
}

extension Date {
    var shortAgo: String {
        let s = max(0, Int(-timeIntervalSinceNow))
        if s < 45 { return "now" }
        if s < 3600 { return "\(s / 60)m" }
        if s < 86400 { return "\(s / 3600)h" }
        return "\(s / 86400)d"
    }
}
