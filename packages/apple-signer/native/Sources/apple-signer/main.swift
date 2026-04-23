// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

//
// Native signer helper for Sui — handles both Secure Enclave and macOS
// Keychain modes via a single subprocess JSON-Lines IPC protocol.
//
// MODES
// - enclave.*   — Keys generated in the Secure Enclave via CryptoKit's
//                 SecureEnclave.P256.Signing.PrivateKey. Not extractable by
//                 anyone, ever. Persisted as opaque dataRepresentation blobs
//                 in our own JSON file under Application Support.
// - keychain.*  — Software P-256 keys in the macOS Keychain via
//                 SecKeyCreateRandomKey / SecKeyCreateWithData + SecItemAdd.
//                 Helper has silent sign access; Keychain Access.app can
//                 export with user auth. Persisted in the keychain itself.
//
// REQUEST SHAPES
//   { "id", "op": "enclave.generate", "tag", "requireBiometric"? }
//   { "id", "op": "enclave.pubkey",   "tag" }
//   { "id", "op": "enclave.sign",     "tag", "digest" /*b64*/ }
//   { "id", "op": "enclave.list" }
//   { "id", "op": "enclave.delete",   "tag" }
//
//   { "id", "op": "keychain.generate", "tag", "requireBiometric"?, "scalar"? /*b64,
//     if present imports instead of generating random */ }
//   { "id", "op": "keychain.pubkey",   "tag" }
//   { "id", "op": "keychain.sign",     "tag", "digest" /*b64*/ }
//   { "id", "op": "keychain.list" }
//   { "id", "op": "keychain.delete",   "tag" }
//
// RESPONSE SHAPES
//   { "id", "ok": true,  "data": ... }
//   { "id", "ok": false, "error": "<str>" }
//

import Foundation
import CryptoKit
import LocalAuthentication
import Security

// One LAContext for this process; first sign triggers biometric, then cached.
let signingContext = LAContext()
signingContext.localizedReason = "Sign Sui transactions"

// Used as kSecAttrService prefix + Application Support subdirectory name to
// scope keys and storage to this package.
let appId = "mysten-incubation-apple-signer"

struct Request: Codable {
    let id: String
    let op: String
    var tag: String?
    var digest: String?
    var scalar: String?
    var requireBiometric: Bool?
}

// MARK: - Emit helpers

func emit(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []) else {
        FileHandle.standardError.write("failed to encode response\n".data(using: .utf8)!)
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func success(_ id: String, _ data: [String: Any]) {
    emit(["id": id, "ok": true, "data": data])
}

func failure(_ id: String, _ error: String) {
    emit(["id": id, "ok": false, "error": error])
}

// MARK: - Shared crypto

enum KeyError: Error {
    case notFound
    case wrongClass
}

/// Compressed SEC1 encoding (33 bytes: 0x02/0x03 || X).
func compressedPublicKey(fromX963 uncompressed: Data) -> Data {
    precondition(uncompressed.count == 65 && uncompressed[0] == 0x04)
    let x = uncompressed.subdata(in: 1..<33)
    let y = uncompressed.subdata(in: 33..<65)
    var out = Data(count: 33)
    out[0] = (y[31] & 1) == 0 ? 0x02 : 0x03
    out.replaceSubrange(1..<33, with: x)
    return out
}

func compressedPublicKey(_ key: P256.Signing.PublicKey) -> Data {
    return compressedPublicKey(fromX963: key.x963Representation)
}

func makeAccessControl(requireBiometric: Bool, forPrivateKey: Bool) throws -> SecAccessControl {
    var flags: SecAccessControlCreateFlags = forPrivateKey ? [.privateKeyUsage] : []
    if requireBiometric { flags.insert(.userPresence) }
    var err: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        flags,
        &err
    ) else {
        throw (err?.takeRetainedValue() as? Error) ?? NSError(domain: "SecAccessControl", code: -1)
    }
    return access
}

// MARK: - Enclave storage (JSON file with dataRepresentation blobs)

let enclaveStorageDir: URL = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    return base.appendingPathComponent(appId, isDirectory: true)
}()
let enclaveStorageFile: URL = enclaveStorageDir.appendingPathComponent("enclave-keys.json")

func loadEnclaveStore() -> [String: String] {
    guard let data = try? Data(contentsOf: enclaveStorageFile) else { return [:] }
    return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
}

