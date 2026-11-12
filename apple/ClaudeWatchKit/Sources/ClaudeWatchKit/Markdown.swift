import Foundation

/// Block-level split of Claude's Markdown, small enough for a watch. Inline styling is left to AttributedString.
public enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(String)
    case bullet(String)
    case code(String)

    public static func parse(_ text: String) -> [MarkdownBlock] {
        var out: [MarkdownBlock] = []
        var para: [String] = []
        var code: [String]?

        func flush() {
            if !para.isEmpty { out.append(.paragraph(para.joined(separator: "\n"))); para = [] }
        }

        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                if let c = code {
                    out.append(.code(c.joined(separator: "\n")))
                    code = nil
                } else {
                    flush()
                    code = []
                }
                continue
            }
            if code != nil { code!.append(raw); continue }

            if line.isEmpty {
                flush()
            } else if line.hasPrefix("#") {
                flush()
                out.append(.heading(String(line.drop(while: { $0 == "#" })).trimmingCharacters(in: .whitespaces)))
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("• ") {
                flush()
                out.append(.bullet(String(line.dropFirst(2))))
            } else {
                para.append(line)
            }
        }
        if let c = code, !c.isEmpty { out.append(.code(c.joined(separator: "\n"))) } // unterminated fence (still streaming)
        flush()
        return out
    }
}
