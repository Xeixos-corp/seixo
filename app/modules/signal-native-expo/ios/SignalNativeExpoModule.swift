import ExpoModulesCore
import Foundation

// Thin bridge between Expo's JS-facing Modules API and the uniffi-generated
// Swift bindings (ios/generated/signal_native.swift — generated from
// packages/signal-native/rust via `cargo run --bin uniffi-bindgen`, see that
// package's README for how to regenerate after changing the Rust API).
// Mirrors android/src/main/java/expo/modules/signalnative/SignalNativeExpoModule.kt.
// No cryptography lives in this file — it only converts between JS-friendly
// dictionaries and the real uniffi types, and (Milestone 2.5) resolves the
// app's Application Support directory for the persistent encrypted store —
// custody of the master key itself stays JS-side, in expo-secure-store
// (app/src/crypto/masterKey.ts); this file only decodes the base64 it's handed.
//
// NOT YET BUILD-VERIFIED: written without access to Xcode/a Mac (see
// packages/signal-native/README.md) — first real signal comes from an EAS
// Build run. Expected rough edges: the module map wiring for
// signal_nativeFFI.h (see ios/SignalNativeExpo.podspec) in particular.
public class SignalNativeExpoModule: Module {
  private var device: SignalDevice?

  private func requireDevice() throws -> SignalDevice {
    guard let device else {
      throw SignalNativeExpoError.notInitialized
    }
    return device
  }

  private static func resolveStorageDir() throws -> String {
    let fileManager = FileManager.default
    let baseUrl = try fileManager.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let dir = baseUrl.appendingPathComponent("signal-native", isDirectory: true)
    try fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.path
  }

