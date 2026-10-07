import Foundation
import Darwin

@main
struct IPinfoCommand {
    static func main() async {
        do {
            let options = try CLIOptions(arguments: Array(CommandLine.arguments.dropFirst()))
            if options.help { print(CLIOptions.usage); return }
            if options.version { print("ipinfo \(IPinfoVersion.value)"); return }
            var settings = try Settings.load()
            if let source = options.source { settings.source = source }
            if let timeout = options.timeout { settings.timeout = timeout }
            if options.config {
                if options.source != nil || options.timeout != nil { try settings.save() }
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                print(String(decoding: try encoder.encode(settings), as: UTF8.self))
                return
            }
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = Double(settings.timeout)
            config.timeoutIntervalForResource = Double(settings.timeout)
            config.urlCache = nil
            let session = URLSession(configuration: config)
            let comparison = await Comparison.check(session: session, ip: options.ip, settings: settings)
            session.invalidateAndCancel()
            print(try options.json ? CLIOutput.json(comparison) : CLIOutput.text(comparison))
            exit(CLIOutput.exitCode(comparison))
        } catch {
            let message = "ipinfo: \(CLIOutput.safe(error.localizedDescription))\nRun ipinfo --help for usage.\n"
            FileHandle.standardError.write(Data(message.utf8))
            exit(2)
        }
    }
}
