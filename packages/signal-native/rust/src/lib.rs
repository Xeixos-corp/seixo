//! Milestone 1: real Signal Protocol integration, wrapping the official
//! `signalapp/libsignal` `libsignal-protocol` crate (X3DH/PQXDH + Double
//! Ratchet). No custom cryptography is implemented here — every security
//! primitive (key agreement, ratcheting, signing) is delegated to that crate.
//! See packages/signal-native/README.md for the status/roadmap this replaces.
//!
//! `libsignal-protocol`'s store traits and top-level functions
//! (`process_prekey_bundle`, `message_encrypt`, `message_decrypt`) are async
//! but explicitly `?Send` (see storage/traits.rs upstream), so a
//! single-threaded `tokio` runtime driven via `block_on` per call is enough —
//! no cross-thread executor bridging is needed for this stub-to-real
//! transition. A future revision may expose true async to the RN side.

use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use libsignal_protocol::{
    CiphertextMessage, CiphertextMessageType, DeviceId, GenericSignedPreKey, IdentityKey,
    IdentityKeyPair, IdentityKeyStore, KeyPair, KyberPreKeyId, KyberPreKeyRecord, KyberPreKeyStore,
    PreKeyBundle, PreKeyId, PreKeyRecord, PreKeySignalMessage, PreKeyStore, ProtocolAddress,
    PublicKey, SignalMessage, SignedPreKeyId, SignedPreKeyRecord, SignedPreKeyStore, Timestamp,
    kem, message_decrypt, message_encrypt, process_prekey_bundle,
};
use rand::TryRngCore as _;

mod store;
use store::PersistentSignalProtocolStore;

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum SignalNativeError {
    #[error("signal protocol error: {0}")]
    Protocol(String),
    #[error("invalid base64: {0}")]
    Base64(String),
    #[error("invalid utf8 in decrypted plaintext")]
    Utf8,
    #[error("invalid device id: {0}")]
    InvalidDeviceId(u32),
    #[error("local storage error: {0}")]
    Storage(String),
    #[error("master key must be exactly 32 bytes, got {0}")]
    InvalidMasterKeyLength(usize),
    /// The peer's identity key doesn't match what we last saw for them
    /// (`FileIdentityKeyStore::is_trusted_identity` in store.rs, trust-on-
    /// first-use) — either their app reinstalled and generated a fresh
    /// identity, or a MITM is presenting a different key. Kept as its own
    /// variant (not folded into `Protocol`) so the app can show a specific
    /// "this contact's security key changed" message instead of a generic
    /// decrypt-failed error — the equivalent of Signal's safety number
    /// change warning. Callers must not silently retry past this.
    #[error("untrusted identity for {user_id} (device {device_id}): their key changed since the last known session")]
    UntrustedIdentity { user_id: String, device_id: u32 },
}

impl From<libsignal_protocol::SignalProtocolError> for SignalNativeError {
    fn from(e: libsignal_protocol::SignalProtocolError) -> Self {
        match e {
            libsignal_protocol::SignalProtocolError::UntrustedIdentity(address) => {
                SignalNativeError::UntrustedIdentity {
                    user_id: address.name().to_string(),
                    device_id: u32::from(address.device_id()),
                }
            }
            other => SignalNativeError::Protocol(other.to_string()),
        }
    }
}

fn b64_decode(s: &str) -> Result<Vec<u8>, SignalNativeError> {
    BASE64
        .decode(s)
        .map_err(|e| SignalNativeError::Base64(e.to_string()))
}

fn b64_encode(bytes: impl AsRef<[u8]>) -> String {
    BASE64.encode(bytes)
}

fn make_address(user_id: &str, device_id: u32) -> Result<ProtocolAddress, SignalNativeError> {
    let device_id: DeviceId = device_id
        .try_into()
        .map_err(|_| SignalNativeError::InvalidDeviceId(device_id))?;
    Ok(ProtocolAddress::new(user_id.to_string(), device_id))
}

fn blocking_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("failed to start local tokio runtime")
}

fn now_timestamp() -> Timestamp {
    let millis = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("system clock is before the unix epoch")
        .as_millis() as u64;
    Timestamp::from_epoch_millis(millis)
}