  public func definition() -> ModuleDefinition {
    Name("SignalNativeExpo")

    Function("createDevice") { (userId: String, deviceId: Int, masterKeyBase64: String) in
      guard let masterKey = Data(base64Encoded: masterKeyBase64) else {
        throw SignalNativeExpoError.invalidBundle
      }
      let storageDir = try SignalNativeExpoModule.resolveStorageDir()
      self.device = try SignalDevice(
        userId: userId,
        deviceId: UInt32(deviceId),
        masterKey: masterKey,
        storageDir: storageDir
      )
    }

    Function("identityPublicKeyBase64") { () -> String in
      try self.requireDevice().identityPublicKeyBase64()
    }

    // App Store Guideline 5.1.1(v) account deletion: mirrors the Kotlin
    // wipeLocalStore() — see that file's comment for why this is needed
    // (without it, a later createDevice() would silently reload the
    // deleted account's old identity from disk).
    Function("wipeLocalStore") {
      self.device = nil
      let storageDir = try SignalNativeExpoModule.resolveStorageDir()
      let fileManager = FileManager.default
      for name in ["identity.enc", "prekeys.enc", "signed_prekeys.enc", "kyber_prekeys.enc", "sessions.enc"] {
        let path = (storageDir as NSString).appendingPathComponent(name)
        try? fileManager.removeItem(atPath: path)
      }
    }

    // --- Recovery backups (packages/signal-native/rust/src/backup.rs) ---
    // Note what does NOT cross this boundary: exportIdentitySecret's result
    // goes straight into encryptBackup below and is never handed to JS on its
    // own. Whoever holds that value can be this user to every contact.

    Function("createRecoveryBackup") { (phrase: String, contents: String) -> String in
      let secret = try self.requireDevice().exportIdentitySecret()
      var payload = try JSONSerialization.jsonObject(with: Data(contents.utf8)) as? [String: Any] ?? [:]
      payload["identityKeyPairBase64"] = secret.identityKeyPairBase64
      payload["registrationId"] = secret.registrationId
      let json = try JSONSerialization.data(withJSONObject: payload)
      return try encryptBackup(phrase: phrase, plaintext: String(decoding: json, as: UTF8.self))
    }

    Function("readRecoveryBackup") { (phrase: String, blob: String) -> String in
      try decryptBackup(phrase: phrase, blob: blob)
    }

    // Images, file to file. React Native has no usable Blob or File, so a
    // photo passed through JavaScript would have to become a base64 string
    // a third larger than itself, twice over. Here JS only ever holds paths
    // and a key; the bytes go from disk to Rust to disk without crossing.
    //
    // Async because a photo is up to two megabytes of reading, sealing and
    // writing -- not something to do on the thread that draws the screen.
    AsyncFunction("sealAttachmentFile") { (inputUri: String) -> [String: Any] in
      let plaintext = try Data(contentsOf: try Self.fileURL(inputUri))
      let result = try sealAttachment(plaintext: plaintext)
      let output = try Self.attachmentDirectory("sealed")
        .appendingPathComponent(UUID().uuidString + ".bin")
      // Sealed already, so ordinary protection is enough; it exists only
      // until the upload finishes.
      try result.sealed.write(to: output, options: [.atomic])
      return [
        "sealedUri": output.absoluteString,
        "keyBase64": result.key.base64EncodedString(),
        "size": result.sealed.count,
      ]
    }

    AsyncFunction("openAttachmentFile") { (sealedUri: String, keyBase64: String) -> String in
      guard let key = Data(base64Encoded: keyBase64) else {
        throw SignalNativeExpoError.invalidEnvelope
      }
      let sealed = try Data(contentsOf: try Self.fileURL(sealedUri))
      let plaintext = try openAttachment(key: key, sealed: sealed)
      let output = try Self.attachmentDirectory("opened")
        .appendingPathComponent(UUID().uuidString + ".jpg")
      // The decrypted picture is the one file here worth protecting: complete
      // protection makes it unreadable whenever the phone is locked, not only
      // before the first unlock after boot.
      try plaintext.write(to: output, options: [.atomic, .completeFileProtection])
      return output.absoluteString
    }

    // Everything in both directories, for the app to call when it clears its
    // caches. Decrypted pictures must not outlive the messages they came from,
    // and a crash between opening one and its message expiring would
    // otherwise leave it behind.
    Function("clearAttachmentFiles") {
      for name in ["sealed", "opened"] {
        let directory = try Self.attachmentDirectory(name)
        try? FileManager.default.removeItem(at: directory)
      }
    }

    // Plants a restored identity so the next createDevice() adopts it. Rust
    // refuses if a store is already present, so this cannot quietly replace a
    // working identity with a different one.
    Function("restoreIdentityFromBackup") { (identityKeyPairBase64: String, registrationId: Int, masterKeyBase64: String) in
      guard let masterKey = Data(base64Encoded: masterKeyBase64) else {
        throw SignalNativeExpoError.invalidBundle
      }
      let storageDir = try SignalNativeExpoModule.resolveStorageDir()
      try restoreIdentity(
        masterKey: masterKey,
        storageDir: storageDir,
        secret: IdentitySecret(
          identityKeyPairBase64: identityKeyPairBase64,
          registrationId: UInt32(registrationId)
        )
      )
      self.device = nil
    }

    Function("generateRecoveryPhrase") { () -> String in
      try generateRecoveryPhrase()
    }

    Function("isValidRecoveryPhrase") { (phrase: String) -> Bool in
      isValidRecoveryPhrase(phrase: phrase)
    }

    // The account half of a recovery: a credential pair derived from the
    // phrase, so re-entering the same account needs nothing stored anywhere.
    Function("deriveBackupCredentials") { (phrase: String) -> [String: Any] in
      let credentials = try deriveBackupCredentials(phrase: phrase)
      return ["email": credentials.email, "password": credentials.password]
    }

    Function("generatePrekeyBundle") { (oneTimePrekeyId: Int, signedPrekeyId: Int, kyberPrekeyId: Int) -> [String: Any] in
      let bundle = try self.requireDevice().generatePrekeyBundle(
        oneTimePrekeyId: UInt32(oneTimePrekeyId),
        signedPrekeyId: UInt32(signedPrekeyId),
        kyberPrekeyId: UInt32(kyberPrekeyId)
      )
      return SignalNativeExpoModule.bundleToDict(bundle)
    }

    Function("generateExtraOneTimePrekeys") { (ids: [Int]) -> [[String: Any]] in
      let extras = try self.requireDevice().generateExtraOneTimePrekeys(ids: ids.map { UInt32($0) })
      return extras.map(SignalNativeExpoModule.oneTimePrekeyToDict)
    }

    Function("rotateSignedPrekeys") { (signedPrekeyId: Int, kyberPrekeyId: Int) -> [String: Any] in
      let rotated = try self.requireDevice().rotateSignedPrekeys(
        signedPrekeyId: UInt32(signedPrekeyId),
        kyberPrekeyId: UInt32(kyberPrekeyId)
      )
      return [
        "signedPrekeyId": Int(rotated.signedPrekeyId),
        "signedPrekeyPublicBase64": rotated.signedPrekeyPublicBase64,
        "signedPrekeySignatureBase64": rotated.signedPrekeySignatureBase64,
        "kyberPrekeyId": Int(rotated.kyberPrekeyId),
        "kyberPrekeyPublicBase64": rotated.kyberPrekeyPublicBase64,
        "kyberPrekeySignatureBase64": rotated.kyberPrekeySignatureBase64,
      ]
    }

    Function("prunePrekeys") { (keepSignedIds: [Int], keepKyberIds: [Int]) in
      try self.requireDevice().prunePrekeys(
        keepSignedIds: keepSignedIds.map { UInt32($0) },
        keepKyberIds: keepKyberIds.map { UInt32($0) }
      )
    }

    Function("safetyNumber") { (remoteUserId: String, remoteIdentityKeyBase64: String) -> String in
      try self.requireDevice().safetyNumber(
        remoteUserId: remoteUserId,
        remoteIdentityKeyBase64: remoteIdentityKeyBase64
      )
    }

    Function("forgetPeerIdentity") { (remoteUserId: String, remoteDeviceId: Int) in
      try self.requireDevice().forgetPeerIdentity(
        remoteUserId: remoteUserId,
        remoteDeviceId: UInt32(remoteDeviceId)
      )
    }

    Function("establishSession") { (remoteUserId: String, remoteDeviceId: Int, bundle: [String: Any]) in
      try SignalNativeExpoModule.translatingSignalErrors {
        try self.requireDevice().establishSession(
          remoteUserId: remoteUserId,
          remoteDeviceId: UInt32(remoteDeviceId),
          bundle: try SignalNativeExpoModule.dictToBundle(bundle)
        )
      }
    }

    Function("encrypt") { (remoteUserId: String, remoteDeviceId: Int, plaintext: String) -> [String: Any] in
      try SignalNativeExpoModule.translatingSignalErrors {
        let envelope = try self.requireDevice().encrypt(
          remoteUserId: remoteUserId,
          remoteDeviceId: UInt32(remoteDeviceId),
          plaintext: plaintext
        )
        return SignalNativeExpoModule.envelopeToDict(envelope)
      }
    }

    Function("decrypt") { (remoteUserId: String, remoteDeviceId: Int, envelope: [String: Any]) -> String in
      try SignalNativeExpoModule.translatingSignalErrors {
        try self.requireDevice().decrypt(
          remoteUserId: remoteUserId,
          remoteDeviceId: UInt32(remoteDeviceId),
          envelope: try SignalNativeExpoModule.dictToEnvelope(envelope)
        )
      }
    }
  }

