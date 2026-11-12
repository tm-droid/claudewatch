import Foundation
import Security

/// Where the relay lives and the token that unlocks it.
public struct Pairing: Codable, Hashable, Sendable {
    public var url: URL
    public var token: String

    public init(url: URL, token: String) {
        self.url = url
        self.token = token
    }

    /// Parses `claudewatch://pair?u=<url>&t=<token>`.
    public init?(link: String) {
        guard let comps = URLComponents(string: link.trimmingCharacters(in: .whitespacesAndNewlines)),
              comps.scheme == "claudewatch", comps.host == "pair",
              let u = comps.queryItems?.first(where: { $0.name == "u" })?.value,
              let t = comps.queryItems?.first(where: { $0.name == "t" })?.value,
              let url = URL(string: u), let scheme = url.scheme, ["https", "http"].contains(scheme),
              t.count >= 20
        else { return nil }
        self.url = url
        self.token = t
    }

    public var host: String { url.host() ?? url.absoluteString }
}

public enum Shared {
    public static let keychainService = "com.tanushmalhotra.claudewatch.pairing"
    /// Set from the app's Info.plist (KeychainAccessGroup) so the widget can read the pairing too.
    public static var keychainAccessGroup: String? {
        Bundle.main.object(forInfoDictionaryKey: "KeychainAccessGroup") as? String
    }

    public static var cacheURL: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    }
}

/// Small Codable values in the Keychain. With a shared access group the app and its widget both see them
/// (free Apple IDs can't use App Groups, but keychain sharing works).
public enum KeychainBox {
    /// Turned off if the build lacks the keychain-sharing entitlement (e.g. unsigned simulator builds).
    nonisolated(unsafe) private static var useGroup = true

    private static func query(_ account: String) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Shared.keychainService,
            kSecAttrAccount as String: account,
        ]
        if useGroup, let g = Shared.keychainAccessGroup, !g.isEmpty, !g.hasPrefix("$(") { q[kSecAttrAccessGroup as String] = g }
        return q
    }

    public static func load<T: Decodable>(_ type: T.Type, account: String) -> T? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecMissingEntitlement, useGroup { useGroup = false; return load(type, account: account) }
        guard status == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    @discardableResult
    public static func save<T: Encodable>(_ value: T, account: String) -> Bool {
        guard let data = try? JSONEncoder().encode(value) else { return false }
        let q = query(account)
        let attrs: [String: Any] = [kSecValueData as String: data]
        if SecItemUpdate(q as CFDictionary, attrs as CFDictionary) == errSecSuccess { return true }
        var add = q
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecMissingEntitlement, useGroup { useGroup = false; return save(value, account: account) }
        return status == errSecSuccess
    }

    public static func delete(account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }
}

public enum PairingStore {
    public static func load() -> Pairing? { KeychainBox.load(Pairing.self, account: "relay") }
    @discardableResult public static func save(_ p: Pairing) -> Bool { KeychainBox.save(p, account: "relay") }
    public static func clear() { KeychainBox.delete(account: "relay") }
}
