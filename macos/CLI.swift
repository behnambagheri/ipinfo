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
    var config = false
    var source: String?
    var timeout: Int?

    init(arguments: [String]) throws {
        var remaining = arguments[...]
        if remaining.first == "config" { config = true; remaining = remaining.dropFirst() }
        while let argument = remaining.first {
            remaining = remaining.dropFirst()
            switch argument {
            case "--json": json = true
            case "--help", "-h": help = true
            case "--version": version = true
            case "--source", "--timeout":
                guard let value = remaining.first else { throw CLIError.usage("\(argument) requires a value.") }
                remaining = remaining.dropFirst()
                if argument == "--source" { source = value }
                else {
                    guard let number = Int(value), (1...30).contains(number) else { throw CLIError.usage("Timeout must be a whole number from 1 to 30 seconds.") }
                    timeout = number
                }
            default:
                guard !argument.hasPrefix("-") else { throw CLIError.usage("Unknown option: \(argument)") }
                guard ip == nil else { throw CLIError.usage("Provide at most one IP address.") }
                guard let normalized = Diagnostic.canonicalIP(argument) else {
                    throw CLIError.usage("Provide a valid IPv4 or IPv6 address.")
                }
                ip = normalized
            }
        }
        _ = try Settings(source: source ?? "auto", timeout: timeout ?? 5).validated()
        if config && (ip != nil || json || help || version) { throw CLIError.usage("Use config with only --source and --timeout.") }
    }

    static let usage = """
    Usage: ipinfo [--json] [--source SOURCE] [--timeout SECONDS] [IP_ADDRESS]
           ipinfo config [--source SOURCE] [--timeout SECONDS]

    Auto checks ip.bea.sh and ip.behnam.pro concurrently.
    Matching results show only ip.bea.sh; differing results show both.
    With no address, each service detects your current public IP.

      ipinfo                          Show your current IP information
      ipinfo 1.2.3.4                  Look up an IPv4 address
      ipinfo 2606:4700:4700::1111      Look up an IPv6 address
      ipinfo --json 8.8.8.8           Print JSON for scripts
      ipinfo --help                   Show this help
      ipinfo --version                Show the installed version
      ipinfo --source ip.bea.sh        Use one service for this lookup
      ipinfo config --source auto     Save source for GUI and CLI
      ipinfo config --timeout 5       Save timeout (1–30 seconds)

    Sources: auto (default), ip.bea.sh, ip.behnam.pro.
    Default timeout: 5 seconds per service; Auto checks run concurrently.
    With no options, ipinfo config prints the current shared settings.

    Exit codes: 0 all selected checks succeeded, 1 a check failed, 2 invalid arguments.
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
