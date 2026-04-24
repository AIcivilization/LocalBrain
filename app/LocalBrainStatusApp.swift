import AppKit
import Foundation

final class LocalBrainStatusApp: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var menu = NSMenu()
    private var serverProcess: Process?
    private var serverLogHandle: FileHandle?
    private var showKeys = false
    private var lastState: [String: Any] = [:]
    private var timer: Timer?
    private lazy var projectRoot: URL = prepareProjectRoot()

    func applicationDidFinishLaunching(_ notification: Notification) {
        debugLog("applicationDidFinishLaunching projectRoot=\(projectRoot.path)")
        NSApp.setActivationPolicy(.accessory)
        configureStatusButton()
        statusItem.menu = menu
        rebuildMenu()
        startServerIfNeeded()
        refreshState()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.refreshState()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        serverProcess?.terminate()
        try? serverLogHandle?.close()
    }

    private func startServerIfNeeded() {
        debugLog("startServerIfNeeded")
        if isHealthOK() {
            debugLog("health already ok")
            return
        }

        guard let npmPath = findNpm() else {
            debugLog("npm not found")
            showAlert(title: "LocalBrain 启动失败", message: "找不到 npm。请确认 Node/npm 已安装。")
            return
        }
        debugLog("npmPath=\(npmPath)")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: npmPath)
        process.arguments = ["start"]
        process.currentDirectoryURL = projectRoot
        process.environment = processEnvironment()
        let logURL = projectRoot.appendingPathComponent("logs/menubar-app.log")
        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        _ = FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let handle = try? FileHandle(forWritingTo: logURL) {
            handle.seekToEndOfFile()
            process.standardOutput = handle
            process.standardError = handle
            serverLogHandle = handle
        }
        do {
            try process.run()
            serverProcess = process
            debugLog("process started pid=\(process.processIdentifier)")
        } catch {
            debugLog("process failed \(error.localizedDescription)")
            showAlert(title: "LocalBrain 启动失败", message: error.localizedDescription)
        }
    }

    private func refreshState() {
        var state = fetchJSON(url: "http://127.0.0.1:8787/brain/local-state") ?? [:]
        state["codex"] = codexStatus()
        lastState = state
        updateStatusTitle()
        rebuildMenu()
    }

    private func updateStatusTitle() {
        let serviceOK = (lastState["ok"] as? Bool) == true
        let codexOK = ((lastState["codex"] as? [String: Any])?["ok"] as? Bool) == true
        statusItem.button?.toolTip = serviceOK && codexOK ? "LocalBrain：运行中" : "LocalBrain：需要处理"
        if statusItem.button?.image == nil {
            statusItem.button?.title = serviceOK && codexOK ? "LB" : "LB!"
        }
    }

    private func configureStatusButton() {
        if let image = NSImage(systemSymbolName: "brain.head.profile", accessibilityDescription: "LocalBrain") {
            image.isTemplate = true
            statusItem.button?.image = image
            statusItem.button?.title = ""
        } else {
            statusItem.button?.title = "LB"
        }
        statusItem.button?.toolTip = "LocalBrain"
    }

    private func rebuildMenu() {
        menu = NSMenu()
        statusItem.menu = menu

        let serviceOK = (lastState["ok"] as? Bool) == true
        let codex = lastState["codex"] as? [String: Any] ?? [:]
        let codexOK = (codex["ok"] as? Bool) == true

        menu.addItem(coloredItem(title: serviceOK ? "● LocalBrain：运行中" : "● LocalBrain：未运行", ok: serviceOK))
        menu.addItem(coloredItem(title: codexOK ? "● Codex：可用" : "● Codex：需要配置", ok: codexOK))
        menu.addItem(NSMenuItem.separator())

        let configure = NSMenuItem(title: "配置 Codex", action: #selector(configureCodex), keyEquivalent: "")
        configure.target = self
        menu.addItem(configure)

        let modelRoot = NSMenuItem(title: "模型", action: nil, keyEquivalent: "")
        modelRoot.submenu = modelMenu()
        menu.addItem(modelRoot)

        let keyRoot = NSMenuItem(title: "Key", action: nil, keyEquivalent: "")
        keyRoot.submenu = keyMenu()
        menu.addItem(keyRoot)

        let otherRoot = NSMenuItem(title: "其他", action: nil, keyEquivalent: "")
        otherRoot.submenu = otherMenu()
        menu.addItem(otherRoot)
    }

    private func modelMenu() -> NSMenu {
        let modelMenu = NSMenu()
        let selected = lastState["defaultModel"] as? String ?? "gpt-5.4-mini"
        let models = lastState["availableModels"] as? [String] ?? [selected]

        if models.isEmpty {
            modelMenu.addItem(disabledItem("没有可选模型"))
            return modelMenu
        }

        for model in models {
            let item = NSMenuItem(title: model, action: #selector(selectModel(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = model
            item.state = model == selected ? .on : .off
            modelMenu.addItem(item)
        }
        modelMenu.addItem(NSMenuItem.separator())
        modelMenu.addItem(disabledItem("当前：\(selected)"))
        return modelMenu
    }

    private func keyMenu() -> NSMenu {
        let keyMenu = NSMenu()
        let keys = lastState["apiKeys"] as? [String] ?? []
        let baseURL = lastState["openAIBaseUrl"] as? String ?? "http://127.0.0.1:8787/v1"

        keyMenu.addItem(disabledItem("OPENAI_BASE_URL"))
        keyMenu.addItem(actionItem("复制 \(baseURL)", #selector(copyBaseURL)))
        keyMenu.addItem(NSMenuItem.separator())

        if keys.isEmpty {
            keyMenu.addItem(disabledItem("没有本地 Key"))
        } else {
            for (index, key) in keys.enumerated() {
                let item = NSMenuItem(title: showKeys ? "复制 \(key)" : "复制 \(mask(key))", action: #selector(copyKey(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = index
                keyMenu.addItem(item)
            }
        }

        keyMenu.addItem(NSMenuItem.separator())
        keyMenu.addItem(actionItem(showKeys ? "隐藏 Key" : "显示 Key", #selector(toggleKeys)))
        keyMenu.addItem(actionItem("生成新 Key", #selector(generateKey)))
        keyMenu.addItem(actionItem("替换为新 Key", #selector(replaceKey)))
        return keyMenu
    }

    private func otherMenu() -> NSMenu {
        let other = NSMenu()
        other.addItem(actionItem("打开控制台", #selector(openConsole)))
        other.addItem(actionItem("打开配置文件", #selector(openConfig)))
        other.addItem(actionItem("打开审计日志", #selector(openAuditLog)))
        other.addItem(NSMenuItem.separator())
        other.addItem(actionItem("刷新状态", #selector(refreshStatusAction)))
        other.addItem(actionItem("重启 LocalBrain", #selector(restartServer)))
        other.addItem(actionItem("停止本次启动的服务", #selector(stopOwnedServer)))
        other.addItem(NSMenuItem.separator())
        other.addItem(actionItem("退出", #selector(quit)))
        return other
    }

    @objc private func configureCodex() {
        let status = codexStatus()
        if (status["ok"] as? Bool) == true {
            showAlert(title: "Codex 已可用", message: "本机 Codex ChatGPT 登录态正常。")
            refreshState()
            return
        }

        let command = "cd \(shellQuote(projectRoot.path)); codex"
        runAppleScript("tell application \"Terminal\" to do script \(appleScriptString(command))")
        showAlert(title: "请完成 Codex 登录", message: "已打开终端。请在 Codex 中选择 Sign in with ChatGPT，完成后回到 LocalBrain 刷新状态。")
    }

    @objc private func openConsole() {
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:8787/")!)
    }

    @objc private func openConfig() {
        if let path = lastState["configPath"] as? String {
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
        }
    }

    @objc private func openAuditLog() {
        let configured = lastState["auditLogPath"] as? String
        let path = configured?.hasPrefix("/") == true ? configured! : projectRoot.appendingPathComponent(configured ?? "logs/brain-server-audit.jsonl").path
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    @objc private func refreshStatusAction() {
        refreshState()
    }

    @objc private func copyBaseURL() {
        let value = lastState["openAIBaseUrl"] as? String ?? "http://127.0.0.1:8787/v1"
        copy(value)
    }

    @objc private func copyKey(_ sender: NSMenuItem) {
        let keys = lastState["apiKeys"] as? [String] ?? []
        guard let index = sender.representedObject as? Int, keys.indices.contains(index) else { return }
        copy(keys[index])
    }

    @objc private func toggleKeys() {
        showKeys.toggle()
        rebuildMenu()
    }

    @objc private func selectModel(_ sender: NSMenuItem) {
        guard let model = sender.representedObject as? String else { return }
        if !isHealthOK() {
            startServerIfNeeded()
        }
        _ = postJSON(url: "http://127.0.0.1:8787/brain/admin/model", body: ["model": model])
        refreshState()
    }

    @objc private func generateKey() {
        if !isHealthOK() {
            startServerIfNeeded()
        }
        _ = postJSON(url: "http://127.0.0.1:8787/brain/admin/keys", body: ["replace": false])
        refreshState()
    }

    @objc private func replaceKey() {
        if !isHealthOK() {
            startServerIfNeeded()
        }
        _ = postJSON(url: "http://127.0.0.1:8787/brain/admin/keys", body: ["replace": true])
        refreshState()
    }

    @objc private func restartServer() {
        serverProcess?.terminate()
        serverProcess = nil
        try? serverLogHandle?.close()
        serverLogHandle = nil
        startServerIfNeeded()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            self.refreshState()
        }
    }

    @objc private func stopOwnedServer() {
        serverProcess?.terminate()
        serverProcess = nil
        try? serverLogHandle?.close()
        serverLogHandle = nil
        refreshState()
    }

    @objc private func quit() {
        serverProcess?.terminate()
        try? serverLogHandle?.close()
        NSApp.terminate(nil)
    }

    private func codexStatus() -> [String: Any] {
        let authPath = NSString(string: "~/.codex/auth.json").expandingTildeInPath
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: authPath)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ["ok": false, "reason": "missing-auth"]
        }

        let tokens = json["tokens"] as? [String: Any] ?? [:]
        let ok = (json["auth_mode"] as? String) == "chatgpt"
            && tokens["access_token"] is String
            && tokens["refresh_token"] is String
        return [
            "ok": ok,
            "authMode": json["auth_mode"] as? String ?? "unknown",
            "hasAccessToken": tokens["access_token"] is String,
            "hasRefreshToken": tokens["refresh_token"] is String
        ]
    }

    private func isHealthOK() -> Bool {
        let json = fetchJSON(url: "http://127.0.0.1:8787/health")
        return (json?["ok"] as? Bool) == true
    }

    private func fetchJSON(url: String) -> [String: Any]? {
        guard let requestURL = URL(string: url) else { return nil }
        var result: [String: Any]?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: requestURL) { data, _, _ in
            defer { sema.signal() }
            guard let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            result = json
        }.resume()
        _ = sema.wait(timeout: .now() + 2.0)
        return result
    }

    private func postJSON(url: String, body: [String: Any]) -> [String: Any]? {
        guard let requestURL = URL(string: url),
              let data = try? JSONSerialization.data(withJSONObject: body) else { return nil }
        var request = URLRequest(url: requestURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = data
        var result: [String: Any]?
        let sema = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, _, _ in
            defer { sema.signal() }
            guard let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            result = json
        }.resume()
        _ = sema.wait(timeout: .now() + 3.0)
        return result
    }

    private func coloredItem(title: String, ok: Bool) -> NSMenuItem {
        let item = disabledItem(title)
        item.attributedTitle = NSAttributedString(
            string: title,
            attributes: [
                .foregroundColor: ok ? NSColor.systemGreen : NSColor.systemRed
            ]
        )
        return item
    }

    private func disabledItem(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func actionItem(_ title: String, _ action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        return item
    }

    private func mask(_ key: String) -> String {
        if key.count < 20 { return "••••••" }
        return "\(key.prefix(14))••••••\(key.suffix(6))"
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    private func showAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .informational
        alert.runModal()
    }

    private func runAppleScript(_ source: String) {
        var error: NSDictionary?
        NSAppleScript(source: source)?.executeAndReturnError(&error)
    }

    private func prepareProjectRoot() -> URL {
        let fileManager = FileManager.default
        if let bundledRuntime = Bundle.main.resourceURL?.appendingPathComponent("runtime"),
           fileManager.fileExists(atPath: bundledRuntime.appendingPathComponent("package.json").path) {
            let supportRoot = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("LocalBrain", isDirectory: true)
            let runtimeRoot = supportRoot.appendingPathComponent("runtime", isDirectory: true)
            syncBundledRuntime(from: bundledRuntime, to: runtimeRoot)
            return runtimeRoot
        }

        let bundleURL = Bundle.main.bundleURL
        if bundleURL.pathExtension == "app" {
            return bundleURL.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: fileManager.currentDirectoryPath)
    }

    private func syncBundledRuntime(from bundledRuntime: URL, to runtimeRoot: URL) {
        let fileManager = FileManager.default
        let bundledVersionURL = bundledRuntime.appendingPathComponent(".runtime-version")
        let installedVersionURL = runtimeRoot.appendingPathComponent(".runtime-version")
        let bundledVersion = (try? String(contentsOf: bundledVersionURL, encoding: .utf8)) ?? "unknown"
        let installedVersion = (try? String(contentsOf: installedVersionURL, encoding: .utf8)) ?? ""

        do {
            try fileManager.createDirectory(at: runtimeRoot, withIntermediateDirectories: true)
            try fileManager.createDirectory(at: runtimeRoot.appendingPathComponent("logs"), withIntermediateDirectories: true)
            guard bundledVersion != installedVersion else { return }

            for name in ["app", "docs", "scripts", "src", "package.json", "README.md"] {
                let destination = runtimeRoot.appendingPathComponent(name)
                if fileManager.fileExists(atPath: destination.path) {
                    try fileManager.removeItem(at: destination)
                }
                try fileManager.copyItem(at: bundledRuntime.appendingPathComponent(name), to: destination)
            }
            try bundledVersion.write(to: installedVersionURL, atomically: true, encoding: .utf8)
        } catch {
            debugLog("syncBundledRuntime failed \(error.localizedDescription)")
        }
    }
}

private func shellQuote(_ value: String) -> String {
    return "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

private func findNpm() -> String? {
    let candidates = [
        "/Users/wf/.npm-global/bin/npm",
        "/opt/homebrew/opt/node/bin/npm",
        "/opt/homebrew/bin/npm",
        "/usr/local/opt/node/bin/npm",
        "/usr/local/bin/npm",
        "/usr/bin/npm"
    ]
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
}

private func processEnvironment() -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    let pathParts = [
        "/Users/wf/.npm-global/bin",
        "/opt/homebrew/opt/node/bin",
        "/opt/homebrew/bin",
        "/usr/local/opt/node/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin"
    ]
    let existing = env["PATH"] ?? ""
    env["PATH"] = (pathParts + [existing]).filter { !$0.isEmpty }.joined(separator: ":")
    return env
}

private func debugLog(_ text: String) {
    let line = "\(Date()) \(text)\n"
    let url = URL(fileURLWithPath: "/tmp/localbrain-menubar-debug.log")
    if let data = line.data(using: .utf8) {
        if FileManager.default.fileExists(atPath: url.path),
           let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            try? handle.write(contentsOf: data)
            try? handle.close()
        } else {
            try? data.write(to: url)
        }
    }
}

private func appleScriptString(_ value: String) -> String {
    let escaped = value
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
    return "\"\(escaped)\""
}

let app = NSApplication.shared
let delegate = LocalBrainStatusApp()
app.delegate = delegate
app.run()
