package expo.modules.signalnative

import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import uniffi.signal_native.EncryptedEnvelope
import uniffi.signal_native.OneTimePrekeyPublic
import uniffi.signal_native.PreKeyBundleData
import uniffi.signal_native.SignalDevice
import uniffi.signal_native.SignalNativeException

// Surfaced to JS as `error.code === "ERR_UNTRUSTED_IDENTITY"` (Expo Modules'
// CodedException convention) so the UI can show a specific "this contact's
// security key changed" message — see ConversationScreen.tsx /
// ConversationListScreen.tsx — instead of a generic failure. Mirrors
// uniffi.signal_native.SignalNativeException.UntrustedIdentity, which the
// Rust side raises from FileIdentityKeyStore.is_trusted_identity's
// trust-on-first-use check (packages/signal-native/rust/src/store.rs).
class UntrustedIdentityException(message: String) :
  CodedException("ERR_UNTRUSTED_IDENTITY", message, null)

private inline fun <T> translatingSignalErrors(block: () -> T): T =
  try {
    block()
  } catch (e: SignalNativeException.UntrustedIdentity) {
    throw UntrustedIdentityException(e.message ?: "peer's security key changed")
  }

// Thin bridge between Expo's JS-facing Modules API and the uniffi-generated
// Kotlin bindings (uniffi.signal_native, checked into
// android/src/main/java/uniffi/signal_native — generated from
// packages/signal-native/rust via `cargo run --bin uniffi-bindgen`, see that
// package's README for how to regenerate after changing the Rust API).
// No cryptography lives in this file — it only converts between JS-friendly
// Map<String, Any?> shapes and the real uniffi data classes, and (Milestone
// 2.5) resolves the app's private storage directory for the persistent
// encrypted store — custody of the master key itself stays JS-side, in
// expo-secure-store (app/src/crypto/masterKey.ts); this file only decodes
// the base64 it's handed.
class SignalNativeExpoModule : Module() {
  private var device: SignalDevice? = null

  private fun requireDevice(): SignalDevice =
    device ?: throw IllegalStateException(
      "SignalDevice not created — call createDevice(userId, deviceId, masterKeyBase64) first."
    )

  override fun definition() = ModuleDefinition {
    Name("SignalNativeExpo")

    Function("createDevice") { userId: String, deviceId: Int, masterKeyBase64: String ->
      val masterKey = Base64.decode(masterKeyBase64, Base64.NO_WRAP)
      val storageDir = requireNotNull(appContext.reactContext?.filesDir?.absolutePath) {
        "Could not resolve the app's private storage directory"
      }
      device = SignalDevice(userId, deviceId.toUInt(), masterKey, storageDir)
      Unit
    }

    Function("identityPublicKeyBase64") {
      requireDevice().identityPublicKeyBase64()
    }

    Function("generatePrekeyBundle") { oneTimePrekeyId: Int, signedPrekeyId: Int, kyberPrekeyId: Int ->
      bundleToMap(
        requireDevice().generatePrekeyBundle(
          oneTimePrekeyId.toUInt(),
          signedPrekeyId.toUInt(),
          kyberPrekeyId.toUInt(),
        )
      )
    }

    Function("generateExtraOneTimePrekeys") { ids: List<Int> ->
      requireDevice().generateExtraOneTimePrekeys(ids.map { it.toUInt() }).map(::oneTimePrekeyToMap)
    }

    Function("establishSession") { remoteUserId: String, remoteDeviceId: Int, bundle: Map<String, Any?> ->
      translatingSignalErrors {
        requireDevice().establishSession(remoteUserId, remoteDeviceId.toUInt(), mapToBundle(bundle))
      }
      Unit
    }

    Function("encrypt") { remoteUserId: String, remoteDeviceId: Int, plaintext: String ->
      translatingSignalErrors {
        envelopeToMap(requireDevice().encrypt(remoteUserId, remoteDeviceId.toUInt(), plaintext))
      }
    }

    Function("decrypt") { remoteUserId: String, remoteDeviceId: Int, envelope: Map<String, Any?> ->
      translatingSignalErrors {
        requireDevice().decrypt(remoteUserId, remoteDeviceId.toUInt(), mapToEnvelope(envelope))
      }
    }
  }

  private fun bundleToMap(b: PreKeyBundleData): Map<String, Any?> = mapOf(
    "registrationId" to b.registrationId.toInt(),
    "deviceId" to b.deviceId.toInt(),
    "identityKeyBase64" to b.identityKeyBase64,
    "oneTimePrekeyId" to b.oneTimePrekeyId.toInt(),
    "oneTimePrekeyPublicBase64" to b.oneTimePrekeyPublicBase64,
    "signedPrekeyId" to b.signedPrekeyId.toInt(),
    "signedPrekeyPublicBase64" to b.signedPrekeyPublicBase64,
    "signedPrekeySignatureBase64" to b.signedPrekeySignatureBase64,
    "kyberPrekeyId" to b.kyberPrekeyId.toInt(),
    "kyberPrekeyPublicBase64" to b.kyberPrekeyPublicBase64,
    "kyberPrekeySignatureBase64" to b.kyberPrekeySignatureBase64,
  )

  private fun mapToBundle(m: Map<String, Any?>): PreKeyBundleData = PreKeyBundleData(
    registrationId = (m["registrationId"] as Number).toInt().toUInt(),
    deviceId = (m["deviceId"] as Number).toInt().toUInt(),
    identityKeyBase64 = m["identityKeyBase64"] as String,
    oneTimePrekeyId = (m["oneTimePrekeyId"] as Number).toInt().toUInt(),
    oneTimePrekeyPublicBase64 = m["oneTimePrekeyPublicBase64"] as String,
    signedPrekeyId = (m["signedPrekeyId"] as Number).toInt().toUInt(),
    signedPrekeyPublicBase64 = m["signedPrekeyPublicBase64"] as String,
    signedPrekeySignatureBase64 = m["signedPrekeySignatureBase64"] as String,
    kyberPrekeyId = (m["kyberPrekeyId"] as Number).toInt().toUInt(),
    kyberPrekeyPublicBase64 = m["kyberPrekeyPublicBase64"] as String,
    kyberPrekeySignatureBase64 = m["kyberPrekeySignatureBase64"] as String,
  )

  private fun oneTimePrekeyToMap(p: OneTimePrekeyPublic): Map<String, Any?> = mapOf(
    "id" to p.id.toInt(),
    "publicKeyBase64" to p.publicKeyBase64,
  )

  private fun envelopeToMap(e: EncryptedEnvelope): Map<String, Any?> = mapOf(
    "messageType" to e.messageType.toInt(),
    "ciphertextBase64" to e.ciphertextBase64,
  )

  private fun mapToEnvelope(m: Map<String, Any?>): EncryptedEnvelope = EncryptedEnvelope(
    messageType = (m["messageType"] as Number).toInt().toUByte(),
    ciphertextBase64 = m["ciphertextBase64"] as String,
  )
}