/// The public half of a device's prekey material, as published to the
/// server (Supabase `signed_prekeys` / `one_time_prekeys` tables) for other
/// devices to fetch and use in `SignalDevice::establish_session`.
#[derive(uniffi::Record)]
pub struct PreKeyBundleData {
    pub registration_id: u32,
    pub device_id: u32,
    pub identity_key_base64: String,
    pub one_time_prekey_id: u32,
    pub one_time_prekey_public_base64: String,
    pub signed_prekey_id: u32,
    pub signed_prekey_public_base64: String,
    pub signed_prekey_signature_base64: String,
    pub kyber_prekey_id: u32,
    pub kyber_prekey_public_base64: String,
    pub kyber_prekey_signature_base64: String,
}

/// One additional one-time prekey's public half, returned by
/// `generate_extra_one_time_prekeys` for publishing alongside the bundle
/// from `generate_prekey_bundle` — see that function's docs for why a single
/// one-time prekey per identity isn't enough.
#[derive(uniffi::Record)]
pub struct OneTimePrekeyPublic {
    pub id: u32,
    pub public_key_base64: String,
}

#[derive(uniffi::Record)]
pub struct EncryptedEnvelope {
    /// libsignal_protocol::CiphertextMessageType as a raw byte (2 = Whisper/
    /// ordinary ratchet message, 3 = PreKey/first message in a new session).
    pub message_type: u8,
    pub ciphertext_base64: String,
}

/// One device's worth of Signal Protocol state: its identity keypair plus
/// the session/prekey stores. Backed by `store::PersistentSignalProtocolStore`
/// — encrypted-at-rest on disk under `storage_dir`, keyed by `master_key`
/// (custody of that key is the native/JS caller's responsibility; see
/// `app/src/crypto/masterKey.ts`). See `store.rs` module docs for the design.
#[derive(uniffi::Object)]
pub struct SignalDevice {
    store: Mutex<PersistentSignalProtocolStore>,
    identity_key_pair: IdentityKeyPair,
    address: ProtocolAddress,
}

#[uniffi::export]
impl SignalDevice {
    #[uniffi::constructor]
    pub fn new(
        user_id: String,
        device_id: u32,
        master_key: Vec<u8>,
        storage_dir: String,
    ) -> Result<Arc<Self>, SignalNativeError> {
        let store = PersistentSignalProtocolStore::open(&storage_dir, &master_key)?;
        let identity_key_pair = store.identity_store.identity_key_pair();
        let address = make_address(&user_id, device_id)?;

        Ok(Arc::new(Self {
            store: Mutex::new(store),
            identity_key_pair,
            address,
        }))
    }

    pub fn identity_public_key_base64(&self) -> String {
        b64_encode(self.identity_key_pair.identity_key().serialize())
    }

    /// Generates one fresh one-time prekey, one signed prekey, and one Kyber
    /// (PQXDH) prekey; stores the private halves locally (needed later to
    /// decrypt the first incoming message of a new session) and returns the
    /// public bundle to publish to the server.
    pub fn generate_prekey_bundle(
        &self,
        one_time_prekey_id: u32,
        signed_prekey_id: u32,
        kyber_prekey_id: u32,
    ) -> Result<PreKeyBundleData, SignalNativeError> {
        blocking_runtime().block_on(async {
            let mut rng = rand::rngs::OsRng.unwrap_err();
            let mut store = self.store.lock().expect("store mutex poisoned");

            let one_time_keypair = KeyPair::generate(&mut rng);
            let one_time_id: PreKeyId = one_time_prekey_id.into();
            let one_time_record = PreKeyRecord::new(one_time_id, &one_time_keypair);
            store
                .pre_key_store
                .save_pre_key(one_time_id, &one_time_record)
                .await?;

            let signed_keypair = KeyPair::generate(&mut rng);
            let signed_signature = self
                .identity_key_pair
                .private_key()
                .calculate_signature(&signed_keypair.public_key.serialize(), &mut rng)
                .map_err(|e| SignalNativeError::Protocol(e.to_string()))?;
            let signed_id: SignedPreKeyId = signed_prekey_id.into();
            let signed_record = SignedPreKeyRecord::new(
                signed_id,
                now_timestamp(),
                &signed_keypair,
                &signed_signature,
            );
            store
                .signed_pre_key_store
                .save_signed_pre_key(signed_id, &signed_record)
                .await?;

            let kyber_id: KyberPreKeyId = kyber_prekey_id.into();
            let kyber_record = KyberPreKeyRecord::generate(
                kem::KeyType::Kyber1024,
                kyber_id,
                self.identity_key_pair.private_key(),
            )?;
            store
                .kyber_pre_key_store
                .save_kyber_pre_key(kyber_id, &kyber_record)
                .await?;

            Ok(PreKeyBundleData {
                registration_id: store.identity_store.get_local_registration_id().await?,
                device_id: self.address.device_id().into(),
                identity_key_base64: self.identity_public_key_base64(),
                one_time_prekey_id,
                one_time_prekey_public_base64: b64_encode(one_time_keypair.public_key.serialize()),
                signed_prekey_id,
                signed_prekey_public_base64: b64_encode(signed_keypair.public_key.serialize()),
                signed_prekey_signature_base64: b64_encode(&signed_signature),
                kyber_prekey_id,
                kyber_prekey_public_base64: b64_encode(kyber_record.public_key()?.serialize()),
                kyber_prekey_signature_base64: b64_encode(kyber_record.signature()?),
            })
        })
    }