func saveEnclaveStore(_ store: [String: String]) throws {
    try FileManager.default.createDirectory(at: enclaveStorageDir, withIntermediateDirectories: true)
    let data = try JSONEncoder().encode(store)
    try data.write(to: enclaveStorageFile, options: [.atomic])
    try FileManager.default.setAttributes(
        [.posixPermissions: 0o600],
        ofItemAtPath: enclaveStorageFile.path
    )
}

func loadEnclaveKey(tag: String) throws -> SecureEnclave.P256.Signing.PrivateKey {
    let store = loadEnclaveStore()
    guard let blobB64 = store[tag], let blob = Data(base64Encoded: blobB64) else {
        throw KeyError.notFound
    }
    return try SecureEnclave.P256.Signing.PrivateKey(
        dataRepresentation: blob,
        authenticationContext: signingContext
    )
}

// MARK: - Enclave handlers

func handleEnclaveGenerate(id: String, tag: String, requireBiometric: Bool) {
    var store = loadEnclaveStore()
    if store[tag] != nil {
        failure(id, "enclave key with tag '\(tag)' already exists; use pubkey or delete")
        return
    }
    do {
        let access = try makeAccessControl(requireBiometric: requireBiometric, forPrivateKey: true)
        let key = try SecureEnclave.P256.Signing.PrivateKey(
            accessControl: access,
            authenticationContext: signingContext
        )
        store[tag] = key.dataRepresentation.base64EncodedString()
        try saveEnclaveStore(store)
        success(id, ["publicKey": compressedPublicKey(key.publicKey).base64EncodedString()])
    } catch {
        failure(id, error.localizedDescription)
    }
}

func handleEnclavePubkey(id: String, tag: String) {
    do {
        let key = try loadEnclaveKey(tag: tag)
        success(id, ["publicKey": compressedPublicKey(key.publicKey).base64EncodedString()])
    } catch KeyError.notFound {
        failure(id, "enclave key with tag '\(tag)' not found")
    } catch {
        failure(id, error.localizedDescription)
    }
}

func handleEnclaveSign(id: String, tag: String, digestB64: String) {
    guard let digest = Data(base64Encoded: digestB64) else {
        failure(id, "digest is not valid base64")
        return
    }
    do {
        let key = try loadEnclaveKey(tag: tag)
        let sig = try key.signature(for: digest)
        success(id, ["signature": sig.derRepresentation.base64EncodedString()])
    } catch KeyError.notFound {
        failure(id, "enclave key with tag '\(tag)' not found")
    } catch {
        failure(id, error.localizedDescription)
    }
}

func handleEnclaveList(id: String) {
    let tags = Array(loadEnclaveStore().keys)
    success(id, ["tags": tags])
}

func handleEnclaveDelete(id: String, tag: String) {
    var store = loadEnclaveStore()
    if store.removeValue(forKey: tag) != nil {
        do {
            try saveEnclaveStore(store)
            success(id, ["deleted": true])
        } catch {
            failure(id, error.localizedDescription)
        }
    } else {
        success(id, ["deleted": false])
    }
}

// MARK: - Keychain helpers

/// We scope keychain items with kSecAttrService so they don't collide with
/// other apps' P-256 keys on the user's machine. The tag goes in
/// kSecAttrApplicationTag (raw UTF-8) for easy lookup.
let keychainService = appId

func keychainTagData(_ tag: String) -> Data {
    return tag.data(using: .utf8)!
}

func keychainQuery(forTag tag: String, withContext: Bool = false) -> [String: Any] {
    var q: [String: Any] = [
        kSecClass as String: kSecClassKey,
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
        kSecAttrApplicationTag as String: keychainTagData(tag),
        kSecAttrLabel as String: "\(appId):\(tag)",
    ]
    if withContext {
        q[kSecUseAuthenticationContext as String] = signingContext
    }
    return q
}

func keychainLoadKey(tag: String) -> SecKey? {
    var q = keychainQuery(forTag: tag, withContext: true)
    q[kSecReturnRef as String] = true
    var item: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &item)
    guard status == errSecSuccess, let ref = item else { return nil }
    return (ref as! SecKey)
}

