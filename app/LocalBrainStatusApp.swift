import AppKit
import Foundation

final class LocalBrainStatusApp: NSObject, NSApplicationDelegate {
    private enum AppLanguage: String {
        case english = "en"
        case chinese = "zh-Hans"
    }

    private enum ChannelHealthLevel: Equatable {
        case error
        case unstable
        case unknown
        case ok
    }

    private struct ChannelSummary {
        let key: String
        let label: String
        let assignedModel: String?
        let displayModel: String
        let providerId: String?
        let status: String
        let durationMs: Int?
        let tokensPerSecond: Double?
        let successRate: Double?
        let recentPerMinute: Int
        let recentCount: Int
        let lastTestAt: String?
        let errorMessage: String?
    }

    private struct ModelInfo {
        let id: String
        let providerId: String?
        let free: Bool
        let displayName: String?
    }

    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var menu = NSMenu()
    private var serverProcess: Process?
    private var serverLogHandle: FileHandle?
    private var showKeys = false
    private var lastState: [String: Any] = [:]
    private var timer: Timer?
    private weak var upstreamApiKeyField: NSSecureTextField?
    private weak var upstreamBaseURLField: NSTextField?
    private weak var upstreamModelPopup: NSPopUpButton?
    private lazy var projectRoot: URL = prepareProjectRoot()
    private var language: AppLanguage {
        get {
            let key = "LocalBrain.language"
            let raw = UserDefaults.standard.string(forKey: key)
                ?? (Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") == true ? AppLanguage.chinese.rawValue : AppLanguage.english.rawValue)
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
        state["antigravity"] = antigravityStatus(state: state)
        lastState = state
        updateStatusTitle()
        rebuildMenu()
    }

    private func updateStatusTitle() {
        let serviceOK = (lastState["ok"] as? Bool) == true
        let attentionNeeded = !serviceOK || channelSummaries().contains { channelHealthLevel($0) == .error }
        statusItem.button?.toolTip = compactTopStatusTitle()
        if statusItem.button?.image == nil {
            statusItem.button?.title = attentionNeeded ? "LB!" : "LB"
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
        let channels = channelSummaries()
        let hasChannelErrors = channels.contains { channelHealthLevel($0) == .error }
        let hasUnstableChannels = channels.contains { channelHealthLevel($0) == .unstable }
        menu.addItem(coloredItem(title: compactTopStatusTitle(), ok: serviceOK && !hasChannelErrors && !hasUnstableChannels, warning: serviceOK && !hasChannelErrors && hasUnstableChannels))
        menu.addItem(disabledItem(recommendedChannelTitle()))
        menu.addItem(actionItem(text("Open Console", "\u{6253}\u{5F00}\u{63A7}\u{5236}\u{53F0}"), #selector(openConsole)))
        menu.addItem(actionItem(text("Refresh Status", "\u{5237}\u{65B0}\u{72B6}\u{6001}"), #selector(refreshStatusAction)))
        menu.addItem(NSMenuItem.separator())

        let attentionRoot = NSMenuItem(title: text("Needs Attention", "\u{9700}\u{8981}\u{5904}\u{7406}"), action: nil, keyEquivalent: "")
        attentionRoot.submenu = attentionChannelsMenu()
        menu.addItem(attentionRoot)

        let allChannelsRoot = NSMenuItem(title: text("All Channels", "\u{5168}\u{90E8}\u{901A}\u{9053}"), action: nil, keyEquivalent: "")
        allChannelsRoot.submenu = allChannelsMenu()
        menu.addItem(allChannelsRoot)

        menu.addItem(NSMenuItem.separator())

        let commonRoot = NSMenuItem(title: text("Common Actions", "\u{5E38}\u{7528}\u{64CD}\u{4F5C}"), action: nil, keyEquivalent: "")
        commonRoot.submenu = commonActionsMenu()
        menu.addItem(commonRoot)

        let sourceRoot = NSMenuItem(title: text("Model Sources", "\u{6A21}\u{578B}\u{6765}\u{6E90}"), action: nil, keyEquivalent: "")
        sourceRoot.submenu = modelSourcesMenu()
        menu.addItem(sourceRoot)

        let settingsRoot = NSMenuItem(title: text("Advanced Settings", "\u{9AD8}\u{7EA7}\u{8BBE}\u{7F6E}"), action: nil, keyEquivalent: "")
        settingsRoot.submenu = settingsMenu()
        menu.addItem(settingsRoot)

        menu.addItem(NSMenuItem.separator())
        menu.addItem(actionItem(text("Quit", "\u{9000}\u{51FA}"), #selector(quit)))
    }

    private func compactTopStatusTitle() -> String {
        let serviceOK = (lastState["ok"] as? Bool) == true
        let channels = channelSummaries()
        let okCount = channels.filter { channelHealthLevel($0) == .ok }.count
        let unstableCount = channels.filter { channelHealthLevel($0) == .unstable }.count
        let errorCount = channels.filter { channelHealthLevel($0) == .error }.count

        if !serviceOK {
            return text(
                "\u{25CF} LocalBrain not running · Channels \(okCount)/\(channels.count) ready",
                "\u{25CF} 未运行 · 通道 \(okCount)/\(channels.count) 可用"
            )
        }
        let errorText = errorCount > 0 ? text(" · \(errorCount) error", " · \(errorCount) 异常") : ""
        let unstableText = unstableCount > 0 ? text(" · \(unstableCount) unstable", " · \(unstableCount) 不稳定") : ""
        return text(
            "\u{25CF} LocalBrain running · \(okCount) ready\(unstableText)\(errorText)",
            "\u{25CF} 运行中 · \(okCount) 可用\(unstableText)\(errorText)"
        )
    }

    private func recommendedChannelTitle() -> String {
        guard let recommended = recommendedChannel() else {
            return text("Recommended: none", "\u{63A8}\u{8350}\u{FF1A}\u{65E0}")
        }
        let speed = recommended.durationMs.map { formatDuration($0) } ?? "-"
        return text(
            "Recommended: \(recommended.label) · \(providerShortName(for: recommended)) · \(speed)",
            "\u{63A8}\u{8350}\u{FF1A}\(recommended.label) · \(providerShortName(for: recommended)) · \(speed)"
        )
    }

    private func recommendedChannel() -> ChannelSummary? {
        allChannelSummariesForChoosing().first
    }

    private func allChannelSummariesForChoosing() -> [ChannelSummary] {
        channelSummaries().sorted { left, right in
            let leftRank = channelChoiceRank(channelHealthLevel(left))
            let rightRank = channelChoiceRank(channelHealthLevel(right))
            if leftRank != rightRank { return leftRank < rightRank }

            let leftDuration = left.durationMs ?? Int.max
            let rightDuration = right.durationMs ?? Int.max
            if leftDuration != rightDuration { return leftDuration < rightDuration }

            return left.label.localizedStandardCompare(right.label) == .orderedAscending
        }
    }

    private func channelChoiceRank(_ level: ChannelHealthLevel) -> Int {
        switch level {
        case .ok:
            return 0
        case .unstable:
            return 1
        case .unknown:
            return 2
        case .error:
            return 3
        }
    }

    private func attentionChannelsMenu() -> NSMenu {
        let menu = NSMenu()
        let channels = sortedChannelSummaries().filter {
            let level = channelHealthLevel($0)
            return level == .error || level == .unstable
        }
        guard !channels.isEmpty else {
            menu.addItem(disabledItem(text("No channels need attention", "\u{6CA1}\u{6709}\u{9700}\u{8981}\u{5904}\u{7406}\u{7684}\u{901A}\u{9053}")))
            return menu
        }
        for channel in channels {
            let item = NSMenuItem(title: channelTitle(channel), action: nil, keyEquivalent: "")
            item.submenu = localChannelMenu(channel)
            menu.addItem(item)
        }
        return menu
    }

    private func allChannelsMenu() -> NSMenu {
        let menu = NSMenu()
        let channels = allChannelSummariesForChoosing()
        guard !channels.isEmpty else {
            menu.addItem(disabledItem(text("No local channels", "\u{6CA1}\u{6709}\u{672C}\u{5730}\u{901A}\u{9053}")))
            return menu
        }
        for channel in channels {
            let item = NSMenuItem(title: channelTitle(channel), action: nil, keyEquivalent: "")
            item.submenu = localChannelMenu(channel)
            menu.addItem(item)
        }
        return menu
    }

    private func commonActionsMenu() -> NSMenu {
        let menu = NSMenu()
        let baseURL = lastState["openAIBaseUrl"] as? String ?? "http://127.0.0.1:8787/v1"
        menu.addItem(actionItem(text("Copy Base URL", "\u{590D}\u{5236} Base URL"), #selector(copyBaseURL)))
        menu.addItem(disabledItem(baseURL))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(actionItem(text("Generate New Channel", "\u{751F}\u{6210}\u{65B0}\u{901A}\u{9053}"), #selector(generateKey)))
        menu.addItem(actionItem(text("Export All Keys", "\u{5BFC}\u{51FA}\u{5168}\u{90E8} Key"), #selector(exportKeys)))
        menu.addItem(actionItem(text("Test All Channels (calls models)", "\u{6D4B}\u{8BD5}\u{5168}\u{90E8}\u{901A}\u{9053}\u{FF08}\u{4F1A}\u{8C03}\u{7528}\u{6A21}\u{578B}\u{FF09}"), #selector(testAllChannels)))
        return menu
    }

    private func channelSummaries() -> [ChannelSummary] {
        let apiKeyDetails = lastState["apiKeyDetails"] as? [[String: Any]] ?? []
        let keys = lastState["apiKeys"] as? [String] ?? []
        let routes = lastState["apiKeyRoutes"] as? [String: Any] ?? [:]
        let labels = lastState["apiKeyLabels"] as? [String: String] ?? [:]
        let healthItems = lastState["keyHealth"] as? [[String: Any]] ?? []
        let healthByKey = Dictionary(uniqueKeysWithValues: healthItems.compactMap { item -> (String, [String: Any])? in
            guard let key = item["apiKey"] as? String else { return nil }
            return (key, item)
        })
        let details = apiKeyDetails.isEmpty
            ? keys.map { ["key": $0, "label": labels[$0] as Any, "route": routes[$0] as Any] }
            : apiKeyDetails

        return details.compactMap { detail in
            guard let key = detail["key"] as? String else { return nil }
            let route = detail["route"] as? [String: Any]
            let health = healthByKey[key] ?? [:]
            let assignedModel = route?["model"] as? String
            let displayModel = assignedModel
                ?? health["model"] as? String
                ?? lastState["defaultModel"] as? String
                ?? "default"
            let label = (detail["label"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let providerId = route?["providerId"] as? String ?? health["providerId"] as? String
            return ChannelSummary(
                key: key,
                label: label?.isEmpty == false ? label! : mask(key),
                assignedModel: assignedModel,
                displayModel: displayModel,
                providerId: providerId,
                status: health["status"] as? String ?? "unknown",
                durationMs: intValue(health["durationMs"]),
                tokensPerSecond: doubleValue(health["tokensPerSecond"]),
                successRate: doubleValue(health["successRate"]),
                recentPerMinute: intValue(health["recentPerMinute"]) ?? 0,
                recentCount: intValue(health["recentCount"]) ?? 0,
                lastTestAt: health["lastTestAt"] as? String,
                errorMessage: health["errorMessage"] as? String
            )
        }
    }

    private func channelTitle(_ channel: ChannelSummary) -> String {
        let statusText = channelHealthText(channelHealthLevel(channel))
        let speed = channel.durationMs.map { formatDuration($0) } ?? "-"
        let success = formatSuccessRate(channel.successRate)
        return "\(channel.label) · \(providerShortName(for: channel)) · \(statusText) · \(speed) · \(success)"
    }

    private func sortedChannelSummaries() -> [ChannelSummary] {
        channelSummaries().sorted { left, right in
            let leftRank = channelHealthRank(channelHealthLevel(left))
            let rightRank = channelHealthRank(channelHealthLevel(right))
            if leftRank != rightRank { return leftRank < rightRank }

            let leftDuration = left.durationMs ?? -1
            let rightDuration = right.durationMs ?? -1
            if leftDuration != rightDuration { return leftDuration > rightDuration }

            return left.label.localizedStandardCompare(right.label) == .orderedAscending
        }
    }

    private func channelHealthLevel(_ channel: ChannelSummary) -> ChannelHealthLevel {
        switch channel.status {
        case "error":
            return .error
        case "ok":
            let successRate = normalizedSuccessRate(channel.successRate)
            if let successRate, successRate < 0.8 {
                return .unstable
            }
            if let durationMs = channel.durationMs, durationMs >= 15_000 {
                return .unstable
            }
            return .ok
        case "unknown":
            return .unknown
        default:
            return .unknown
        }
    }

    private func channelHealthRank(_ level: ChannelHealthLevel) -> Int {
        switch level {
        case .error:
            return 0
        case .unstable:
            return 1
        case .unknown:
            return 2
        case .ok:
            return 3
        }
    }

    private func channelHealthText(_ level: ChannelHealthLevel) -> String {
        switch level {
        case .ok:
            return text("ready", "\u{53EF}\u{7528}")
        case .unstable:
            return text("unstable", "\u{4E0D}\u{7A33}\u{5B9A}")
        case .error:
            return text("error", "\u{5F02}\u{5E38}")
        case .unknown:
            return text("unknown", "\u{672A}\u{77E5}")
        }
    }

    private func normalizedSuccessRate(_ value: Double?) -> Double? {
        guard let value else { return nil }
        return value > 1.0 ? value / 100.0 : value
    }

    private func providerShortName(for channel: ChannelSummary) -> String {
        return providerShortName(providerId: channel.providerId, modelId: channel.displayModel)
    }

    private func providerShortName(providerId: String?, modelId: String?) -> String {
        if let providerId, !providerId.isEmpty {
            if providerId == "codex-chatgpt-local" { return "Codex" }
            if providerId == "opencode-local" { return "OpenCode" }
            if providerId == "antigravity-local" { return "Antigravity" }
            if providerId.hasPrefix("upstream-") {
                return text("Upstream", "\u{4E0A}\u{6E38}")
            }
            return text("Upstream", "\u{4E0A}\u{6E38}")
        }

        let modelId = modelId ?? ""
        if modelId.hasPrefix("opencode/") { return "OpenCode" }
        if modelId.hasPrefix("antigravity/") { return "Antigravity" }
        if modelId.hasPrefix("gpt-") { return "Codex" }
        return text("Model", "\u{6A21}\u{578B}")
    }

    private func lastTestTimeText(_ value: String?) -> String {
        guard let value, !value.isEmpty else {
            return text("never", "\u{4ECE}\u{672A}")
        }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = iso.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        guard let date else {
            return text("unknown", "\u{672A}\u{77E5}")
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: language == .chinese ? "zh_CN" : "en_US")
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    private func availableModelInfos() -> [ModelInfo] {
        let selected = lastState["defaultModel"] as? String ?? "gpt-5.4-mini"
        let modelDetails = lastState["availableModelDetails"] as? [[String: Any]] ?? []
        if modelDetails.isEmpty {
            return (lastState["availableModels"] as? [String] ?? [selected]).map {
                ModelInfo(id: $0, providerId: nil, free: false, displayName: nil)
            }
        }
        return modelDetails.compactMap { detail in
            guard let id = detail["id"] as? String else { return nil }
            return ModelInfo(
                id: id,
                providerId: detail["providerId"] as? String,
                free: (detail["free"] as? Bool) == true,
                displayName: detail["displayName"] as? String
            )
        }
    }

    private func modelMenu() -> NSMenu {
        let modelMenu = NSMenu()
        let selected = lastState["defaultModel"] as? String ?? "gpt-5.4-mini"
        let models = availableModelInfos()
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

        if providers.isEmpty {
            menu.addItem(disabledItem(text("No model sources", "\u{6CA1}\u{6709}\u{6A21}\u{578B}\u{6765}\u{6E90}")))
            return menu
        }

        for provider in providers {
            guard let providerId = provider["id"] as? String else { continue }
            let displayName = providerDisplayName(providerId: providerId, fallback: provider["displayName"] as? String)
            let root = NSMenuItem(title: providerSourceTitle(displayName: displayName, providerId: providerId), action: nil, keyEquivalent: "")
            root.submenu = providerSourceMenu(providerId: providerId, displayName: displayName)
            menu.addItem(root)
        }

        let upstreamRoot = NSMenuItem(title: upstreamSourceTitle(), action: nil, keyEquivalent: "")
        upstreamRoot.submenu = configureUpstreamKeyMenu()
        menu.addItem(upstreamRoot)
        return menu
    }

    private func providerSourceMenu(providerId: String, displayName: String) -> NSMenu {
        let menu = NSMenu()
        switch providerId {
        case "codex-chatgpt-local":
            menu.addItem(actionItem(text("Check / Configure Codex", "\u{68C0}\u{67E5} / \u{914D}\u{7F6E} Codex"), #selector(configureCodex)))
            menu.addItem(NSMenuItem.separator())
        case "opencode-local":
            menu.addItem(actionItem(text("Check / Configure OpenCode", "\u{68C0}\u{67E5} / \u{914D}\u{7F6E} OpenCode"), #selector(configureOpenCode)))
            menu.addItem(NSMenuItem.separator())
        case "antigravity-local":
            menu.addItem(actionItem(text("Check / Configure Antigravity", "\u{68C0}\u{67E5} / \u{914D}\u{7F6E} Antigravity"), #selector(configureAntigravity)))
            menu.addItem(NSMenuItem.separator())
        default:
            menu.addItem(disabledItem(displayName))
            menu.addItem(NSMenuItem.separator())
        }
        addProviderFilterItems(to: menu, providerId: providerId)
        return menu
    }

    private func providerSourceTitle(displayName: String, providerId: String) -> String {
        let enabled = providerFilterEnabled(providerId: providerId)
        let freeOnly = providerFilterFreeOnly(providerId: providerId)
        let status = enabled ? text("On", "\u{5F00}") : text("Off", "\u{5173}")
        let free = freeOnly ? text(", free only", "\u{FF0C}\u{53EA}\u{514D}\u{8D39}") : ""
        return "\(displayName): \(status)\(free)"
    }

    private func providerDisplayName(providerId: String, fallback: String?) -> String {
        switch providerId {
        case "codex-chatgpt-local":
            return "Codex"
        case "opencode-local":
            return "OpenCode"
        case "antigravity-local":
            return "Antigravity"
        default:
            return fallback ?? providerId
        }
    }

    private func upstreamSourceTitle() -> String {
        let statuses = upstreamProviderStatuses()
        guard !statuses.isEmpty else {
            return text("Upstream Key: no keys", "\u{4E0A}\u{6E38} Key\u{FF1A}\u{65E0} Key")
        }
        let usableCount = statuses.filter { $0.usable }.count
        let enabled = upstreamProvidersEnabled()
        let status = enabled ? text("On", "\u{5F00}") : text("Off", "\u{5173}")
        return text(
            "Upstream Key: \(status), \(usableCount)/\(statuses.count) ready",
            "\u{4E0A}\u{6E38} Key\u{FF1A}\(status)\u{FF0C}\(usableCount)/\(statuses.count) \u{53EF}\u{7528}"
        )
    }

    private func upstreamProviderStatuses() -> [(id: String, displayName: String, enabled: Bool, usable: Bool)] {
        let providers = lastState["upstreamProviders"] as? [[String: Any]] ?? []
        let models = lastState["availableModelDetails"] as? [[String: Any]] ?? []
        let modelProviderIds = Set(models.compactMap { $0["providerId"] as? String })

        return providers.compactMap { provider in
            guard let providerId = provider["id"] as? String else { return nil }
            let displayName = provider["displayName"] as? String ?? providerId
            let enabled = providerFilterEnabled(providerId: providerId)
            let usable = enabled && modelProviderIds.contains(providerId)
            return (id: providerId, displayName: displayName, enabled: enabled, usable: usable)
        }
    }

    private func configureUpstreamKeyMenu() -> NSMenu {
        let menu = NSMenu()
        let providers = lastState["upstreamProviders"] as? [[String: Any]] ?? []
        let providerIds = providers.compactMap { $0["id"] as? String }

        if !providerIds.isEmpty {
            let enabled = upstreamProvidersEnabled()
            let enabledItem = NSMenuItem(title: text("Enabled", "\u{542F}\u{7528}"), action: #selector(updateProviderFilters(_:)), keyEquivalent: "")
            enabledItem.target = self
            enabledItem.state = enabled ? .on : .off
            enabledItem.representedObject = providerIds.map { providerId in
                [
                    "providerId": providerId,
                    "enabled": !enabled,
                    "freeOnly": providerFilterFreeOnly(providerId: providerId),
                    "only": false
                ] as [String: Any]
            }
            menu.addItem(enabledItem)
            menu.addItem(NSMenuItem.separator())
        }

        menu.addItem(actionItem(text("Add", "\u{6DFB}\u{52A0}"), #selector(addUpstreamApiKey)))
        guard !providers.isEmpty else {
            return menu
        }

        menu.addItem(NSMenuItem.separator())
        for provider in providers {
            let providerId = provider["id"] as? String ?? ""
            let displayName = provider["displayName"] as? String ?? providerId
            let root = NSMenuItem(title: displayName, action: nil, keyEquivalent: "")
            let providerMenu = NSMenu()
            providerMenu.addItem(disabledItem(providerId))
            if let baseUrl = provider["baseUrl"] as? String {
                providerMenu.addItem(disabledItem(baseUrl))
            }
            providerMenu.addItem(NSMenuItem.separator())
            addProviderFilterItems(to: providerMenu, providerId: providerId)
            providerMenu.addItem(NSMenuItem.separator())
            let update = NSMenuItem(title: text("Change", "\u{66F4}\u{6539}"), action: #selector(updateUpstreamApiKey(_:)), keyEquivalent: "")
            update.target = self
            update.representedObject = provider
            providerMenu.addItem(update)
            root.submenu = providerMenu
            menu.addItem(root)
        }
        return menu
    }

    private func addProviderFilterItems(to menu: NSMenu, providerId: String) {
        let enabled = providerFilterEnabled(providerId: providerId)
        let freeOnly = providerFilterFreeOnly(providerId: providerId)

        let enabledItem = NSMenuItem(title: text("Enabled", "\u{542F}\u{7528}"), action: #selector(updateProviderFilter(_:)), keyEquivalent: "")
        enabledItem.target = self
        enabledItem.state = enabled ? .on : .off
        enabledItem.representedObject = [
            "providerId": providerId,
            "enabled": !enabled,
            "freeOnly": freeOnly,
            "only": false
        ]
        menu.addItem(enabledItem)

        let freeOnlyItem = NSMenuItem(title: text("Free Only", "\u{53EA}\u{7528}\u{514D}\u{8D39}\u{6A21}\u{578B}"), action: #selector(updateProviderFilter(_:)), keyEquivalent: "")
        freeOnlyItem.target = self
        freeOnlyItem.state = freeOnly ? .on : .off
        freeOnlyItem.representedObject = [
            "providerId": providerId,
            "enabled": enabled,
            "freeOnly": !freeOnly,
            "only": false
        ]
        menu.addItem(freeOnlyItem)

        let onlyThisSource = NSMenuItem(title: text("Use Only This Source", "\u{53EA}\u{7528}\u{8FD9}\u{4E2A}\u{6765}\u{6E90}"), action: #selector(updateProviderFilter(_:)), keyEquivalent: "")
        onlyThisSource.target = self
        onlyThisSource.representedObject = [
            "providerId": providerId,
            "enabled": true,
            "freeOnly": freeOnly,
            "only": true
        ]
        menu.addItem(onlyThisSource)
    }

    private func upstreamProvidersEnabled() -> Bool {
        let providers = lastState["upstreamProviders"] as? [[String: Any]] ?? []
        guard !providers.isEmpty else { return false }
        return providers.contains { provider in
            guard let providerId = provider["id"] as? String else { return false }
            return providerFilterEnabled(providerId: providerId)
        }
    }

    private func providerFilterEnabled(providerId: String) -> Bool {
        let filters = lastState["modelProviderFilters"] as? [String: Any] ?? [:]
        let filter = filters[providerId] as? [String: Any] ?? [:]
        return (filter["enabled"] as? Bool) != false
    }

    private func providerFilterFreeOnly(providerId: String) -> Bool {
        let filters = lastState["modelProviderFilters"] as? [String: Any] ?? [:]
        let filter = filters[providerId] as? [String: Any] ?? [:]
        return (filter["freeOnly"] as? Bool) == true
    }

    private func localChannelMenu(_ channel: ChannelSummary) -> NSMenu {
        let menu = NSMenu()
        if showKeys {
            menu.addItem(disabledItem(channel.key))
        } else {
            menu.addItem(disabledItem(mask(channel.key)))
        }
        menu.addItem(disabledItem(text("Model: \(channel.displayModel)", "\u{6A21}\u{578B}\u{FF1A}\(channel.displayModel)")))
        menu.addItem(disabledItem(text("Last test: \(lastTestTimeText(channel.lastTestAt))", "\u{6700}\u{8FD1}\u{6D4B}\u{8BD5}\u{FF1A}\(lastTestTimeText(channel.lastTestAt))")))
        menu.addItem(disabledItem(text("Status: \(channelStatusDetail(channel))", "\u{72B6}\u{6001}\u{FF1A}\(channelStatusDetail(channel))")))
        if let error = channel.errorMessage, !error.isEmpty {
            menu.addItem(disabledItem(text("Error: \(compactLabel(error, maxLength: 72))", "\u{9519}\u{8BEF}\u{FF1A}\(compactLabel(error, maxLength: 72))")))
        }
        menu.addItem(NSMenuItem.separator())

        let copy = NSMenuItem(title: text("Copy Key", "\u{590D}\u{5236} Key"), action: #selector(copyKey(_:)), keyEquivalent: "")
        copy.target = self
        copy.representedObject = channel.key
        menu.addItem(copy)

        let test = NSMenuItem(title: text("Test This Channel", "\u{6D4B}\u{8BD5}\u{6B64}\u{901A}\u{9053}"), action: #selector(testChannel(_:)), keyEquivalent: "")
        test.target = self
        test.representedObject = channel.key
        menu.addItem(test)

        let assignModel = NSMenuItem(title: text("Assign Model", "\u{6307}\u{5B9A}\u{6A21}\u{578B}"), action: nil, keyEquivalent: "")
        assignModel.submenu = keyModelAssignmentMenu(key: channel.key, assignedModel: channel.assignedModel)
        menu.addItem(assignModel)

        let clear = NSMenuItem(title: text("Clear Model Assignment", "\u{6E05}\u{9664}\u{6A21}\u{578B}\u{6307}\u{5B9A}"), action: #selector(clearKeyModel(_:)), keyEquivalent: "")
        clear.target = self
        clear.representedObject = channel.key
        clear.isEnabled = channel.assignedModel != nil
        menu.addItem(clear)

        let delete = NSMenuItem(title: text("Delete Channel", "\u{5220}\u{9664}\u{901A}\u{9053}"), action: #selector(deleteLocalKey(_:)), keyEquivalent: "")
        delete.target = self
        delete.representedObject = channel.key
        menu.addItem(delete)
        return menu
    }

    private func keyModelAssignmentMenu(key: String, assignedModel: String?) -> NSMenu {
        let menu = NSMenu()
        let models = availableModelInfos()

        if models.isEmpty {
            menu.addItem(disabledItem(text("No available models", "\u{6CA1}\u{6709}\u{53EF}\u{9009}\u{6A21}\u{578B}")))
            return menu
        }

        let grouped = Dictionary(grouping: models) { model in
            providerShortName(providerId: model.providerId, modelId: model.id)
        }
        let groupOrder = ["Codex", "OpenCode", "Antigravity", text("Upstream", "\u{4E0A}\u{6E38}")]
        let orderedGroups = grouped.keys.sorted { left, right in
            let leftIndex = groupOrder.firstIndex(of: left) ?? groupOrder.count
            let rightIndex = groupOrder.firstIndex(of: right) ?? groupOrder.count
            if leftIndex != rightIndex { return leftIndex < rightIndex }
            return left.localizedStandardCompare(right) == .orderedAscending
        }

        for group in orderedGroups {
            let root = NSMenuItem(title: group, action: nil, keyEquivalent: "")
            let submenu = NSMenu()
            for model in (grouped[group] ?? []).sorted(by: { $0.id.localizedStandardCompare($1.id) == .orderedAscending }) {
                let freeSuffix = model.free ? " - \(text("free", "\u{514D}\u{8D39}"))" : ""
                let title = "\(model.displayName ?? model.id)\(freeSuffix)"
                let item = NSMenuItem(title: title, action: #selector(assignKeyToSelectedModel(_:)), keyEquivalent: "")
                item.target = self
                item.state = model.id == assignedModel ? .on : .off
                item.representedObject = [
                    "apiKey": key,
                    "model": model.id
                ]
                submenu.addItem(item)
            }
            root.submenu = submenu
            menu.addItem(root)
        }
        return menu
    }

    private func settingsMenu() -> NSMenu {
        let settings = NSMenu()
        let defaultModelRoot = NSMenuItem(title: text("Default Fallback Route", "\u{9ED8}\u{8BA4}\u{5907}\u{7528}\u{8DEF}\u{7531}"), action: nil, keyEquivalent: "")
        defaultModelRoot.submenu = modelMenu()
        settings.addItem(defaultModelRoot)

        let languageRoot = NSMenuItem(title: text("Language", "\u{8BED}\u{8A00}"), action: nil, keyEquivalent: "")
        languageRoot.submenu = languageMenu()
        settings.addItem(languageRoot)
        settings.addItem(NSMenuItem.separator())
        settings.addItem(actionItem(text("Open Config File", "\u{6253}\u{5F00}\u{914D}\u{7F6E}\u{6587}\u{4EF6}"), #selector(openConfig)))
        settings.addItem(actionItem(text("Open Audit Log", "\u{6253}\u{5F00}\u{5BA1}\u{8BA1}\u{65E5}\u{5FD7}"), #selector(openAuditLog)))
        settings.addItem(NSMenuItem.separator())
        settings.addItem(actionItem(text("Restart LocalBrain", "\u{91CD}\u{542F} LocalBrain"), #selector(restartServer)))
        settings.addItem(actionItem(text("Stop This Service", "\u{505C}\u{6B62}\u{672C}\u{6B21}\u{542F}\u{52A8}\u{7684}\u{670D}\u{52A1}"), #selector(stopOwnedServer)))
        settings.addItem(NSMenuItem.separator())
        settings.addItem(actionItem(text("Reset All Channel Keys...", "\u{91CD}\u{7F6E}\u{5168}\u{90E8}\u{901A}\u{9053} Key..."), #selector(replaceKey)))
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

    @objc private func configureAntigravity() {
        let status = antigravityStatus(state: lastState)
        if (status["ok"] as? Bool) == true {
            let count = status["modelCount"] as? Int ?? 0
            showAlert(title: text("Antigravity is ready", "Antigravity \u{5DF2}\u{53EF}\u{7528}"), message: text("LocalBrain can discover \(count) Antigravity models.", "LocalBrain \u{5DF2}\u{53EF}\u{53D1}\u{73B0} \(count) \u{4E2A} Antigravity \u{6A21}\u{578B}\u{3002}"))
            refreshState()
            return
        }

        if let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Antigravity") ?? NSWorkspace.shared.urlForApplication(toOpen: URL(fileURLWithPath: "/Applications/Antigravity.app")) {
            NSWorkspace.shared.open(appURL)
        } else {
            NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Antigravity.app"))
        }
        showAlert(title: text("Complete Antigravity setup", "\u{8BF7}\u{5B8C}\u{6210} Antigravity \u{914D}\u{7F6E}"), message: text("Antigravity has been opened. Sign in there, then return to LocalBrain and refresh status.", "\u{5DF2}\u{6253}\u{5F00} Antigravity\u{3002}\u{8BF7}\u{5728}\u{5176}\u{4E2D}\u{5B8C}\u{6210}\u{767B}\u{5F55}\u{FF0C}\u{7136}\u{540E}\u{56DE}\u{5230} LocalBrain \u{5237}\u{65B0}\u{72B6}\u{6001}\u{3002}"))
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

    @objc private func updateProviderFilters(_ sender: NSMenuItem) {
        guard let bodies = sender.representedObject as? [[String: Any]] else { return }
        for body in bodies {
            _ = postJSON(url: "http://127.0.0.1:8787/brain/admin/provider-model-filter", body: body)
        }
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
        let alert = NSAlert()
        alert.messageText = text("Reset all channel keys?", "\u{91CD}\u{7F6E}\u{5168}\u{90E8}\u{901A}\u{9053} Key\u{FF1F}")
        alert.informativeText = text(
            "All products using current LocalBrain keys will stop working until they are updated to the new key.",
            "\u{6240}\u{6709}\u{6B63}\u{5728}\u{4F7F}\u{7528}\u{5F53}\u{524D} LocalBrain Key \u{7684}\u{4EA7}\u{54C1}\u{90FD}\u{4F1A}\u{5931}\u{6548}\u{FF0C}\u{9700}\u{66F4}\u{65B0}\u{5230}\u{65B0} Key \u{540E}\u{624D}\u{80FD}\u{7EE7}\u{7EED}\u{4F7F}\u{7528}\u{3002}"
        )
        alert.alertStyle = .critical
        alert.addButton(withTitle: text("Reset", "\u{91CD}\u{7F6E}"))
        alert.addButton(withTitle: text("Cancel", "\u{53D6}\u{6D88}"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        if !isHealthOK() {
            startServerIfNeeded()
        }
        _ = postJSON(url: "http://127.0.0.1:8787/brain/admin/keys", body: ["replace": true])
        refreshState()
    }

    @objc private func testAllChannels() {
        let alert = NSAlert()
        alert.messageText = text("Test all channels?", "\u{6D4B}\u{8BD5}\u{5168}\u{90E8}\u{901A}\u{9053}\u{FF1F}")
        alert.informativeText = text(
            "LocalBrain will call every configured channel once. This may consume paid credits, membership quota, or provider rate limits.",
            "LocalBrain \u{4F1A}\u{628A}\u{6BCF}\u{4E2A}\u{5DF2}\u{914D}\u{7F6E}\u{901A}\u{9053}\u{90FD}\u{8C03}\u{7528}\u{4E00}\u{6B21}\u{3002}\u{8FD9}\u{53EF}\u{80FD}\u{6D88}\u{8017}\u{4ED8}\u{8D39}\u{989D}\u{5EA6}\u{3001}\u{4F1A}\u{5458}\u{989D}\u{5EA6}\u{6216}\u{89E6}\u{53D1}\u{5382}\u{5BB6}\u{9891}\u{7387}\u{9650}\u{5236}\u{3002}"
        )
        alert.alertStyle = .warning
        alert.addButton(withTitle: text("Test All", "\u{6D4B}\u{8BD5}\u{5168}\u{90E8}"))
        alert.addButton(withTitle: text("Cancel", "\u{53D6}\u{6D88}"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        if !isHealthOK() {
            startServerIfNeeded()
        }
        _ = postJSON(url: "http://127.0.0.1:8787/brain/admin/health/test", body: ["all": true], timeout: 70.0)
        refreshState()
    }

    @objc private func testChannel(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        if !isHealthOK() {
            startServerIfNeeded()
        }
        _ = postJSON(url: "http://127.0.0.1:8787/brain/admin/health/test", body: ["apiKey": key], timeout: 70.0)
        refreshState()
    }

    @objc private func exportKeys() {
        let rows = channelSummaries().map { channel in
            [
                "label": channel.label,
                "key": channel.key,
                "baseUrl": lastState["openAIBaseUrl"] as? String ?? "http://127.0.0.1:8787/v1",
                "model": channel.assignedModel ?? (lastState["defaultModel"] as? String) ?? "",
                "providerId": channel.providerId ?? "",
                "status": channel.status
            ]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted]),
              let text = String(data: data, encoding: .utf8) else { return }
        copy(text)
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

    @objc private func deleteLocalKey(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        let alert = NSAlert()
        alert.messageText = text("Delete local API key?", "\u{5220}\u{9664}\u{672C}\u{5730} API Key\u{FF1F}")
        alert.informativeText = text("Products using this key will stop working until they switch to another LocalBrain key.", "\u{6B63}\u{5728}\u{4F7F}\u{7528}\u{8FD9}\u{4E2A} Key \u{7684}\u{4EA7}\u{54C1}\u{9700}\u{5207}\u{6362}\u{5230}\u{5176}\u{4ED6} LocalBrain Key\u{FF0C}\u{5426}\u{5219}\u{4F1A}\u{505C}\u{6B62}\u{5DE5}\u{4F5C}\u{3002}")
        alert.alertStyle = .warning
        alert.addButton(withTitle: text("Delete", "\u{5220}\u{9664}"))
        alert.addButton(withTitle: text("Cancel", "\u{53D6}\u{6D88}"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        _ = postJSON(url: "http://127.0.0.1:8787/brain/admin/delete-key", body: [
            "apiKey": key
        ])
        refreshState()
    }

    @objc private func addUpstreamApiKey() {
        showUpstreamApiKeyDialog(provider: nil)
    }

    @objc private func updateUpstreamApiKey(_ sender: NSMenuItem) {
        guard let provider = sender.representedObject as? [String: Any] else { return }
        showUpstreamApiKeyDialog(provider: provider)
    }

    private func showUpstreamApiKeyDialog(provider: [String: Any]?) {
        if !isHealthOK() {
            startServerIfNeeded()
        }
        NSApp.activate(ignoringOtherApps: true)

        let providerId = provider?["id"] as? String
        let name = NSTextField(string: provider?["displayName"] as? String ?? "")
        name.placeholderString = text("Source name", "\u{6765}\u{6E90}\u{540D}\u{79F0}")
        let baseURL = NSTextField(string: provider?["baseUrl"] as? String ?? "https://api.openai.com/v1")
        baseURL.placeholderString = "Base URL"
        upstreamBaseURLField = baseURL
        let apiKey = NSSecureTextField(string: "")
        apiKey.placeholderString = "API key"
        upstreamApiKeyField = apiKey
        let pasteApiKey = NSButton(title: text("Paste", "\u{7C98}\u{8D34}"), target: self, action: #selector(pasteUpstreamApiKeyFromClipboard))
        pasteApiKey.bezelStyle = .rounded
        let apiKeyRow = NSStackView(views: [apiKey, pasteApiKey])
        apiKeyRow.orientation = .horizontal
        apiKeyRow.spacing = 8
        apiKey.setContentHuggingPriority(.defaultLow, for: .horizontal)
        pasteApiKey.setContentHuggingPriority(.required, for: .horizontal)
        let model = NSPopUpButton()
        model.addItem(withTitle: text("Fetch models first (optional)", "\u{5148}\u{62C9}\u{53D6}\u{6A21}\u{578B}\u{FF08}\u{53EF}\u{9009}\u{FF09}"))
        model.lastItem?.representedObject = ""
        upstreamModelPopup = model
        let fetchModels = NSButton(title: text("Fetch Models", "\u{62C9}\u{53D6}\u{6A21}\u{578B}"), target: self, action: #selector(fetchUpstreamModelsForDialog))
        fetchModels.bezelStyle = .rounded
        let modelRow = NSStackView(views: [model, fetchModels])
        modelRow.orientation = .horizontal
        modelRow.spacing = 8
        model.setContentHuggingPriority(.defaultLow, for: .horizontal)
        fetchModels.setContentHuggingPriority(.required, for: .horizontal)
        let makeDefault = NSButton(checkboxWithTitle: text("Use as default when model is available", "\u{6A21}\u{578B}\u{53EF}\u{7528}\u{65F6}\u{8BBE}\u{4E3A}\u{9ED8}\u{8BA4}"), target: nil, action: nil)

        let stack = NSStackView(views: [name, baseURL, apiKeyRow, modelRow, makeDefault])
        stack.orientation = .vertical
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 4, left: 0, bottom: 0, right: 0)
        stack.setFrameSize(NSSize(width: 360, height: 150))

        let alert = NSAlert()
        alert.messageText = providerId == nil
            ? text("Add upstream API key", "\u{6DFB}\u{52A0}\u{4E0A}\u{6E38} API Key")
            : text("Change upstream API key", "\u{66F4}\u{6539}\u{4E0A}\u{6E38} API Key")
        alert.informativeText = text("LocalBrain will store this key locally and proxy compatible model calls through it.", "LocalBrain \u{4F1A}\u{5C06}\u{8FD9}\u{4E2A} Key \u{4FDD}\u{5B58}\u{5728}\u{672C}\u{5730}\u{FF0C}\u{5E76}\u{901A}\u{8FC7}\u{5B83}\u{4E2D}\u{8F6C}\u{6A21}\u{578B}\u{8BF7}\u{6C42}\u{3002}")
        alert.accessoryView = stack
        alert.addButton(withTitle: text("Add", "\u{6DFB}\u{52A0}"))
        alert.addButton(withTitle: text("Cancel", "\u{53D6}\u{6D88}"))

        guard alert.runModal() == .alertFirstButtonReturn else {
            upstreamApiKeyField = nil
            upstreamBaseURLField = nil
            upstreamModelPopup = nil
            return
        }
        let response = postJSON(url: "http://127.0.0.1:8787/brain/admin/upstream-api-keys", body: [
            "providerId": providerId ?? "",
            "displayName": name.stringValue,
            "baseUrl": baseURL.stringValue,
            "apiKey": apiKey.stringValue,
            "model": model.selectedItem?.representedObject as? String ?? "",
            "makeDefault": makeDefault.state == .on
        ])
        if response == nil {
            showAlert(title: text("API key was not added", "\u{672A}\u{6DFB}\u{52A0} API Key"), message: text("LocalBrain did not accept the upstream key. Check the service log for details.", "LocalBrain \u{672A}\u{63A5}\u{53D7}\u{8FD9}\u{4E2A}\u{4E0A}\u{6E38} Key\u{3002}\u{8BF7}\u{67E5}\u{770B}\u{670D}\u{52A1}\u{65E5}\u{5FD7}\u{3002}"))
        }
        upstreamApiKeyField = nil
        upstreamBaseURLField = nil
        upstreamModelPopup = nil
        refreshState()
    }

    @objc private func pasteUpstreamApiKeyFromClipboard() {
        guard let value = NSPasteboard.general.string(forType: .string),
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        upstreamApiKeyField?.stringValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @objc private func fetchUpstreamModelsForDialog() {
        guard let baseURL = upstreamBaseURLField?.stringValue,
              let apiKey = upstreamApiKeyField?.stringValue,
              let popup = upstreamModelPopup else { return }

        guard let response = postJSON(url: "http://127.0.0.1:8787/brain/admin/upstream-models", body: [
            "baseUrl": baseURL,
            "apiKey": apiKey
        ]),
              let models = response["models"] as? [String] else {
            showAlert(title: text("Models were not fetched", "\u{672A}\u{62C9}\u{53D6}\u{6A21}\u{578B}"), message: text("Check the base URL and API key, then try again.", "\u{8BF7}\u{68C0}\u{67E5} Base URL \u{548C} API Key\u{FF0C}\u{7136}\u{540E}\u{91CD}\u{8BD5}\u{3002}"))
            return
        }

        popup.removeAllItems()
        popup.addItem(withTitle: text("Do not set default model", "\u{4E0D}\u{8BBE}\u{7F6E}\u{9ED8}\u{8BA4}\u{6A21}\u{578B}"))
        popup.lastItem?.representedObject = ""
        for model in models {
            popup.addItem(withTitle: model)
            popup.lastItem?.representedObject = model
        }
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

    private func antigravityStatus(state: [String: Any]) -> [String: Any] {
        let modelDetails = state["availableModelDetails"] as? [[String: Any]] ?? []
        let modelCount = modelDetails.filter { ($0["providerId"] as? String) == "antigravity-local" }.count
        let appExists = FileManager.default.fileExists(atPath: "/Applications/Antigravity.app")
        return [
            "ok": appExists && modelCount > 0,
            "hasApp": appExists,
            "modelCount": modelCount
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

    private func postJSON(url: String, body: [String: Any], timeout: TimeInterval = 10.0) -> [String: Any]? {
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
        _ = sema.wait(timeout: .now() + timeout)
        return result
    }

    private func coloredItem(title: String, ok: Bool, warning: Bool = false) -> NSMenuItem {
        let item = disabledItem(title)
        item.attributedTitle = NSAttributedString(
            string: title,
            attributes: [
                .foregroundColor: ok ? NSColor.systemGreen : (warning ? NSColor.systemOrange : NSColor.systemRed)
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

    private func compactLabel(_ value: String, maxLength: Int) -> String {
        guard value.count > maxLength, maxLength > 1 else { return value }
        return "\(value.prefix(maxLength - 1))…"
    }

    private func intValue(_ value: Any?) -> Int? {
        if let int = value as? Int { return int }
        if let number = value as? NSNumber { return number.intValue }
        if let string = value as? String { return Int(string) }
        return nil
    }

    private func doubleValue(_ value: Any?) -> Double? {
        if let double = value as? Double { return double }
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }

    private func formatDuration(_ ms: Int) -> String {
        if ms >= 1000 {
            let seconds = Double(ms) / 1000.0
            return String(format: "%.1fs", seconds)
        }
        return "\(ms)ms"
    }

    private func formatSpeed(_ value: Double?) -> String {
        guard let value else { return "-" }
        return String(format: "%.1f t/s", value)
    }

    private func formatSuccessRate(_ value: Double?) -> String {
        guard let value = normalizedSuccessRate(value) else { return "-" }
        return "\(Int(round(value * 100)))%"
    }

    private func channelStatusDetail(_ channel: ChannelSummary) -> String {
        let status = channelHealthText(channelHealthLevel(channel))
        let duration = channel.durationMs.map { formatDuration($0) } ?? "-"
        let speed = formatSpeed(channel.tokensPerSecond)
        let success = formatSuccessRate(channel.successRate)
        return "\(status) · \(duration) · \(speed) · \(success) · \(channel.recentPerMinute)/min"
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