    /// Generates and stores `ids.len()` additional one-time EC prekeys,
    /// independent of the signed/Kyber prekey (unlike `generate_prekey_bundle`,
    /// this never touches them, so it's safe to call repeatedly without
    /// invalidating a bundle a peer may have already fetched). Exists because
    /// a `PreKeyBundleData` only ever carries one one-time prekey id, but a
    /// server-side pool needs many: without this, only the first peer to
    /// start a conversation with this identity since its last
    /// `generate_prekey_bundle` call gets a one-time prekey at all — anyone
    /// else claiming a bundle finds the table already emptied (see
    /// `app/src/transport/identities.ts::claimPeerPrekeyBundle`, which
    /// deletes on claim).
    pub fn generate_extra_one_time_prekeys(
        &self,
        ids: Vec<u32>,
    ) -> Result<Vec<OneTimePrekeyPublic>, SignalNativeError> {
        blocking_runtime().block_on(async {
            let mut rng = rand::rngs::OsRng.unwrap_err();
            let mut store = self.store.lock().expect("store mutex poisoned");
            let mut out = Vec::with_capacity(ids.len());
            for id in ids {
                let keypair = KeyPair::generate(&mut rng);
                let prekey_id: PreKeyId = id.into();
                let record = PreKeyRecord::new(prekey_id, &keypair);
                store.pre_key_store.save_pre_key(prekey_id, &record).await?;
                out.push(OneTimePrekeyPublic {
                    id,
                    public_key_base64: b64_encode(keypair.public_key.serialize()),
                });
            }
            Ok(out)
        })
    }

    /// X3DH/PQXDH: consume a peer's published prekey bundle and derive the
    /// initial Double Ratchet session state for talking to them.
    pub fn establish_session(
        &self,
        remote_user_id: String,
        remote_device_id: u32,
        bundle: PreKeyBundleData,
    ) -> Result<(), SignalNativeError> {
        blocking_runtime().block_on(async {
            let remote_address = make_address(&remote_user_id, remote_device_id)?;

            let identity_key = IdentityKey::decode(&b64_decode(&bundle.identity_key_base64)?)?;
            let one_time_prekey_public =
                PublicKey::deserialize(&b64_decode(&bundle.one_time_prekey_public_base64)?)
                    .map_err(|e| SignalNativeError::Protocol(e.to_string()))?;
            let signed_prekey_public =
                PublicKey::deserialize(&b64_decode(&bundle.signed_prekey_public_base64)?)
                    .map_err(|e| SignalNativeError::Protocol(e.to_string()))?;
            let kyber_prekey_public =
                kem::PublicKey::deserialize(&b64_decode(&bundle.kyber_prekey_public_base64)?)
                    .map_err(|e| SignalNativeError::Protocol(e.to_string()))?;

            let prekey_bundle = PreKeyBundle::new(
                bundle.registration_id,
                remote_device_id
                    .try_into()
                    .map_err(|_| SignalNativeError::InvalidDeviceId(remote_device_id))?,
                Some((bundle.one_time_prekey_id.into(), one_time_prekey_public)),
                bundle.signed_prekey_id.into(),
                signed_prekey_public,
                b64_decode(&bundle.signed_prekey_signature_base64)?,
                bundle.kyber_prekey_id.into(),
                kyber_prekey_public,
                b64_decode(&bundle.kyber_prekey_signature_base64)?,
                identity_key,
            )?;

            let mut rng = rand::rngs::OsRng.unwrap_err();
            let mut store = self.store.lock().expect("store mutex poisoned");
            let PersistentSignalProtocolStore {
                session_store,
                identity_store,
                ..
            } = &mut *store;

            process_prekey_bundle(
                &remote_address,
                &self.address,
                session_store,
                identity_store,
                &prekey_bundle,
                SystemTime::now(),
                &mut rng,
            )
            .await?;

            Ok(())
        })
    }

