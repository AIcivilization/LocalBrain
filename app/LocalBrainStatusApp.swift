import AppKit
import Foundation

final class LocalBrainStatusApp: NSObject, NSApplicationDelegate {
    private enum AppLanguage: String {
        case english = "en"
        case chinese = "zh-Hans"
    }

    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var menu = NSMenu()
    private var serverProcess: Process?
    private var serverLogHandle: FileHandle?
    private var showKeys = false
    private var lastState: [String: Any] = [:]
    private var timer: Timer?
    private lazy var projectRoot: URL = prepareProjectRoot()
    private var language: AppLanguage {
        get {
            let raw = UserDefaults.standard.string(forKey: "LocalBrain.language") ?? AppLanguage.english.rawValue
            return AppLanguage(rawValue: raw) ?? .english
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: "LocalBrain.language")
        }
    }
    private var showFreeModelsOnly: Bool {
        get {
            UserDefaults.standard.bool(forKey: "LocalBrain.showFreeModelsOnly")
        }
        set {
            UserDefaults.standard.set(newValue, forKey: "LocalBrain.showFreeModelsOnly")
        }
    }

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
            showAlert(title: "LocalBrain failed to start", message: "npm was not found. Please make sure Node.js and npm are installed.")
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
            showAlert(title: "LocalBrain failed to start", message: error.localizedDescription)
        }
    }

    private func refreshState() {
        var state = fetchJSON(url: "http://127.0.0.1:8787/brain/local-state") ?? [:]
        state["codex"] = codexStatus()
        state["opencode"] = opencodeStatus(state: state)
        lastState = state
        updateStatusTitle()
        rebuildMenu()
    }

    private func updateStatusTitle() {
        let serviceOK = (lastState["ok"] as? Bool) == true
        let codexOK = ((lastState["codex"] as? [String: Any])?["ok"] as? Bool) == true
        let opencodeOK = ((lastState["opencode"] as? [String: Any])?["ok"] as? Bool) == true
        statusItem.button?.toolTip = serviceOK && codexOK && opencodeOK ? text("LocalBrain: running", "LocalBrain\u{FF1A}\u{8FD0}\u{884C}\u{4E2D}") : text("LocalBrain: attention needed", "LocalBrain\u{FF1A}\u{9700}\u{8981}\u{5904}\u{7406}")
        if statusItem.button?.image == nil {
            statusItem.button?.title = serviceOK && codexOK && opencodeOK ? "LB" : "LB!"
        }
    }

    private func configureStatusButton() {
        if let image = Bundle.main.image(forResource: "LocalBrainStatus") ?? NSImage(named: "LocalBrain") {
            image.size = NSSize(width: 20, height: 20)
            image.isTemplate = false
            statusItem.button?.image = image
            statusItem.button?.title = ""
            statusItem.button?.imagePosition = .imageOnly
        } else if let image = NSImage(systemSymbolName: "brain.head.profile", accessibilityDescription: "LocalBrain") {
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
        let opencode = lastState["opencode"] as? [String: Any] ?? [:]
        let opencodeOK = (opencode["ok"] as? Bool) == true

        menu.addItem(coloredItem(title: serviceOK ? text("● LocalBrain: running", "\u{25CF} LocalBrain\u{FF1A}\u{8FD0}\u{884C}\u{4E2D}") : text("● LocalBrain: not running", "\u{25CF} LocalBrain\u{FF1A}\u{672A}\u{8FD0}\u{884C}"), ok: serviceOK))
        menu.addItem(coloredItem(title: codexOK ? text("● Codex: ready", "\u{25CF} Codex\u{FF1A}\u{53EF}\u{7528}") : text("● Codex: setup needed", "\u{25CF} Codex\u{FF1A}\u{9700}\u{8981}\u{914D}\u{7F6E}"), ok: codexOK))
        menu.addItem(coloredItem(title: opencodeOK ? text("● OpenCode: ready", "\u{25CF} OpenCode\u{FF1A}\u{53EF}\u{7528}") : text("● OpenCode: setup needed", "\u{25CF} OpenCode\u{FF1A}\u{9700}\u{8981}\u{914D}\u{7F6E}"), ok: opencodeOK))
        menu.addItem(NSMenuItem.separator())

        let configure = NSMenuItem(title: text("Configure Codex", "\u{914D}\u{7F6E} Codex"), action: #selector(configureCodex), keyEquivalent: "")
        configure.target = self
        menu.addItem(configure)

        let configureOpenCode = NSMenuItem(title: text("Configure OpenCode", "\u{914D}\u{7F6E} OpenCode"), action: #selector(configureOpenCode), keyEquivalent: "")
        configureOpenCode.target = self
        menu.addItem(configureOpenCode)

        let modelRoot = NSMenuItem(title: text("Model", "\u{6A21}\u{578B}"), action: nil, keyEquivalent: "")
        modelRoot.submenu = modelMenu()
        menu.addItem(modelRoot)

        let sourceRoot = NSMenuItem(title: text("Model Sources", "\u{6A21}\u{578B}\u{6765}\u{6E90}"), action: nil, keyEquivalent: "")
        sourceRoot.submenu = modelSourcesMenu()
        menu.addItem(sourceRoot)

        let keyRoot = NSMenuItem(title: "Key", action: nil, keyEquivalent: "")
        keyRoot.submenu = keyMenu()
        menu.addItem(keyRoot)

        let settingsRoot = NSMenuItem(title: text("Settings", "\u{8BBE}\u{7F6E}"), action: nil, keyEquivalent: "")
        settingsRoot.submenu = settingsMenu()
        menu.addItem(settingsRoot)

        menu.addItem(NSMenuItem.separator())
        menu.addItem(actionItem(text("Quit", "\u{9000}\u{51FA}"), #selector(quit)))
    }

    private func modelMenu() -> NSMenu {
        let modelMenu = NSMenu()
        let selected = lastState["defaultModel"] as? String ?? "gpt-5.5-mini"
        let modelDetails = lastState["availableModelDetails"] as? [[String: Any]] ?? []
        let models: [(id: String, providerId: String?, free: Bool)] = modelDetails.isEmpty
            ? (lastState["availableModels"] as? [String] ?? [selected]).map { ($0, nil, false) }
            : modelDetails.compactMap { detail in
                guard let id = detail["id"] as? String else { return nil }
                return (id, detail["providerId"] as? String, (detail["free"] as? Bool) == true)
            }
        let visibleModels = showFreeModelsOnly ? models.filter { $0.free } : models

        let freeOnly = NSMenuItem(title: text("Only Show Free Models", "\u{53EA}\u{663E}\u{793A}\u{514D}\u{8D39}\u{6A21}\u{578B}"), action: #selector(toggleFreeModelsOnly), keyEquivalent: "")
        freeOnly.target = self
        freeOnly.state = showFreeModelsOnly ? .on : .off
        modelMenu.addItem(freeOnly)
        modelMenu.addItem(NSMenuItem.separator())

        if visibleModels.isEmpty {
            modelMenu.addItem(disabledItem(showFreeModelsOnly ? text("No free models", "\u{6CA1}\u{6709}\u{514D}\u{8D39}\u{6A21}\u{578B}") : text("No available models", "\u{6CA1}\u{6709}\u{53EF}\u{9009}\u{6A21}\u{578B}")))
            return modelMenu
        }

        for model in visibleModels {
            let suffix = model.free ? " - free" : ""
            let item = NSMenuItem(title: "\(model.id)\(suffix)", action: #selector(selectModel(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = model.id
            item.state = model.id == selected ? .on : .off
            modelMenu.addItem(item)
        }
        modelMenu.addItem(NSMenuItem.separator())
        modelMenu.addItem(disabledItem(text("Current: \(selected)", "\u{5F53}\u{524D}\u{FF1A}\(selected)")))
        return modelMenu
    }

    private func modelSourcesMenu() -> NSMenu {
        let menu = NSMenu()
        let providers = lastState["providers"] as? [[String: Any]] ?? []
        let filters = lastState["modelProviderFilters"] as? [String: Any] ?? [:]

        if providers.isEmpty {
            menu.addItem(disabledItem(text("No model sources", "\u{6CA1}\u{6709}\u{6A21}\u{578B}\u{6765}\u{6E90}")))
            return menu
        }

        for provider in providers {
            guard let providerId = provider["id"] as? String else { continue }
            let filter = filters[providerId] as? [String: Any] ?? [:]
            let enabled = (filter["enabled"] as? Bool) != false
            let freeOnly = (filter["freeOnly"] as? Bool) == true
            let displayName = provider["displayName"] as? String ?? providerId

            let root = NSMenuItem(title: "\(displayName)\(enabled ? "" : " - off")\(freeOnly ? " - free only" : "")", action: nil, keyEquivalent: "")
            let source = NSMenu()

            let enabledItem = NSMenuItem(title: text("Enabled", "\u{542F}\u{7528}"), action: #selector(updateProviderFilter(_:)), keyEquivalent: "")
            enabledItem.target = self
            enabledItem.state = enabled ? .on : .off
            enabledItem.representedObject = [
                "providerId": providerId,
                "enabled": !enabled,
                "freeOnly": freeOnly,
                "only": false
            ]
            source.addItem(enabledItem)

            let freeItem = NSMenuItem(title: text("Free Only", "\u{53EA}\u{7528}\u{514D}\u{8D39}\u{6A21}\u{578B}"), action: #selector(updateProviderFilter(_:)), keyEquivalent: "")
            freeItem.target = self
            freeItem.state = freeOnly ? .on : .off
            freeItem.representedObject = [
                "providerId": providerId,
                "enabled": enabled,
                "freeOnly": !freeOnly,
                "only": false
            ]
            source.addItem(freeItem)

            let onlyFree = NSMenuItem(title: text("Use Only This Free Source", "\u{53EA}\u{7528}\u{8FD9}\u{4E2A}\u{514D}\u{8D39}\u{6765}\u{6E90}"), action: #selector(updateProviderFilter(_:)), keyEquivalent: "")
            onlyFree.target = self
            onlyFree.representedObject = [
                "providerId": providerId,
                "enabled": true,
                "freeOnly": true,
                "only": true
            ]
            source.addItem(onlyFree)

            root.submenu = source
            menu.addItem(root)
        }

        return menu
    }

    private func keyMenu() -> NSMenu {
        let keyMenu = NSMenu()
        let keys = lastState["apiKeys"] as? [String] ?? []
        let keyRoutes = lastState["apiKeyRoutes"] as? [String: Any] ?? [:]
        let baseURL = lastState["openAIBaseUrl"] as? String ?? "http://127.0.0.1:8787/v1"

        keyMenu.addItem(disabledItem("OPENAI_BASE_URL"))
        keyMenu.addItem(actionItem(text("Copy \(baseURL)", "\u{590D}\u{5236} \(baseURL)"), #selector(copyBaseURL)))
        keyMenu.addItem(NSMenuItem.separator())

        if keys.isEmpty {
            keyMenu.addItem(disabledItem(text("No local keys", "\u{6CA1}\u{6709}\u{672C}\u{5730} Key")))
        } else {
            for key in keys {
                let route = keyRoutes[key] as? [String: Any]
                let assignedModel = route?["model"] as? String
                let titleKey = showKeys ? key : mask(key)
                let item = NSMenuItem(title: assignedModel == nil ? titleKey : "\(titleKey) -> \(assignedModel!)", action: nil, keyEquivalent: "")
                item.submenu = localKeyMenu(key: key, assignedModel: assignedModel)
                keyMenu.addItem(item)
            }
        }

        keyMenu.addItem(NSMenuItem.separator())
        keyMenu.addItem(actionItem(showKeys ? text("Hide Keys", "\u{9690}\u{85CF} Key") : text("Show Keys", "\u{663E}\u{793A} Key"), #selector(toggleKeys)))
        keyMenu.addItem(actionItem(text("Generate New Key", "\u{751F}\u{6210}\u{65B0} Key"), #selector(generateKey)))
        keyMenu.addItem(actionItem(text("Replace With New Key", "\u{66FF}\u{6362}\u{4E3A}\u{65B0} Key"), #selector(replaceKey)))
        keyMenu.addItem(NSMenuItem.separator())
        keyMenu.addItem(actionItem(text("Add Upstream API Key", "\u{6DFB}\u{52A0}\u{4E0A}\u{6E38} API Key"), #selector(addUpstreamApiKey)))
        return keyMenu
    }

    private func localKeyMenu(key: String, assignedModel: String?) -> NSMenu {
        let menu = NSMenu()
        let copy = NSMenuItem(title: showKeys ? text("Copy \(key)", "\u{590D}\u{5236} \(key)") : text("Copy \(mask(key))", "\u{590D}\u{5236} \(mask(key))"), action: #selector(copyKey(_:)), keyEquivalent: "")
        copy.target = self
        copy.representedObject = key
        menu.addItem(copy)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(disabledItem(assignedModel == nil ? text("Assigned: default routing", "\u{5DF2}\u{6307}\u{5B9A}\u{FF1A}\u{9ED8}\u{8BA4}\u{8DEF}\u{7531}") : text("Assigned: \(assignedModel!)", "\u{5DF2}\u{6307}\u{5B9A}\u{FF1A}\(assignedModel!)")))

        let assign = NSMenuItem(title: text("Assign Current Model", "\u{6307}\u{5B9A}\u{4E3A}\u{5F53}\u{524D}\u{6A21}\u{578B}"), action: #selector(assignKeyToCurrentModel(_:)), keyEquivalent: "")
        assign.target = self
        assign.representedObject = key
        menu.addItem(assign)

        let assignModel = NSMenuItem(title: text("Assign Model", "\u{6307}\u{5B9A}\u{6A21}\u{578B}"), action: nil, keyEquivalent: "")
        assignModel.submenu = keyModelAssignmentMenu(key: key, assignedModel: assignedModel)
        menu.addItem(assignModel)

        let clear = NSMenuItem(title: text("Clear Model Assignment", "\u{6E05}\u{9664}\u{6A21}\u{578B}\u{6307}\u{5B9A}"), action: #selector(clearKeyModel(_:)), keyEquivalent: "")
        clear.target = self
        clear.representedObject = key
        clear.isEnabled = assignedModel != nil
        menu.addItem(clear)
        return menu
    }

    private func keyModelAssignmentMenu(key: String, assignedModel: String?) -> NSMenu {
        let menu = NSMenu()
        let modelDetails = lastState["availableModelDetails"] as? [[String: Any]] ?? []
        let models: [(id: String, providerId: String?, free: Bool)] = modelDetails.compactMap { detail in
            guard let id = detail["id"] as? String else { return nil }
            return (id, detail["providerId"] as? String, (detail["free"] as? Bool) == true)
        }

        if models.isEmpty {
            menu.addItem(disabledItem(text("No available models", "\u{6CA1}\u{6709}\u{53EF}\u{9009}\u{6A21}\u{578B}")))
            return menu
        }

        for model in models {
            let title = "\(model.id)\(model.free ? " - free" : "")\(model.providerId == nil ? "" : " · \(model.providerId!)")"
            let item = NSMenuItem(title: title, action: #selector(assignKeyToSelectedModel(_:)), keyEquivalent: "")
            item.target = self
            item.state = model.id == assignedModel ? .on : .off
            item.representedObject = [
                "apiKey": key,
                "model": model.id
            ]
            menu.addItem(item)
        }
        return menu
    }

    private func settingsMenu() -> NSMenu {
        let settings = NSMenu()
        let languageRoot = NSMenuItem(title: text("Language", "\u{8BED}\u{8A00}"), action: nil, keyEquivalent: "")
        languageRoot.submenu = languageMenu()
        settings.addItem(languageRoot)
        settings.addItem(NSMenuItem.separator())
        settings.addItem(actionItem(text("Open Console", "\u{6253}\u{5F00}\u{63A7}\u{5236}\u{53F0}"), #selector(openConsole)))
        settings.addItem(actionItem(text("Open Config File", "\u{6253}\u{5F00}\u{914D}\u{7F6E}\u{6587}\u{4EF6}"), #selector(openConfig)))
        settings.addItem(actionItem(text("Open Audit Log", "\u{6253}\u{5F00}\u{5BA1}\u{8BA1}\u{65E5}\u{5FD7}"), #selector(openAuditLog)))
        settings.addItem(NSMenuItem.separator())
        settings.addItem(actionItem(text("Refresh Status", "\u{5237}\u{65B0}\u{72B6}\u{6001}"), #selector(refreshStatusAction)))
        settings.addItem(actionItem(text("Restart LocalBrain", "\u{91CD}\u{542F} LocalBrain"), #selector(restartServer)))
        settings.addItem(actionItem(text("Stop This Service", "\u{505C}\u{6B62}\u{672C}\u{6B21}\u{542F}\u{52A8}\u{7684}\u{670D}\u{52A1}"), #selector(stopOwnedServer)))
        return settings
    }

    private func languageMenu() -> NSMenu {
        let languageMenu = NSMenu()
        let english = NSMenuItem(title: "English", action: #selector(selectLanguage(_:)), keyEquivalent: "")
        english.target = self
        english.representedObject = AppLanguage.english.rawValue
        english.state = language == .english ? .on : .off
        languageMenu.addItem(english)

        let chinese = NSMenuItem(title: "\u{4E2D}\u{6587}", action: #selector(selectLanguage(_:)), keyEquivalent: "")
        chinese.target = self
        chinese.representedObject = AppLanguage.chinese.rawValue
        chinese.state = language == .chinese ? .on : .off
        languageMenu.addItem(chinese)
        return languageMenu
    }

    @objc private func configureCodex() {
        let status = codexStatus()
        if (status["ok"] as? Bool) == true {
            showAlert(title: text("Codex is ready", "Codex \u{5DF2}\u{53EF}\u{7528}"), message: text("Local Codex ChatGPT login is available.", "\u{672C}\u{673A} Codex ChatGPT \u{767B}\u{5F55}\u{6001}\u{6B63}\u{5E38}\u{3002}"))
            refreshState()
            return
        }

        let command = "cd \(shellQuote(projectRoot.path)); codex"
        runAppleScript("tell application \"Terminal\" to do script \(appleScriptString(command))")
        showAlert(title: text("Complete Codex login", "\u{8BF7}\u{5B8C}\u{6210} Codex \u{767B}\u{5F55}"), message: text("Terminal has been opened. In Codex, choose Sign in with ChatGPT, then return to LocalBrain and refresh status.", "\u{5DF2}\u{6253}\u{5F00}\u{7EC8}\u{7AEF}\u{3002}\u{8BF7}\u{5728} Codex \u{4E2D}\u{9009}\u{62E9} Sign in with ChatGPT\u{FF0C}\u{5B8C}\u{6210}\u{540E}\u{56DE}\u{5230} LocalBrain \u{5237}\u{65B0}\u{72B6}\u{6001}\u{3002}"))
    }

    @objc private func configureOpenCode() {
        let status = opencodeStatus(state: lastState)
        if (status["ok"] as? Bool) == true {
            showAlert(title: text("OpenCode is ready", "OpenCode \u{5DF2}\u{53EF}\u{7528}"), message: text("LocalBrain can discover OpenCode free models.", "LocalBrain \u{5DF2}\u{53EF}\u{53D1}\u{73B0} OpenCode \u{514D}\u{8D39}\u{6A21}\u{578B}\u{3002}"))
            refreshState()
            return
        }

        let opencodePath = findOpenCode() ?? "/Users/wf/.opencode/bin/opencode"
        let command = FileManager.default.isExecutableFile(atPath: opencodePath)
            ? "\(shellQuote(opencodePath)) auth login"
            : "echo 'OpenCode CLI was not found. Install OpenCode first, then return to LocalBrain.'"
        runAppleScript("tell application \"Terminal\" to do script \(appleScriptString(command))")
        showAlert(title: text("Complete OpenCode setup", "\u{8BF7}\u{5B8C}\u{6210} OpenCode \u{914D}\u{7F6E}"), message: text("Terminal has been opened. Complete OpenCode login, then return to LocalBrain and refresh status.", "\u{5DF2}\u{6253}\u{5F00}\u{7EC8}\u{7AEF}\u{3002}\u{8BF7}\u{5B8C}\u{6210} OpenCode \u{767B}\u{5F55}\u{FF0C}\u{7136}\u{540E}\u{56DE}\u{5230} LocalBrain \u{5237}\u{65B0}\u{72B6}\u{6001}\u{3002}"))
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
        if let key = sender.representedObject as? String {
            copy(key)
            return
        }
        guard let index = sender.representedObject as? Int, keys.indices.contains(index) else { return }
        copy(keys[index])
    }

    @objc private func toggleKeys() {
        showKeys.toggle()
        rebuildMenu()
    }

    @objc private func toggleFreeModelsOnly() {
        showFreeModelsOnly.toggle()
        rebuildMenu()
    }

    @objc private func updateProviderFilter(_ sender: NSMenuItem) {
        guard let body = sender.representedObject as? [String: Any] else { return }
        _ = postJSON(url: "http://127.0.0.1:8787/brain/admin/provider-model-filter", body: body)
        refreshState()
    }

    @objc private func selectLanguage(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let nextLanguage = AppLanguage(rawValue: raw) else { return }
        language = nextLanguage
        updateStatusTitle()
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

    @objc private func assignKeyToCurrentModel(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        let model = lastState["defaultModel"] as? String ?? "gpt-5.5-mini"
        _ = postJSON(url: "http://127.0.0.1:8787/brain/admin/key-model", body: [
            "apiKey": key,
            "model": model
        ])
        refreshState()
    }

    @objc private func assignKeyToSelectedModel(_ sender: NSMenuItem) {
        guard let body = sender.representedObject as? [String: Any] else { return }
        _ = postJSON(url: "http://127.0.0.1:8787/brain/admin/key-model", body: body)
        refreshState()
    }

    @objc private func clearKeyModel(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        _ = postJSON(url: "http://127.0.0.1:8787/brain/admin/key-model", body: [
            "apiKey": key,
            "clear": true
        ])
        refreshState()
    }

    @objc private func addUpstreamApiKey() {
        if !isHealthOK() {
            startServerIfNeeded()
        }

        let name = NSTextField(string: "")
        name.placeholderString = "Provider name"
        let baseURL = NSTextField(string: "https://api.openai.com/v1")
        baseURL.placeholderString = "Base URL"
        let apiKey = NSSecureTextField(string: "")
        apiKey.placeholderString = "API key"
        let model = NSTextField(string: "")
        model.placeholderString = "Optional default model"
        let makeDefault = NSButton(checkboxWithTitle: text("Use as default when model is available", "\u{6A21}\u{578B}\u{53EF}\u{7528}\u{65F6}\u{8BBE}\u{4E3A}\u{9ED8}\u{8BA4}"), target: nil, action: nil)

        let stack = NSStackView(views: [name, baseURL, apiKey, model, makeDefault])
        stack.orientation = .vertical
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 4, left: 0, bottom: 0, right: 0)
        stack.setFrameSize(NSSize(width: 360, height: 150))

        let alert = NSAlert()
        alert.messageText = text("Add upstream API key", "\u{6DFB}\u{52A0}\u{4E0A}\u{6E38} API Key")
        alert.informativeText = text("LocalBrain will store this key locally and proxy compatible model calls through it.", "LocalBrain \u{4F1A}\u{5C06}\u{8FD9}\u{4E2A} Key \u{4FDD}\u{5B58}\u{5728}\u{672C}\u{5730}\u{FF0C}\u{5E76}\u{901A}\u{8FC7}\u{5B83}\u{4E2D}\u{8F6C}\u{6A21}\u{578B}\u{8BF7}\u{6C42}\u{3002}")
        alert.accessoryView = stack
        alert.addButton(withTitle: text("Add", "\u{6DFB}\u{52A0}"))
        alert.addButton(withTitle: text("Cancel", "\u{53D6}\u{6D88}"))

        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let response = postJSON(url: "http://127.0.0.1:8787/brain/admin/upstream-api-keys", body: [
            "displayName": name.stringValue,
            "baseUrl": baseURL.stringValue,
            "apiKey": apiKey.stringValue,
            "model": model.stringValue,
            "makeDefault": makeDefault.state == .on
        ])
        if response == nil {
            showAlert(title: text("API key was not added", "\u{672A}\u{6DFB}\u{52A0} API Key"), message: text("LocalBrain did not accept the upstream key. Check the service log for details.", "LocalBrain \u{672A}\u{63A5}\u{53D7}\u{8FD9}\u{4E2A}\u{4E0A}\u{6E38} Key\u{3002}\u{8BF7}\u{67E5}\u{770B}\u{670D}\u{52A1}\u{65E5}\u{5FD7}\u{3002}"))
        }
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

    private func opencodeStatus(state: [String: Any]) -> [String: Any] {
        let models = state["availableModels"] as? [String] ?? []
        let hasFreeModels = models.contains { $0.hasPrefix("opencode/") }
        return [
            "ok": findOpenCode() != nil && hasFreeModels,
            "hasCli": findOpenCode() != nil,
            "hasFreeModels": hasFreeModels
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

    private func text(_ english: String, _ chinese: String) -> String {
        language == .chinese ? chinese : english
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

private func findOpenCode() -> String? {
    let candidates = [
        "/Users/wf/.opencode/bin/opencode",
        "/opt/homebrew/bin/opencode",
        "/usr/local/bin/opencode"
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
