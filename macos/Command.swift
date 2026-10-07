import Foundation
import Darwin

@main
struct IPinfoCommand {
    static func main() async {
        do {
            let options = try CLIOptions(arguments: Array(CommandLine.arguments.dropFirst()))
            if options.help { print(CLIOptions.usage); return }
            if options.version { print("ipinfo \(IPinfoVersion.value)"); return }
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 12
            config.timeoutIntervalForResource = 15
            config.urlCache = nil
            let session = URLSession(configuration: config)
            let comparison = await Comparison.check(session: session, ip: options.ip)
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