    /// Encrypts `plaintext` for `remote_user_id`/`remote_device_id` using the
    /// existing (or just-established) session, advancing the Double Ratchet.
    pub fn encrypt(
        &self,
        remote_user_id: String,
        remote_device_id: u32,
        plaintext: String,
    ) -> Result<EncryptedEnvelope, SignalNativeError> {
        blocking_runtime().block_on(async {
            let remote_address = make_address(&remote_user_id, remote_device_id)?;
            let mut rng = rand::rngs::OsRng.unwrap_err();
            let mut store = self.store.lock().expect("store mutex poisoned");
            let PersistentSignalProtocolStore {
                session_store,
                identity_store,
                ..
            } = &mut *store;

            let ciphertext = message_encrypt(
                plaintext.as_bytes(),
                &remote_address,
                &self.address,
                session_store,
                identity_store,
                SystemTime::now(),
                &mut rng,
            )
            .await?;

            Ok(EncryptedEnvelope {
                message_type: ciphertext.message_type() as u8,
                ciphertext_base64: b64_encode(ciphertext.serialize()),
            })
        })
    }

    /// Decrypts a message received from `remote_user_id`/`remote_device_id`,
    /// transparently completing session establishment if this is the first
    /// (PreKey-type) message of a new incoming session.
    pub fn decrypt(
        &self,
        remote_user_id: String,
        remote_device_id: u32,
        envelope: EncryptedEnvelope,
    ) -> Result<String, SignalNativeError> {
        blocking_runtime().block_on(async {
            let remote_address = make_address(&remote_user_id, remote_device_id)?;
            let bytes = b64_decode(&envelope.ciphertext_base64)?;

            let ciphertext = match envelope.message_type {
                t if t == CiphertextMessageType::Whisper as u8 => {
                    CiphertextMessage::SignalMessage(SignalMessage::try_from(bytes.as_slice())?)
                }
                t if t == CiphertextMessageType::PreKey as u8 => {
                    CiphertextMessage::PreKeySignalMessage(PreKeySignalMessage::try_from(
                        bytes.as_slice(),
                    )?)
                }
                other => {
                    return Err(SignalNativeError::Protocol(format!(
                        "unsupported ciphertext message type: {other}"
                    )));
                }
            };

            let mut rng = rand::rngs::OsRng.unwrap_err();
            let mut store = self.store.lock().expect("store mutex poisoned");
            let PersistentSignalProtocolStore {
                session_store,
                identity_store,
                pre_key_store,
                signed_pre_key_store,
                kyber_pre_key_store,
                ..
            } = &mut *store;

            let plaintext = message_decrypt(
                &ciphertext,
                &remote_address,
                &self.address,
                session_store,
                identity_store,
                pre_key_store,
                signed_pre_key_store,
                kyber_pre_key_store,
                &mut rng,
            )
            .await?;

            String::from_utf8(plaintext).map_err(|_| SignalNativeError::Utf8)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fresh, unique on-disk directory per test/device so parallel test runs
    /// (and repeated `cargo test` invocations) never see each other's state.
    fn temp_storage_dir(label: &str) -> String {
        let mut rng = rand::rngs::OsRng.unwrap_err();
        let suffix: u64 = rand::Rng::random(&mut rng);
        let dir = std::env::temp_dir().join(format!("signal-native-test-{label}-{suffix:x}"));
        std::fs::create_dir_all(&dir).expect("failed to create temp test dir");
        dir.to_string_lossy().into_owned()
    }

    /// Real apps get this from `expo-secure-store` via
    /// `app/src/crypto/masterKey.ts` — any 32 bytes work for the store itself.
    fn test_master_key() -> Vec<u8> {
        vec![0x42; 32]
    }

    /// Proves the real libsignal-protocol integration end to end: Alice
    /// fetches Bob's prekey bundle, establishes a session (PQXDH), and the
    /// two exchange messages through the Double Ratchet in both directions.
    #[test]
    fn alice_and_bob_exchange_messages() {
        let key = test_master_key();
        let alice = SignalDevice::new("alice".to_string(), 1, key.clone(), temp_storage_dir("alice")).unwrap();
        let bob = SignalDevice::new("bob".to_string(), 1, key, temp_storage_dir("bob")).unwrap();

        let bob_bundle = bob.generate_prekey_bundle(1, 1, 1).unwrap();
        alice
            .establish_session("bob".to_string(), 1, bob_bundle)
            .unwrap();

        let first = alice
            .encrypt("bob".to_string(), 1, "hello bob, this is alice".to_string())
            .unwrap();
        assert_eq!(first.message_type, CiphertextMessageType::PreKey as u8);

        let decrypted_first = bob.decrypt("alice".to_string(), 1, first).unwrap();
        assert_eq!(decrypted_first, "hello bob, this is alice");

        // Bob replies without ever having called establish_session himself —
        // the incoming PreKey message above should have set up his side of
        // the session as a side effect (as it does in real Signal clients).
        let reply = bob
            .encrypt("alice".to_string(), 1, "hi alice, bob here".to_string())
            .unwrap();
        let decrypted_reply = alice.decrypt("bob".to_string(), 1, reply).unwrap();
        assert_eq!(decrypted_reply, "hi alice, bob here");

        // A second message from Alice should use an ordinary ratchet step
        // (Whisper), not another PreKey message — proving the ratchet
        // advanced rather than re-establishing the session each time.
        let second = alice
            .encrypt("bob".to_string(), 1, "still me".to_string())
            .unwrap();
        assert_eq!(second.message_type, CiphertextMessageType::Whisper as u8);
        assert_eq!(bob.decrypt("alice".to_string(), 1, second).unwrap(), "still me");
    }

    /// Proves the bug `generate_extra_one_time_prekeys` fixes: with only the
    /// single one-time prekey from `generate_prekey_bundle`, a second peer
    /// trying to start a session concurrently would find no one-time prekey
    /// left (the first peer's claim deletes it server-side). Here Bob
    /// publishes a pool (his bundle's own id, plus extras), and both Alice
    /// and Carol — each claiming a different id from that pool — can
    /// establish independent working sessions with Bob at the same time.
    #[test]
    fn pool_of_one_time_prekeys_allows_multiple_concurrent_peers() {
        let key = test_master_key();
        let alice = SignalDevice::new("alice".to_string(), 1, key.clone(), temp_storage_dir("alice-pool")).unwrap();
        let carol = SignalDevice::new("carol".to_string(), 1, key.clone(), temp_storage_dir("carol-pool")).unwrap();
        let bob = SignalDevice::new("bob".to_string(), 1, key, temp_storage_dir("bob-pool")).unwrap();

        // Bob's primary bundle uses one-time prekey id 1; the pool adds ids
        // 2 and 3, matching how registerIdentity() would call this (see
        // app/src/identity/registerIdentity.ts). Both peers share the same
        // signed/Kyber prekey (id 1) — only the one-time prekey differs per
        // claim, exactly like a real server-side pool.
        let bundle_for_alice = bob.generate_prekey_bundle(1, 1, 1).unwrap();
        let extras = bob.generate_extra_one_time_prekeys(vec![2, 3]).unwrap();
        assert_eq!(extras.len(), 2);

        // Built by hand (not a second generate_prekey_bundle call) — calling
        // that again would regenerate and overwrite Bob's signed/Kyber
        // prekey, silently invalidating the bundle Alice already has. A
        // real server-side pool only ever hands out one signed/Kyber prekey
        // per identity alongside whichever one-time prekey it claims.
        let bundle_for_carol = PreKeyBundleData {
            registration_id: bundle_for_alice.registration_id,
            device_id: bundle_for_alice.device_id,
            identity_key_base64: bundle_for_alice.identity_key_base64.clone(),
            one_time_prekey_id: extras[0].id,
            one_time_prekey_public_base64: extras[0].public_key_base64.clone(),
            signed_prekey_id: bundle_for_alice.signed_prekey_id,
            signed_prekey_public_base64: bundle_for_alice.signed_prekey_public_base64.clone(),
            signed_prekey_signature_base64: bundle_for_alice.signed_prekey_signature_base64.clone(),
            kyber_prekey_id: bundle_for_alice.kyber_prekey_id,
            kyber_prekey_public_base64: bundle_for_alice.kyber_prekey_public_base64.clone(),
            kyber_prekey_signature_base64: bundle_for_alice.kyber_prekey_signature_base64.clone(),
        };

        alice
            .establish_session("bob".to_string(), 1, bundle_for_alice)
            .unwrap();
        carol
            .establish_session("bob".to_string(), 1, bundle_for_carol)
            .unwrap();

        let from_alice = alice
            .encrypt("bob".to_string(), 1, "hi from alice".to_string())
            .unwrap();
        let from_carol = carol
            .encrypt("bob".to_string(), 1, "hi from carol".to_string())
            .unwrap();

        assert_eq!(
            bob.decrypt("alice".to_string(), 1, from_alice).unwrap(),
            "hi from alice"
        );
        assert_eq!(
            bob.decrypt("carol".to_string(), 1, from_carol).unwrap(),
            "hi from carol"
        );
    }

    /// Proves establish_session surfaces a distinguishable
    /// `SignalNativeError::UntrustedIdentity` (not just a generic Protocol
    /// error) when a peer's identity key changes — e.g. they reinstalled
    /// and lost their old identity (see docs/threat-model.md). This is the
    /// trust-on-first-use check in `FileIdentityKeyStore::is_trusted_identity`
    /// (store.rs) actually doing its job, and the app-facing error type
    /// that lets the UI show a "security key changed" message instead of a
    /// generic failure (see SignalNativeExpoModule.{kt,swift}).
    #[test]
    fn establish_session_rejects_changed_peer_identity() {
        let key = test_master_key();
        let alice = SignalDevice::new("alice".to_string(), 1, key.clone(), temp_storage_dir("alice-untrusted")).unwrap();
        let bob_original = SignalDevice::new("bob".to_string(), 1, key.clone(), temp_storage_dir("bob-untrusted-1")).unwrap();

        let bob_original_bundle = bob_original.generate_prekey_bundle(1, 1, 1).unwrap();
        alice
            .establish_session("bob".to_string(), 1, bob_original_bundle)
            .unwrap();

        // Simulate Bob losing his identity (app reinstall, Keystore wiped —
        // see docs/threat-model.md's "losing the device" gap) and getting a
        // brand new one under a fresh storage_dir, same user_id/device_id.
        let bob_reinstalled = SignalDevice::new("bob".to_string(), 1, key, temp_storage_dir("bob-untrusted-2")).unwrap();
        let bob_reinstalled_bundle = bob_reinstalled.generate_prekey_bundle(1, 1, 1).unwrap();

        let err = alice
            .establish_session("bob".to_string(), 1, bob_reinstalled_bundle)
            .unwrap_err();

        match err {
            SignalNativeError::UntrustedIdentity { user_id, device_id } => {
                assert_eq!(user_id, "bob");
                assert_eq!(device_id, 1);
            }
            other => panic!("expected UntrustedIdentity, got {other:?}"),
        }
    }

    /// Milestone 2.5: proves persistence actually survives a restart, not
    /// just that the encrypted files get written. Drops each `SignalDevice`
    /// mid-conversation and reconstructs a new one from the same
    /// `storage_dir`/`master_key` — exactly what `registerIdentity()` does
    /// on every real app launch — and checks the conversation keeps working
    /// on both sides of that "restart".
    #[test]
    fn session_survives_simulated_restart() {
        let key = test_master_key();
        let alice_dir = temp_storage_dir("alice-restart");
        let bob_dir = temp_storage_dir("bob-restart");

        let alice = SignalDevice::new("alice".to_string(), 1, key.clone(), alice_dir.clone()).unwrap();
        let bob = SignalDevice::new("bob".to_string(), 1, key.clone(), bob_dir.clone()).unwrap();

        let bob_bundle = bob.generate_prekey_bundle(1, 1, 1).unwrap();
        alice
            .establish_session("bob".to_string(), 1, bob_bundle)
            .unwrap();
        let first = alice
            .encrypt("bob".to_string(), 1, "before restart".to_string())
            .unwrap();

        // Simulate Bob's app process restarting.
        drop(bob);
        let bob = SignalDevice::new("bob".to_string(), 1, key.clone(), bob_dir).unwrap();

        let decrypted_first = bob.decrypt("alice".to_string(), 1, first).unwrap();
        assert_eq!(decrypted_first, "before restart");

        // Simulate Alice's app restarting too, mid-conversation.
        drop(alice);
        let alice = SignalDevice::new("alice".to_string(), 1, key, alice_dir).unwrap();

        let reply = bob
            .encrypt("alice".to_string(), 1, "after your restart".to_string())
            .unwrap();
        assert_eq!(
            alice.decrypt("bob".to_string(), 1, reply).unwrap(),
            "after your restart"
        );

        let second = alice
            .encrypt("bob".to_string(), 1, "and after mine".to_string())
            .unwrap();
        assert_eq!(bob.decrypt("alice".to_string(), 1, second).unwrap(), "and after mine");
    }
}
