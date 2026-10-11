import Foundation

private struct DesktopChatSnapshot: Codable {
    let savedAt: Date
    /// The LINE account the chats belong to; a snapshot never crosses accounts.
    let mid: String
    let chats: [LineChatItem]
}

enum DesktopChatSnapshotStore {
    private static let maximumAge: TimeInterval = 30 * 24 * 60 * 60

    private static var url: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Yomi", isDirectory: true)
            .appendingPathComponent("chat-list-v1.json")
    }

    /// The signed-in account's mid, or nil when there is no usable session.
    private static var currentMid: String? {
        guard let credentials = CredentialManager.loadCredentials(),
            credentials.lineAuthToken?.isEmpty == false,
            let mid = credentials.lineMid, !mid.isEmpty
        else { return nil }
        return mid
    }

    static func load() -> [LineChatItem] {
        // Snapshots written before `mid` existed fail to decode and are dropped.
        guard let mid = currentMid,
            let url,
            let data = try? Data(contentsOf: url),
            let snapshot = try? JSONDecoder().decode(DesktopChatSnapshot.self, from: data),
            snapshot.mid == mid,
            Date().timeIntervalSince(snapshot.savedAt) < maximumAge
        else { return [] }
        return snapshot.chats
    }

    /// Saves `chats` for account `mid`, unless that account is no longer the
    /// signed-in one by the time the write runs (sign-out or a switch).
    static func save(_ chats: [LineChatItem], mid: String) {
        guard let url else { return }
        let snapshot = DesktopChatSnapshot(savedAt: Date(), mid: mid, chats: chats)
        DispatchQueue.global(qos: .utility).async {
            guard currentMid == mid, let data = try? JSONEncoder().encode(snapshot) else { return }
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    static func clear() {
        guard let url else { return }
        try? FileManager.default.removeItem(at: url)
    }
}
