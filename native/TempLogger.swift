import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var message: NSTextField!
    var retry: Timer?
    var floatingItem: NSMenuItem!
    let dashboard = URL(string: Bundle.main.object(forInfoDictionaryKey: "TempLoggerURL") as! String)!

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let other = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier!)
            .first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            other.activate(options: [.activateAllWindows])
            NSApp.terminate(nil)
            return
        }
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Temp Logger", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Temp Logger Window", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        floatingItem = NSMenuItem(title: "Always on Top", action: #selector(toggleFloating), keyEquivalent: "t")
        floatingItem.keyEquivalentModifierMask = [.command, .shift]
        floatingItem.target = self
        windowMenu.addItem(floatingItem)
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        menu.addItem(windowItem)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windowMenu

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 780), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Temp Logger"
        window.minSize = NSSize(width: 390, height: 450)
        window.center()
        window.setFrameAutosaveName("TempLoggerDashboard")
        webView = WKWebView(frame: window.contentView!.bounds)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        window.contentView!.addSubview(webView)
        message = NSTextField(labelWithString: "Waiting for temperature logger…")
        message.alignment = .center
        message.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(message)
        NSLayoutConstraint.activate([
            message.centerXAnchor.constraint(equalTo: window.contentView!.centerXAnchor),
            message.centerYAnchor.constraint(equalTo: window.contentView!.centerYAnchor)
        ])
        applyFloating()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        loadDashboard()
    }

    @objc func toggleFloating() {
        UserDefaults.standard.set(!UserDefaults.standard.bool(forKey: "alwaysOnTop"), forKey: "alwaysOnTop")
        applyFloating()
    }
    func applyFloating() {
        let floating = UserDefaults.standard.bool(forKey: "alwaysOnTop")
        window.level = floating ? .floating : .normal
        floatingItem.state = floating ? .on : .off
    }
    func loadDashboard() { webView.load(URLRequest(url: dashboard)) }
    func retryLoad() {
        message.isHidden = false
        retry?.invalidate()
        retry = Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { [weak self] _ in self?.loadDashboard() }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { message.isHidden = true }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { retryLoad() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { retryLoad() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { retryLoad() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