  private static func bundleToDict(_ bundle: PreKeyBundleData) -> [String: Any] {
    [
      "registrationId": Int(bundle.registrationId),
      "deviceId": Int(bundle.deviceId),
      "identityKeyBase64": bundle.identityKeyBase64,
      "oneTimePrekeyId": Int(bundle.oneTimePrekeyId),
      "oneTimePrekeyPublicBase64": bundle.oneTimePrekeyPublicBase64,
      "signedPrekeyId": Int(bundle.signedPrekeyId),
      "signedPrekeyPublicBase64": bundle.signedPrekeyPublicBase64,
      "signedPrekeySignatureBase64": bundle.signedPrekeySignatureBase64,
      "kyberPrekeyId": Int(bundle.kyberPrekeyId),
      "kyberPrekeyPublicBase64": bundle.kyberPrekeyPublicBase64,
      "kyberPrekeySignatureBase64": bundle.kyberPrekeySignatureBase64,
    ]
  }

  private static func dictToBundle(_ dict: [String: Any]) throws -> PreKeyBundleData {
    guard
      let registrationId = dict["registrationId"] as? Int,
      let deviceId = dict["deviceId"] as? Int,
      let identityKeyBase64 = dict["identityKeyBase64"] as? String,
      let oneTimePrekeyId = dict["oneTimePrekeyId"] as? Int,
      let oneTimePrekeyPublicBase64 = dict["oneTimePrekeyPublicBase64"] as? String,
      let signedPrekeyId = dict["signedPrekeyId"] as? Int,
      let signedPrekeyPublicBase64 = dict["signedPrekeyPublicBase64"] as? String,
      let signedPrekeySignatureBase64 = dict["signedPrekeySignatureBase64"] as? String,
      let kyberPrekeyId = dict["kyberPrekeyId"] as? Int,
      let kyberPrekeyPublicBase64 = dict["kyberPrekeyPublicBase64"] as? String,
      let kyberPrekeySignatureBase64 = dict["kyberPrekeySignatureBase64"] as? String
    else {
      throw SignalNativeExpoError.invalidBundle
    }
    return PreKeyBundleData(
      registrationId: UInt32(registrationId),
      deviceId: UInt32(deviceId),
      identityKeyBase64: identityKeyBase64,
      oneTimePrekeyId: UInt32(oneTimePrekeyId),
      oneTimePrekeyPublicBase64: oneTimePrekeyPublicBase64,
      signedPrekeyId: UInt32(signedPrekeyId),
      signedPrekeyPublicBase64: signedPrekeyPublicBase64,
      signedPrekeySignatureBase64: signedPrekeySignatureBase64,
      kyberPrekeyId: UInt32(kyberPrekeyId),
      kyberPrekeyPublicBase64: kyberPrekeyPublicBase64,
      kyberPrekeySignatureBase64: kyberPrekeySignatureBase64
    )
  }

