import Foundation

final class FixtureProtocol: URLProtocol, @unchecked Sendable {
    static var responses: [String: (Int, String)] = [:]
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let (status, body) = Self.responses[request.url!.host!] else {
            client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
            return
        }
        precondition(request.value(forHTTPHeaderField: "Accept") == "application/json")
        precondition(request.cachePolicy == .reloadIgnoringLocalCacheData)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main
struct DiagnosticsTests {
    static func main() async throws {
        func expect(_ value: Bool) { precondition(value) }
        func diagnostic(_ json: String) throws -> Diagnostic { try Diagnostic(data: Data(json.utf8)) }
        func result(_ endpoint: ServiceEndpoint, _ value: Diagnostic?) -> ServiceResult {
            ServiceResult(endpoint: endpoint, diagnostic: value, error: value == nil ? "Offline" : nil)
        }
        let first = try diagnostic(#"{"ip":"8.8.8.8","country":"United States","asn":"AS15169","source":"Cloudflare","user_agent":"one"}"#)
        let same = try diagnostic(#"{"asn":"AS15169","country":"United States","ip":"8.8.8.8","source":"GeoLite2","database_release":"release","hostname":"dns.google","user_agent":"two","ip_decimal":134744072}"#)
        let equal = Comparison(primary: result(.primary, first), secondary: result(.secondary, same))
        expect(equal.identical && equal.visible.map { $0.endpoint.host } == ["ip.bea.sh"])
        let different = try diagnostic(#"{"ip":"1.1.1.1","country":"United States","asn":"AS15169"}"#)
        expect(!first.matches(different))
        expect(!first.matches(try diagnostic(#"{"ip":"8.8.8.8","country":"Iran","asn":"AS15169"}"#)))
        expect(!first.matches(try diagnostic(#"{"ip":"8.8.8.8","country":"United States","asn":"AS13335"}"#)))
        expect(!first.matches(try diagnostic(#"{"ip":"8.8.8.8","asn":"AS15169"}"#)))
        let expanded = try diagnostic(#"{"ip":"2606:4700:4700:0:0:0:0:1111","city":null,"postal_code":""}"#)
        let compressed = try diagnostic(#"{"ip":"2606:4700:4700::1111"}"#)
        expect(expanded.matches(compressed))
        let coordinate = try diagnostic(#"{"ip":"8.8.8.8","latitude":10,"country_ir":false}"#)
        let coordinateSame = try diagnostic(#"{"ip":"8.8.8.8","latitude":10.0,"country_ir":false}"#)
        expect(coordinate.matches(coordinateSame))
        expect(!coordinate.matches(try diagnostic(#"{"ip":"8.8.8.8","latitude":10.1,"country_ir":false}"#)))
        for (one, two) in [(first as Diagnostic?, nil), (nil, same), (nil, nil)] {
            let failed = Comparison(primary: result(.primary, one), secondary: result(.secondary, two))
            expect(!failed.identical && failed.visible.count == 2)
            expect(failed.message.contains("incomplete"))
        }
        for invalid in [#"{"ip":"invalid"}"#, #"{"country":"Iran"}"#, #"{"ip":"8.8.8.8","error":"Oops"}"#, "<html>Error</html>"] {
            do { _ = try diagnostic(invalid); preconditionFailure("Accepted invalid response") }
            catch { /* Expected rejection. */ }
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FixtureProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        FixtureProtocol.responses = [
            "ip.bea.sh": (200, #"{"ip":"8.8.8.8","country":"United States"}"#),
            "ip.behnam.pro": (200, #"{"ip":"8.8.8.8","country":"United States"}"#)
        ]
        let matching = await Comparison.check(session: session)
        expect(matching.identical && matching.visible.count == 1)
        FixtureProtocol.responses["ip.behnam.pro"] = (200, #"{"ip":"1.1.1.1","country":"United States"}"#)
        let mismatching = await Comparison.check(session: session)
        expect(!mismatching.identical && mismatching.visible.count == 2)
        FixtureProtocol.responses["ip.behnam.pro"] = (502, #"{"error":"Unavailable"}"#)
        let unavailable = await Comparison.check(session: session)
        expect(unavailable.visible.count == 2 && unavailable.secondary.error!.contains("502"))
        FixtureProtocol.responses.removeValue(forKey: "ip.bea.sh")
        let timedOut = await Comparison.check(session: session)
        expect(timedOut.primary.error!.contains("timed out") && timedOut.visible.count == 2)
        FixtureProtocol.responses["ip.behnam.pro"] = (200, "<html>Error</html>")
        let malformed = await Comparison.check(session: session)
        expect(malformed.secondary.diagnostic == nil && malformed.visible.count == 2)
        print("Passed macOS comparison tests: matches, differences, IPv6 normalization, metadata, missing fields, and failures.")
    }
}