/// Add a SecKey reference to the keychain with the right attributes for our
/// per-op ACL: helper has silent sign access; Keychain Access.app requires
/// user auth to export (via macOS's standard extractable-key UX).
func keychainAddKey(
    _ priv: SecKey,
    tag: String,
    requireBiometric: Bool
) throws {
    let access = try makeAccessControl(requireBiometric: requireBiometric, forPrivateKey: true)
    let attrs: [String: Any] = [
        kSecClass as String: kSecClassKey,
        kSecValueRef as String: priv,
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
        kSecAttrIsPermanent as String: true,
        kSecAttrIsExtractable as String: true,
        kSecAttrApplicationTag as String: keychainTagData(tag),
        kSecAttrLabel as String: "\(appId):\(tag)",
        kSecAttrAccessControl as String: access,
    ]
    let status = SecItemAdd(attrs as CFDictionary, nil)
    if status == errSecMissingEntitlement {
        throw NSError(
            domain: NSOSStatusErrorDomain,
            code: Int(status),
            userInfo: [NSLocalizedDescriptionKey:
                "SecItemAdd failed with errSecMissingEntitlement (-34018). Keychain mode " +
                "requires the helper to be signed with a Developer ID certificate and declare a " +
                "matching keychain-access-groups entitlement. Ad-hoc signed builds work for " +
                "enclave mode only. See docs on distribution for the proper signing pipeline."]
        )
    }
    if status != errSecSuccess {
        throw NSError(
            domain: NSOSStatusErrorDomain,
            code: Int(status),
            userInfo: [NSLocalizedDescriptionKey: "SecItemAdd failed with OSStatus \(status)"]
        )
    }
}

// MARK: - Keychain handlers

func handleKeychainGenerate(
    id: String,
    tag: String,
    requireBiometric: Bool,
    scalarB64: String?
) {
    if keychainLoadKey(tag: tag) != nil {
        failure(id, "keychain key with tag '\(tag)' already exists; use pubkey or delete")
        return
    }
    do {
        let priv: SecKey
        if let scalarB64 = scalarB64, let scalar = Data(base64Encoded: scalarB64) {
            guard scalar.count == 32 else {
                failure(id, "keychain.generate: expected 32-byte scalar, got \(scalar.count)")
                return
            }
            // Use CryptoKit to derive X,Y from scalar → x963 blob, then SecKeyCreateWithData.
            let temp = try P256.Signing.PrivateKey(rawRepresentation: scalar)
            let x963 = temp.x963Representation // 0x04 || X(32) || Y(32) || K(32)
            let attrs: [String: Any] = [
                kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
                kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
                kSecAttrKeySizeInBits as String: 256,
            ]
            var err: Unmanaged<CFError>?
            guard let imported = SecKeyCreateWithData(x963 as CFData, attrs as CFDictionary, &err) else {
                throw (err?.takeRetainedValue() as? Error) ?? NSError(domain: "SecKey", code: -1)
            }
            priv = imported
        } else {
            // Random P-256 via CryptoKit, then cross over to SecKey for keychain storage.
            let fresh = P256.Signing.PrivateKey()
            let x963 = fresh.x963Representation
            let attrs: [String: Any] = [
                kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
                kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
                kSecAttrKeySizeInBits as String: 256,
            ]
            var err: Unmanaged<CFError>?
            guard let generated = SecKeyCreateWithData(x963 as CFData, attrs as CFDictionary, &err) else {
                throw (err?.takeRetainedValue() as? Error) ?? NSError(domain: "SecKey", code: -1)
            }
            priv = generated
        }

        try keychainAddKey(priv, tag: tag, requireBiometric: requireBiometric)

        guard let pub = SecKeyCopyPublicKey(priv) else {
            throw NSError(domain: "SecKey", code: -1, userInfo: [NSLocalizedDescriptionKey: "SecKeyCopyPublicKey returned nil"])
        }
        var pubErr: Unmanaged<CFError>?
        guard let uncompressed = SecKeyCopyExternalRepresentation(pub, &pubErr) as Data? else {
            throw (pubErr?.takeRetainedValue() as? Error) ?? NSError(domain: "SecKey", code: -1)
        }
        success(id, ["publicKey": compressedPublicKey(fromX963: uncompressed).base64EncodedString()])
    } catch {
        failure(id, error.localizedDescription)
    }
}

func handleKeychainPubkey(id: String, tag: String) {
    guard let priv = keychainLoadKey(tag: tag) else {
        failure(id, "keychain key with tag '\(tag)' not found")
        return
    }
    do {
        guard let pub = SecKeyCopyPublicKey(priv) else {
            throw NSError(domain: "SecKey", code: -1, userInfo: [NSLocalizedDescriptionKey: "SecKeyCopyPublicKey returned nil"])
        }
        var err: Unmanaged<CFError>?
        guard let uncompressed = SecKeyCopyExternalRepresentation(pub, &err) as Data? else {
            throw (err?.takeRetainedValue() as? Error) ?? NSError(domain: "SecKey", code: -1)
        }
        success(id, ["publicKey": compressedPublicKey(fromX963: uncompressed).base64EncodedString()])
    } catch {
        failure(id, error.localizedDescription)
    }
}

