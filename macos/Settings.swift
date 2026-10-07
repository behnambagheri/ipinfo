import Foundation

struct Settings: Codable {
    var source = "auto"
    var timeout = 5
    static var file: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/IPinfo/settings.json")
    }
    func validated() throws -> Settings {
        guard ["auto", "ip.bea.sh", "ip.behnam.pro"].contains(source) else {
            throw NSError(domain: "IPinfo", code: 2, userInfo: [NSLocalizedDescriptionKey: "Source must be auto, ip.bea.sh, or ip.behnam.pro."])
        }
        guard (1...30).contains(timeout) else {
            throw NSError(domain: "IPinfo", code: 2, userInfo: [NSLocalizedDescriptionKey: "Timeout must be a whole number from 1 to 30 seconds."])
        }
        return self
    }
    static func load(from url: URL = file) throws -> Settings {
        guard FileManager.default.fileExists(atPath: url.path) else { return Settings() }
        return try JSONDecoder().decode(Settings.self, from: Data(contentsOf: url)).validated()
    }
    func save(to url: URL = file) throws {
        let value = try validated()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(value).write(to: url, options: .atomic)
    }
}
