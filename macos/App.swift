import AppKit
import Foundation

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var status: NSTextField!
    private var refreshButton: NSButton!
    private var results: NSStackView!
    private var checkTask: Task<Void, Never>?
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 12
        config.timeoutIntervalForResource = 15
        config.urlCache = nil
        return URLSession(configuration: config)
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 710),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "IPinfo"
        window.minSize = NSSize(width: 760, height: 530)
        window.isReleasedWhenClosed = false
        window.center()

        let title = label("Your network, from two perspectives", size: 25, weight: .semibold)
        let subtitle = label("ip.bea.sh · ip.behnam.pro", size: 14)
        subtitle.textColor = .secondaryLabelColor
        refreshButton = NSButton(title: "Refresh", target: self, action: #selector(refresh))
        refreshButton.bezelStyle = .rounded
        refreshButton.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "Refresh")
        refreshButton.imagePosition = .imageLeading
        let heading = NSStackView(views: [title, NSView(), refreshButton])
        heading.alignment = .centerY
        status = label("Checking both services…", size: 13)
        status.textColor = .secondaryLabelColor

        results = NSStackView()
        results.orientation = .horizontal
        results.alignment = .top
        results.distribution = .fillEqually
        results.spacing = 18
        let footnote = label("Checks use your current network connection. Refresh after changing your VPN or proxy.", size: 12)
        footnote.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [heading, subtitle, status, results, footnote])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 16
        stack.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.documentView = stack
        window.contentView = scroll
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            stack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            heading.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -48),
            results.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -48)
        ])
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        refresh()
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = .systemFont(ofSize: size, weight: weight)
        field.isSelectable = true
        return field
    }

    private func makeMenu() {
        let menu = NSMenu()
        let application = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About IPinfo", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit IPinfo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        application.submenu = appMenu
        menu.addItem(application)
        let edit = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.submenu = editMenu
        menu.addItem(edit)
        let view = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        let refresh = NSMenuItem(title: "Refresh", action: #selector(self.refresh), keyEquivalent: "r")
        refresh.target = self
        viewMenu.addItem(refresh)
        view.submenu = viewMenu
        menu.addItem(view)
        NSApp.mainMenu = menu
    }

    @objc private func refresh() {
        checkTask?.cancel()
        status.stringValue = "Checking both services…"
        refreshButton.isEnabled = false
        for view in results.arrangedSubviews { results.removeArrangedSubview(view); view.removeFromSuperview() }
        checkTask = Task {
            let comparison = await Comparison.check(session: session)
            guard !Task.isCancelled else { return }
            status.stringValue = comparison.message + " Checked at " + Date().formatted(date: .omitted, time: .standard) + "."
            for result in comparison.visible { results.addArrangedSubview(panel(result)) }
            refreshButton.isEnabled = true
        }
    }

    private func panel(_ result: ServiceResult) -> NSView {
        let name = label(result.endpoint.host, size: 17, weight: .semibold)
        let stack = NSStackView(views: [name])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        stack.wantsLayer = true
        stack.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        stack.layer?.cornerRadius = 14
        stack.layer?.borderWidth = 1
        stack.layer?.borderColor = NSColor.separatorColor.cgColor
        if let data = result.diagnostic {
            let ip = label(data.ip, size: data.ip.contains(":") ? 19 : 28, weight: .semibold)
            ip.font = .monospacedSystemFont(ofSize: data.ip.contains(":") ? 19 : 28, weight: .semibold)
            ip.textColor = .systemBlue
            stack.addArrangedSubview(ip)
            let copy = NSButton(title: "Copy IP", target: self, action: #selector(copyIP(_:)))
            copy.bezelStyle = .rounded
            copy.identifier = NSUserInterfaceItemIdentifier(data.ip)
            stack.addArrangedSubview(copy)
            for (key, title) in Diagnostic.fields {
                let field = label("\(title): \(data.values[key]?.text ?? "Unavailable")", size: 13)
                stack.addArrangedSubview(field)
            }
            if let hostname = data.values["hostname"], hostname != .null, hostname != .string("") {
                stack.addArrangedSubview(label("Reverse DNS: \(hostname.text)", size: 13))
            }
        } else {
            let error = label(result.error ?? "Lookup unavailable.", size: 14)
            error.textColor = .systemRed
            stack.addArrangedSubview(error)
        }
        let open = NSButton(title: "Open website ↗", target: self, action: #selector(openWebsite(_:)))
        open.bezelStyle = .rounded
        open.identifier = NSUserInterfaceItemIdentifier(result.endpoint.host)
        stack.addArrangedSubview(open)
        for view in stack.arrangedSubviews where view is NSTextField {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40).isActive = true
        }
        return stack
    }

    @objc private func copyIP(_ sender: NSButton) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(sender.identifier!.rawValue, forType: .string)
        sender.title = "Copied"
    }

    @objc private func openWebsite(_ sender: NSButton) {
        NSWorkspace.shared.open(URL(string: "https://\(sender.identifier!.rawValue)")!)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        checkTask?.cancel()
        session.invalidateAndCancel()
    }
}

@main
struct IPinfoApp {
    @MainActor
    static func main() {
if CommandLine.arguments.contains("--check") {
    Task {
        let result = await Comparison.check()
        let json: [String: Any] = [
            "identical": result.identical,
            "displayed_services": result.visible.map { $0.endpoint.host },
            "message": result.message,
            "results": [result.primary, result.secondary].map { service -> [String: Any] in
                var value: [String: Any] = ["service": service.endpoint.host]
                if let diagnostic = service.diagnostic,
                   let bytes = try? JSONEncoder().encode(diagnostic.values),
                   let fields = try? JSONSerialization.jsonObject(with: bytes) { value["data"] = fields }
                if let error = service.error { value["error"] = error }
                return value
            }
        ]
        let bytes = try! JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys])
        print(String(decoding: bytes, as: UTF8.self))
        exit(result.primary.diagnostic == nil || result.secondary.diagnostic == nil ? 1 : 0)
    }
    dispatchMain()
} else {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.delegate = delegate
    application.setActivationPolicy(.regular)
    application.run()
}

    }
}