func handleKeychainSign(id: String, tag: String, digestB64: String) {
    guard let priv = keychainLoadKey(tag: tag) else {
        failure(id, "keychain key with tag '\(tag)' not found")
        return
    }
    guard let digest = Data(base64Encoded: digestB64) else {
        failure(id, "digest is not valid base64")
        return
    }
    var err: Unmanaged<CFError>?
    // ecdsaSignatureMessageX962SHA256 SHA-256s then signs. Matches Sui's
    // Secp256r1 verifier (noble's default prehash:true).
    guard let sig = SecKeyCreateSignature(
        priv,
        .ecdsaSignatureMessageX962SHA256,
        digest as CFData,
        &err
    ) as Data? else {
        failure(id, ((err?.takeRetainedValue() as? Error)?.localizedDescription) ?? "keychain signing failed")
        return
    }
    success(id, ["signature": sig.base64EncodedString()])
}

func handleKeychainList(id: String) {
    let query: [String: Any] = [
        kSecClass as String: kSecClassKey,
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
        kSecMatchLimit as String: kSecMatchLimitAll,
        kSecReturnAttributes as String: true,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
        success(id, ["tags": []])
        return
    }
    guard status == errSecSuccess, let items = result as? [[String: Any]] else {
        failure(id, "SecItemCopyMatching status \(status)")
        return
    }
    // Only return items whose label matches our app namespace.
    let prefix = "\(appId):"
    let tags: [String] = items.compactMap { item in
        guard let label = item[kSecAttrLabel as String] as? String,
              label.hasPrefix(prefix),
              let tagData = item[kSecAttrApplicationTag as String] as? Data
        else { return nil }
        return String(data: tagData, encoding: .utf8)
    }
    success(id, ["tags": tags])
}

func handleKeychainDelete(id: String, tag: String) {
    let q = keychainQuery(forTag: tag, withContext: false)
    let status = SecItemDelete(q as CFDictionary)
    if status == errSecSuccess {
        success(id, ["deleted": true])
    } else if status == errSecItemNotFound {
        success(id, ["deleted": false])
    } else {
        failure(id, "SecItemDelete status \(status)")
    }
}

// MARK: - Main loop

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { continue }
    guard let data = trimmed.data(using: .utf8) else { continue }

    let req: Request
    do {
        req = try JSONDecoder().decode(Request.self, from: data)
    } catch {
        emit(["id": "", "ok": false, "error": "invalid JSON: \(error.localizedDescription)"])
        continue
    }

    switch req.op {
    case "enclave.generate":
        guard let tag = req.tag else { failure(req.id, "missing tag"); continue }
        handleEnclaveGenerate(id: req.id, tag: tag, requireBiometric: req.requireBiometric ?? true)
    case "enclave.pubkey":
        guard let tag = req.tag else { failure(req.id, "missing tag"); continue }
        handleEnclavePubkey(id: req.id, tag: tag)
    case "enclave.sign":
        guard let tag = req.tag, let digest = req.digest else {
            failure(req.id, "missing tag or digest"); continue
        }
        handleEnclaveSign(id: req.id, tag: tag, digestB64: digest)
    case "enclave.list":
        handleEnclaveList(id: req.id)
    case "enclave.delete":
        guard let tag = req.tag else { failure(req.id, "missing tag"); continue }
        handleEnclaveDelete(id: req.id, tag: tag)

    case "keychain.generate":
        guard let tag = req.tag else { failure(req.id, "missing tag"); continue }
        handleKeychainGenerate(
            id: req.id,
            tag: tag,
            requireBiometric: req.requireBiometric ?? true,
            scalarB64: req.scalar
        )
    case "keychain.pubkey":
        guard let tag = req.tag else { failure(req.id, "missing tag"); continue }
        handleKeychainPubkey(id: req.id, tag: tag)
    case "keychain.sign":
        guard let tag = req.tag, let digest = req.digest else {
            failure(req.id, "missing tag or digest"); continue
        }
        handleKeychainSign(id: req.id, tag: tag, digestB64: digest)
    case "keychain.list":
        handleKeychainList(id: req.id)
    case "keychain.delete":
        guard let tag = req.tag else { failure(req.id, "missing tag"); continue }
        handleKeychainDelete(id: req.id, tag: tag)

    default:
        failure(req.id, "unknown op: \(req.op)")
    }
}
