import Foundation

enum CLIError: Error, LocalizedError {
    case usage(String)
    var errorDescription: String? {
        if case .usage(let message) = self { return message }
        return nil
    }
}

struct CLIOptions {
    var ip: String?
    var json = false
    var help = false
    var version = false

    init(arguments: [String]) throws {
        for argument in arguments {
            switch argument {
            case "--json": json = true
            case "--help", "-h": help = true
            case "--version": version = true
            default:
                guard !argument.hasPrefix("-") else { throw CLIError.usage("Unknown option: \(argument)") }
                guard ip == nil else { throw CLIError.usage("Provide at most one IP address.") }
                guard let normalized = Diagnostic.canonicalIP(argument) else {
                    throw CLIError.usage("Provide a valid IPv4 or IPv6 address.")
                }
                ip = normalized
            }
        }
    }

    static let usage = """
    Usage: ipinfo [--json] [IP_ADDRESS]

    Checks ip.bea.sh and ip.behnam.pro concurrently.
    Matching results show only ip.bea.sh; differing results show both.
    With no address, each service detects your current public IP.

      ipinfo                          Show your current IP information
      ipinfo 1.2.3.4                  Look up an IPv4 address
      ipinfo 2606:4700:4700::1111      Look up an IPv6 address
      ipinfo --json 8.8.8.8           Print JSON for scripts
      ipinfo --help                   Show this help
      ipinfo --version                Show the installed version

    Exit codes: 0 both checks succeeded, 1 a check failed, 2 invalid arguments.
    """
}

enum CLIOutput {
    // Prevent remote values from injecting terminal control sequences.
    static func safe(_ text: String) -> String {
        String(text.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : String($0) }.joined())
    }

    static func text(_ comparison: Comparison) -> String {
        var blocks: [String] = []
        for result in comparison.visible {
            var lines = [result.endpoint.host]
            if let data = result.diagnostic {
                lines.append("  IP: \(safe(data.ip))")
                for (key, title) in Diagnostic.fields {
                    if let value = data.values[key], value != .null, value != .string("") {
                        lines.append("  \(title): \(safe(value.text))")
                    }
                }
                if let host = data.values["hostname"], host != .null, host != .string("") {
                    lines.append("  Reverse DNS: \(safe(host.text))")
                }
            } else {
                lines.append("  Error: \(safe(result.error ?? "Lookup unavailable."))")
            }
            blocks.append(lines.joined(separator: "\n"))
        }
        return blocks.joined(separator: "\n\n")
    }

    static func json(_ comparison: Comparison) throws -> String {
        var output: [String: [String: JSONValue]] = [:]
        for result in comparison.visible {
            output[result.endpoint.host] = result.diagnostic?.values ?? ["error": .string(result.error ?? "Lookup unavailable.")]
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(output), as: UTF8.self)
    }

    static func exitCode(_ comparison: Comparison) -> Int32 {
        comparison.primary.diagnostic == nil || comparison.secondary.diagnostic == nil ? 1 : 0
    }
}
