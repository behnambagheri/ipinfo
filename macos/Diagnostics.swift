import Foundation
import Darwin

enum JSONValue: Codable, Equatable, Sendable {
    case string(String), number(Double), bool(Bool), null

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let bool = try? value.decode(Bool.self) { self = .bool(bool) }
        else if let number = try? value.decode(Double.self) { self = .number(number) }
        else { self = .string(try value.decode(String.self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var text: String {
        switch self {
        case .string(let value): return value
        case .number(let value): return value.formatted(.number.grouping(.never).precision(.fractionLength(0...10)))
        case .bool(let value): return value ? "Yes" : "No"
        case .null: return "Unavailable"
        }
    }
}

struct ServiceEndpoint: Sendable {
    let host: String
    var url: URL { URL(string: "https://\(host)/json")! }
    func lookupURL(ip: String?) -> URL {
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        if let ip { parts.queryItems = [URLQueryItem(name: "ip", value: ip)] }
        return parts.url!
    }
    static let primary = ServiceEndpoint(host: "ip.bea.sh")
    static let secondary = ServiceEndpoint(host: "ip.behnam.pro")
}

struct Diagnostic: Sendable {
    let values: [String: JSONValue]
    // These fields describe the diagnostic result on both deployments. Source,
    // database release, User-Agent, and container-only reverse DNS are metadata.
    static let fields: [(String, String)] = [
        ("country", "Country"), ("country_iso", "Country code"), ("country_ir", "In Iran"),
        ("city", "City"), ("region_name", "Region"), ("region_code", "Region code"),
        ("postal_code", "Postal code"), ("timezone", "Time zone"),
        ("latitude", "Latitude"), ("longitude", "Longitude"),
        ("asn", "ASN"), ("asn_org", "Network")
    ]

    var ip: String {
        if case .string(let value) = values["ip"] { return value }
        return "Unavailable"
    }

    static func canonicalIP(_ value: String) -> String? {
        for family in [AF_INET, AF_INET6] {
            var bytes = [UInt8](repeating: 0, count: 16)
            guard inet_pton(family, value, &bytes) == 1 else { continue }
            var output = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
            guard inet_ntop(family, &bytes, &output, socklen_t(output.count)) != nil else { continue }
            return String(cString: output)
        }
        return nil
    }

    init(data: Data) throws {
        guard data.count <= 65536 else { throw CheckError.invalidResponse }
        values = try JSONDecoder().decode([String: JSONValue].self, from: data)
        guard case .string(let ip) = values["ip"], Self.canonicalIP(ip) != nil,
              values["error"] == nil else { throw CheckError.invalidResponse }
    }

    var comparison: [String: JSONValue] {
        var result: [String: JSONValue] = ["ip": .string(Self.canonicalIP(ip)!)]
        for (key, _) in Self.fields {
            guard let value = values[key], value != .null, value != .string("") else { continue }
            result[key] = value
        }
        return result
    }

    func matches(_ other: Diagnostic) -> Bool { comparison == other.comparison }
}

enum CheckError: Error, LocalizedError {
    case http(Int), invalidResponse, timeout
    var errorDescription: String? {
        switch self {
        case .http(let code): return "The service returned HTTP \(code)."
        case .invalidResponse: return "The service returned an invalid IP lookup response."
        case .timeout: return "The request timed out. Refresh to try again."
        }
    }
}

struct ServiceResult: Sendable {
    let endpoint: ServiceEndpoint
    let diagnostic: Diagnostic?
    let error: String?

    static func fetch(_ endpoint: ServiceEndpoint, session: URLSession, ip: String? = nil, timeout: Int = 5) async -> ServiceResult {
        do {
            var request = URLRequest(url: endpoint.lookupURL(ip: ip), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: Double(timeout))
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.setValue("IPinfo-macOS", forHTTPHeaderField: "User-Agent")
            let lookupRequest = request
            let (data, response) = try await withThrowingTaskGroup(of: (Data, URLResponse).self) { group in
                group.addTask { try await session.data(for: lookupRequest) }
                group.addTask {
                    try await Task.sleep(nanoseconds: UInt64(timeout) * 1_000_000_000)
                    throw CheckError.timeout
                }
                defer { group.cancelAll() }
                return try await group.next()!
            }
            guard let http = response as? HTTPURLResponse else { throw CheckError.invalidResponse }
            guard http.statusCode == 200 else { throw CheckError.http(http.statusCode) }
            let diagnostic = try Diagnostic(data: data)
            if let ip, Diagnostic.canonicalIP(diagnostic.ip) != Diagnostic.canonicalIP(ip) {
                throw CheckError.invalidResponse
            }
            return ServiceResult(endpoint: endpoint, diagnostic: diagnostic, error: nil)
        } catch {
            let message: String
            if let check = error as? CheckError { message = check.localizedDescription }
            else if error is DecodingError { message = CheckError.invalidResponse.localizedDescription }
            else if (error as NSError).code == NSURLErrorTimedOut { message = "The request timed out. Refresh to try again." }
            else { message = "Could not reach this service. Check your connection and refresh." }
            return ServiceResult(endpoint: endpoint, diagnostic: nil, error: message)
        }
    }
}

struct Comparison: Sendable {
    let primary: ServiceResult
    let secondary: ServiceResult
    var singleSource = false
    var identical: Bool {
        guard !singleSource, let first = primary.diagnostic, let second = secondary.diagnostic else { return false }
        return first.matches(second)
    }
    var visible: [ServiceResult] { singleSource || identical ? [primary] : [primary, secondary] }
    var message: String {
        if singleSource { return "Using \(primary.endpoint.host)." }
        if identical { return "Both services match. Showing ip.bea.sh." }
        if primary.diagnostic == nil || secondary.diagnostic == nil { return "Comparison incomplete. Both service statuses are shown." }
        return "The results differ. Both services are shown."
    }

    static func check(session: URLSession = .shared, ip: String? = nil, settings: Settings = Settings()) async -> Comparison {
        if settings.source != "auto" {
            let result = await ServiceResult.fetch(ServiceEndpoint(host: settings.source), session: session, ip: ip, timeout: settings.timeout)
            return Comparison(primary: result, secondary: result, singleSource: true)
        }
        async let first = ServiceResult.fetch(.primary, session: session, ip: ip, timeout: settings.timeout)
        async let second = ServiceResult.fetch(.secondary, session: session, ip: ip, timeout: settings.timeout)
        return await Comparison(primary: first, secondary: second)
    }
}