  // Surfaced to JS as `error.code === "ERR_UNTRUSTED_IDENTITY"` (Expo's
  // Exception.code convention) — see UntrustedIdentityException below and
  // the matching Kotlin translatingSignalErrors in
  // SignalNativeExpoModule.kt for why this exists.
  private static func translatingSignalErrors<T>(_ block: () throws -> T) throws -> T {
    do {
      return try block()
    } catch SignalNativeError.UntrustedIdentity(let message) {
      throw UntrustedIdentityException(message)
    }
  }

  private static func oneTimePrekeyToDict(_ prekey: OneTimePrekeyPublic) -> [String: Any] {
    ["id": Int(prekey.id), "publicKeyBase64": prekey.publicKeyBase64]
  }

  private static func envelopeToDict(_ envelope: EncryptedEnvelope) -> [String: Any] {
    ["messageType": Int(envelope.messageType), "ciphertextBase64": envelope.ciphertextBase64]
  }

  private static func dictToEnvelope(_ dict: [String: Any]) throws -> EncryptedEnvelope {
    guard
      let messageType = dict["messageType"] as? Int,
      let ciphertextBase64 = dict["ciphertextBase64"] as? String
    else {
      throw SignalNativeExpoError.invalidEnvelope
    }
    return EncryptedEnvelope(messageType: UInt8(messageType), ciphertextBase64: ciphertextBase64)
  }
}

enum SignalNativeExpoError: Error {
  case notInitialized
  case invalidBundle
  case invalidEnvelope
  case invalidFileUri
}

extension SignalNativeExpoModule {
  /// Accepts either a `file://` URI, which is what the image tools hand to
  /// JavaScript, or a bare path. Anything else is refused rather than guessed
  /// at: this must only ever read files the app itself put there.
  static func fileURL(_ uriOrPath: String) throws -> URL {
    if uriOrPath.hasPrefix("file://") {
      guard let url = URL(string: uriOrPath), url.isFileURL else {
        throw SignalNativeExpoError.invalidFileUri
      }
      return url
    }
    guard uriOrPath.hasPrefix("/") else {
      throw SignalNativeExpoError.invalidFileUri
    }
    return URL(fileURLWithPath: uriOrPath)
  }

  /// A subdirectory of Caches. Caches rather than Documents on purpose: iOS
  /// never backs it up to iCloud, and may empty it under storage pressure --
  /// both right for files that are meant to disappear anyway.
  static func attachmentDirectory(_ name: String) throws -> URL {
    let caches = try FileManager.default.url(
      for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    )
    let directory = caches.appendingPathComponent("seixo-attachments/\(name)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }
}

class UntrustedIdentityException: Exception {
  private let detail: String

  init(_ detail: String) {
    self.detail = detail
    super.init()
  }

  override var reason: String { detail }
  override var code: String { "ERR_UNTRUSTED_IDENTITY" }
}
