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
