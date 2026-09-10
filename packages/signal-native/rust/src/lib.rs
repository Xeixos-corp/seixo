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
use libsignal_protocol::Fingerprint;
use rand::TryRngCore as _;

mod backup;
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

/// The public halves of a freshly rotated signed + Kyber prekey pair, ready
/// to publish. Returned by `rotate_signed_prekeys`.
#[derive(uniffi::Record)]
pub struct RotatedPrekeys {
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

/// The private identity material a recovery backup carries. See
/// `SignalDevice::export_identity_secret` for the handling rules.
#[derive(uniffi::Record)]
pub struct IdentitySecret {
    pub identity_key_pair_base64: String,
    pub registration_id: u32,
}

/// Plants a restored identity on a device that does not have one yet, so the
/// next `SignalDevice::new` picks it up instead of generating a fresh one.
///
/// A free function rather than a constructor because it must run *before* any
/// device exists -- and it refuses if a store is already present, so a
/// mistaken restore cannot overwrite a working identity.
#[uniffi::export]
pub fn restore_identity(
    master_key: Vec<u8>,
    storage_dir: String,
    secret: IdentitySecret,
) -> Result<(), SignalNativeError> {
    let bytes = BASE64
        .decode(secret.identity_key_pair_base64.trim())
        .map_err(|e| SignalNativeError::Base64(e.to_string()))?;
    let identity_key_pair = IdentityKeyPair::try_from(bytes.as_slice())?;
    PersistentSignalProtocolStore::create_with_identity(
        &storage_dir,
        &master_key,
        identity_key_pair,
        secret.registration_id,
    )
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

    /// The private half of this device's identity, for a recovery backup.
    ///
    /// This is the most dangerous value the crate produces: whoever holds it
    /// can be this user to every contact they have. It exists only to be
    /// sealed immediately by `encrypt_backup`, and must never be logged,
    /// written unencrypted, or sent anywhere.
    ///
    /// The identity alone is enough, and is all that is offered. Sessions and
    /// prekeys are excluded by design (see backup.rs); the point of keeping
    /// the identity is that safety numbers a contact has already verified
    /// stay the same across the move, so nobody has to re-verify.
    pub fn export_identity_secret(&self) -> IdentitySecret {
        IdentitySecret {
            identity_key_pair_base64: b64_encode(&self.identity_key_pair.serialize()),
            registration_id: self.store.lock().unwrap().identity_store.registration_id(),
        }
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

    /// The safety number for a conversation: a value both sides can compare
    /// out loud, or by QR, to confirm nobody is impersonating either of them.
    ///
    /// Derived from the two identity keys and the two user ids, so it is the
    /// same on both phones and different for every pair. It cannot be forged
    /// without the private key it is derived from, which is what makes
    /// comparing it worth anything: a server that swapped a key would produce
    /// a different number, and the two people would see the mismatch.
    ///
    /// 5200 iterations and version 2 match Signal's own parameters, so the
    /// format is the familiar sixty digits in twelve groups of five.
    pub fn safety_number(
        &self,
        remote_user_id: String,
        remote_identity_key_base64: String,
    ) -> Result<String, SignalNativeError> {
        let remote_key = IdentityKey::decode(&b64_decode(&remote_identity_key_base64)?)?;
        let fingerprint = Fingerprint::new(
            2,
            5200,
            self.address.name().as_bytes(),
            self.identity_key_pair.identity_key(),
            remote_user_id.as_bytes(),
            &remote_key,
        )
        .map_err(|e| SignalNativeError::Protocol(e.to_string()))?;

        fingerprint
            .display_string()
            .map_err(|e| SignalNativeError::Protocol(e.to_string()))
    }

    /// Forgets what is known about a peer's identity, so the next message
    /// from them is accepted as a first contact would be.
    ///
    /// The escape hatch for a peer who reinstalled: until now their changed
    /// key blocked the conversation permanently, with no way out short of
    /// wiping the local store and losing every other conversation with it.
    ///
    /// The session goes too. Keeping it would leave ratchet state derived
    /// from a key this device has just agreed to stop trusting, which is
    /// worse than starting over.
    ///
    /// Deliberately not called "trust": it does not accept any particular
    /// key, it only stops refusing. Whoever writes next establishes the new
    /// identity, and the user is expected to have compared safety numbers
    /// first -- the app says so before offering this.
    pub fn forget_peer_identity(
        &self,
        remote_user_id: String,
        remote_device_id: u32,
    ) -> Result<(), SignalNativeError> {
        blocking_runtime().block_on(async {
            let address = make_address(&remote_user_id, remote_device_id)?;
            let mut store = self.store.lock().expect("store mutex poisoned");
            store.identity_store.forget_identity(&address)?;
            store.session_store.forget_session(&address)?;
            Ok(())
        })
    }

    /// Generates a new signed prekey and a new Kyber prekey, under *new* ids,
    /// and stores them alongside the existing ones.
    ///
    /// Deliberately additive. The store is a map keyed by id, so saving under
    /// a new id leaves the previous keys in place — and that is the whole
    /// point: a peer may have fetched the old bundle seconds ago and be about
    /// to send a message encrypted to it. Deleting the old private key at the
    /// moment of rotation would make that message permanently unreadable, the
    /// same failure as the one-time prekey regeneration bug, but worse
    /// because a signed prekey serves every new session rather than one.
    ///
    /// Old keys are removed separately and much later, by `prune_prekeys`.
    ///
    /// Does not touch the identity key or any one-time prekey.
    pub fn rotate_signed_prekeys(
        &self,
        signed_prekey_id: u32,
        kyber_prekey_id: u32,
    ) -> Result<RotatedPrekeys, SignalNativeError> {
        blocking_runtime().block_on(async {
            let mut rng = rand::rngs::OsRng.unwrap_err();
            let mut store = self.store.lock().expect("store mutex poisoned");

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

            Ok(RotatedPrekeys {
                signed_prekey_id,
                signed_prekey_public_base64: b64_encode(signed_keypair.public_key.serialize()),
                signed_prekey_signature_base64: b64_encode(&signed_signature),
                kyber_prekey_id,
                kyber_prekey_public_base64: b64_encode(kyber_record.public_key()?.serialize()),
                kyber_prekey_signature_base64: b64_encode(kyber_record.signature()?),
            })
        })
    }

    /// Deletes every stored signed and Kyber prekey whose id is not listed.
    ///
    /// Called only after a grace period long enough that no message encrypted
    /// to a discarded key can still be in flight. Getting this wrong in the
    /// unsafe direction — pruning too early — silently destroys messages, so
    /// the caller keeps a generous window (see the client's rotation policy).
    ///
    /// Passing an empty list would delete everything, so it is refused: that
    /// can only be a bug in the caller, and the consequence would be an
    /// identity nobody can start a conversation with.
    pub fn prune_prekeys(
        &self,
        keep_signed_ids: Vec<u32>,
        keep_kyber_ids: Vec<u32>,
    ) -> Result<(), SignalNativeError> {
        if keep_signed_ids.is_empty() || keep_kyber_ids.is_empty() {
            return Err(SignalNativeError::Protocol(
                "refusing to prune every prekey".to_string(),
            ));
        }
        let mut store = self.store.lock().expect("store mutex poisoned");
        store.signed_pre_key_store.retain_ids(&keep_signed_ids)?;
        store.kyber_pre_key_store.retain_ids(&keep_kyber_ids)?;
        Ok(())
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

    /// The property that makes rotation safe to ship: a message encrypted to
    /// the *old* signed prekey is still readable after rotating.
    ///
    /// This is the failure that would matter. Alice fetches Bob's bundle and
    /// sends; before Bob reads it, Bob rotates. If rotation replaced the key
    /// rather than adding one, that message would be lost forever, silently,
    /// and only the person who sent it would ever know it existed. Same shape
    /// as the one-time prekey bug fixed on 2026-09-05, but worse: a signed
    /// prekey serves every new session rather than one.
    #[test]
    fn rotating_keeps_messages_encrypted_to_the_old_prekey_readable() {
        let key = test_master_key();
        let alice =
            SignalDevice::new("alice".to_string(), 1, key.clone(), temp_storage_dir("rot-alice"))
                .unwrap();
        let bob =
            SignalDevice::new("bob".to_string(), 1, key, temp_storage_dir("rot-bob")).unwrap();

        // Alice takes Bob's bundle and sends, as if fetched moments earlier.
        let bob_bundle = bob.generate_prekey_bundle(1, 1, 1).unwrap();
        let bob_registration_id = bob_bundle.registration_id;
        alice.establish_session("bob".to_string(), 1, bob_bundle).unwrap();
        let in_flight = alice
            .encrypt("bob".to_string(), 1, "sent just before rotation".to_string())
            .unwrap();

        // Bob rotates before reading it.
        let rotated = bob.rotate_signed_prekeys(2, 2).unwrap();
        assert_eq!(rotated.signed_prekey_id, 2);
        assert_eq!(rotated.kyber_prekey_id, 2);

        // The in-flight message must still open.
        let decrypted = bob.decrypt("alice".to_string(), 1, in_flight).unwrap();
        assert_eq!(decrypted, "sent just before rotation");

        // And the new keys work for a new session: Carol uses the rotated
        // bundle and reaches Bob.
        let carol =
            SignalDevice::new("carol".to_string(), 1, test_master_key(), temp_storage_dir("rot-carol"))
                .unwrap();
        // Built by hand rather than via generate_prekey_bundle, which would
        // regenerate the signed and Kyber keys under the same ids and throw
        // away what rotation just produced. This is what a real client
        // assembles from the server: the identity, a one-time prekey, and the
        // rotated signed/Kyber pair.
        let extra = bob.generate_extra_one_time_prekeys(vec![9]).unwrap();
        let fresh = PreKeyBundleData {
            registration_id: bob_registration_id,
            device_id: 1,
            identity_key_base64: bob.identity_public_key_base64(),
            one_time_prekey_id: 9,
            one_time_prekey_public_base64: extra[0].public_key_base64.clone(),
            signed_prekey_id: rotated.signed_prekey_id,
            signed_prekey_public_base64: rotated.signed_prekey_public_base64.clone(),
            signed_prekey_signature_base64: rotated.signed_prekey_signature_base64.clone(),
            kyber_prekey_id: rotated.kyber_prekey_id,
            kyber_prekey_public_base64: rotated.kyber_prekey_public_base64.clone(),
            kyber_prekey_signature_base64: rotated.kyber_prekey_signature_base64.clone(),
        };
        carol.establish_session("bob".to_string(), 1, fresh).unwrap();
        let from_carol = carol
            .encrypt("bob".to_string(), 1, "hello from carol".to_string())
            .unwrap();
        assert_eq!(bob.decrypt("carol".to_string(), 1, from_carol).unwrap(), "hello from carol");
    }

    /// Pruning must never be able to empty the store: an identity with no
    /// signed prekey is one nobody can start a conversation with, and the
    /// failure would show up as strangers being unable to message you rather
    /// than as an error anyone would see.
    #[test]
    fn pruning_refuses_to_delete_everything() {
        let bob = SignalDevice::new(
            "bob".to_string(),
            1,
            test_master_key(),
            temp_storage_dir("prune-bob"),
        )
        .unwrap();
        bob.generate_prekey_bundle(1, 1, 1).unwrap();

        assert!(bob.prune_prekeys(vec![], vec![1]).is_err());
        assert!(bob.prune_prekeys(vec![1], vec![]).is_err());

        // A real prune keeps what it is told to keep.
        bob.rotate_signed_prekeys(2, 2).unwrap();
        bob.prune_prekeys(vec![2], vec![2]).unwrap();
    }

    /// The bug this fixes: a peer who reinstalls becomes permanently
    /// unreachable, and there is no way back short of wiping the local store
    /// and losing every other conversation with it. This happened for real on
    /// 2026-09-05 -- messages arrived that could never be read.
    #[test]
    fn a_peer_who_reinstalls_can_be_trusted_again_after_verifying() {
        let key = test_master_key();
        let alice =
            SignalDevice::new("alice".to_string(), 1, key.clone(), temp_storage_dir("v-alice"))
                .unwrap();
        let bob = SignalDevice::new("bob".to_string(), 1, key.clone(), temp_storage_dir("v-bob"))
            .unwrap();

        alice
            .establish_session("bob".to_string(), 1, bob.generate_prekey_bundle(1, 1, 1).unwrap())
            .unwrap();
        let hello = alice.encrypt("bob".to_string(), 1, "before".to_string()).unwrap();
        assert_eq!(bob.decrypt("alice".to_string(), 1, hello).unwrap(), "before");

        // Bob reinstalls: same name, brand new identity key.
        let bob2 = SignalDevice::new("bob".to_string(), 1, key, temp_storage_dir("v-bob2")).unwrap();
        let new_bundle = bob2.generate_prekey_bundle(1, 1, 1).unwrap();

        // Alice refuses, which is the protection working.
        assert!(alice.establish_session("bob".to_string(), 1, new_bundle).is_err());

        // She compares safety numbers with Bob out of band. Both sides must
        // compute the same value, or comparing them would prove nothing.
        let alice_key = alice.identity_public_key_base64();
        let bob_key = bob2.identity_public_key_base64();
        let seen_by_alice = alice.safety_number("bob".to_string(), bob_key).unwrap();
        let seen_by_bob = bob2.safety_number("alice".to_string(), alice_key).unwrap();
        assert_eq!(seen_by_alice, seen_by_bob);
        assert_eq!(seen_by_alice.chars().filter(|c| c.is_ascii_digit()).count(), 60);

        // Satisfied it is really Bob, she forgets the old key -- and can talk
        // to him again.
        alice.forget_peer_identity("bob".to_string(), 1).unwrap();
        alice
            .establish_session("bob".to_string(), 1, bob2.generate_prekey_bundle(2, 2, 2).unwrap())
            .unwrap();
        let again = alice.encrypt("bob".to_string(), 1, "after".to_string()).unwrap();
        assert_eq!(bob2.decrypt("alice".to_string(), 1, again).unwrap(), "after");
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

    /// The whole point of keeping the identity key rather than starting over:
    /// a contact who verified you before the move must not have to verify you
    /// again after it.
    ///
    /// Bob backs up, loses the phone, restores onto a new one, and re-reaches
    /// Alice. Alice's stored identity key for Bob is unchanged, so the
    /// message opens instead of being refused as an identity change -- and
    /// the safety number the two of them read out loud is still the same one.
    #[test]
    fn a_restored_identity_keeps_the_safety_number_a_contact_already_verified() {
        let key = test_master_key();
        let alice =
            SignalDevice::new("alice".into(), 1, key.clone(), temp_storage_dir("bak-alice"))
                .unwrap();

        let secret;
        let before;
        {
            let bob =
                SignalDevice::new("bob".into(), 1, key.clone(), temp_storage_dir("bak-bob"))
                    .unwrap();
            before = alice
                .safety_number("bob".into(), bob.identity_public_key_base64())
                .unwrap();
            secret = bob.export_identity_secret();
        }

        // A new phone: empty storage, and the identity planted from the
        // backup before any device is opened on it.
        let new_dir = temp_storage_dir("bak-bob-new");
        restore_identity(key.clone(), new_dir.clone(), secret).unwrap();
        let restored = SignalDevice::new("bob".into(), 1, key, new_dir).unwrap();

        let after = alice
            .safety_number("bob".into(), restored.identity_public_key_base64())
            .unwrap();
        assert_eq!(
            before, after,
            "restoring must not change the safety number a contact already checked"
        );

        // And a real session still forms in both directions.
        let bundle = restored.generate_prekey_bundle(1, 1, 1).unwrap();
        alice.establish_session("bob".into(), 1, bundle).unwrap();
        let envelope = alice.encrypt("bob".into(), 1, "still you".into()).unwrap();
        assert_eq!(
            restored.decrypt("alice".into(), 1, envelope).unwrap(),
            "still you"
        );
    }

    /// A restore must never land on top of a working identity. Overwriting
    /// one would leave the session files beside it keyed to an identity that
    /// is no longer there -- a failure that surfaces much later than its
    /// cause.
    #[test]
    fn restoring_refuses_to_overwrite_an_identity_already_on_the_device() {
        let key = test_master_key();
        let dir = temp_storage_dir("bak-occupied");
        let existing = SignalDevice::new("bob".into(), 1, key.clone(), dir.clone()).unwrap();
        let existing_key = existing.identity_public_key_base64();

        let other_dir = temp_storage_dir("bak-other");
        let other = SignalDevice::new("carol".into(), 1, key.clone(), other_dir).unwrap();

        let result = restore_identity(key.clone(), dir.clone(), other.export_identity_secret());
        assert!(result.is_err(), "restoring over a live identity must fail");

        // And the identity that was there is untouched.
        let reopened = SignalDevice::new("bob".into(), 1, key, dir).unwrap();
        assert_eq!(reopened.identity_public_key_base64(), existing_key);
    }

    /// A backup is worth nothing if the wrong phrase opens it, and worth
    /// nothing if the right phrase does not.
    #[test]
    fn only_the_right_phrase_opens_a_backup() {
        let phrase = backup::generate_recovery_phrase().unwrap();
        let other = backup::generate_recovery_phrase().unwrap();
        assert_ne!(phrase, other);
        assert_eq!(phrase.split_whitespace().count(), 12);

        let sealed = backup::encrypt_backup(phrase.clone(), "the secret".into()).unwrap();
        assert!(
            !sealed.contains("the secret"),
            "the plaintext must not survive in the blob"
        );

        assert_eq!(
            backup::decrypt_backup(phrase.clone(), sealed.clone()).unwrap(),
            "the secret"
        );
        assert!(backup::decrypt_backup(other, sealed.clone()).is_err());

        // Written down off a screen: different spacing and capitals are the
        // same phrase, so a correct transcription is never rejected.
        let retyped = format!("  {}  ", phrase.to_uppercase());
        assert_eq!(
            backup::decrypt_backup(retyped, sealed).unwrap(),
            "the secret"
        );
    }

    /// A single altered byte must fail to open rather than open as something
    /// else, and a typo must be caught as a typo.
    #[test]
    fn a_damaged_backup_and_a_mistyped_phrase_are_both_refused() {
        let phrase = backup::generate_recovery_phrase().unwrap();
        let sealed = backup::encrypt_backup(phrase.clone(), "the secret".into()).unwrap();

        let mut bytes = BASE64.decode(&sealed).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        assert!(backup::decrypt_backup(phrase.clone(), BASE64.encode(bytes)).is_err());

        assert!(backup::is_valid_recovery_phrase(phrase));

        // The checksum earns its place here, on fixed vectors rather than a
        // random phrase with a word swapped: 12 words carry only 4 checksum
        // bits, so a single mistyped word still passes about one time in
        // sixteen. The checksum catches most typos, not all of them -- the
        // AEAD is what makes the remainder fail safely, as a refusal to open
        // rather than as wrong plaintext.
        let all_abandon = "abandon ".repeat(12);
        let valid_vector = format!("{}about", "abandon ".repeat(11));
        assert!(!backup::is_valid_recovery_phrase(all_abandon.clone()));
        assert!(backup::is_valid_recovery_phrase(valid_vector.clone()));
        assert!(backup::decrypt_backup(all_abandon, sealed.clone()).is_err());
        assert!(backup::decrypt_backup(valid_vector, sealed).is_err());
    }

    /// The account half of a recovery. These credentials are never stored, so
    /// the only thing making them work a year later is that the derivation is
    /// a pure function of the phrase.
    #[test]
    fn account_credentials_come_back_the_same_from_the_same_phrase() {
        let phrase = backup::generate_recovery_phrase().unwrap();
        let first = backup::derive_backup_credentials(phrase.clone()).unwrap();
        // As it would be typed on the new phone: different case and spacing.
        let second =
            backup::derive_backup_credentials(format!(" {} ", phrase.to_uppercase())).unwrap();
        assert_eq!(first.email, second.email);
        assert_eq!(first.password, second.password);

        // Unreachable by construction, so no mail can ever be sent to it.
        assert!(first.email.ends_with("@seixo.invalid"));
        // And it must not be the phrase, or the file key, in disguise.
        assert!(!first.email.contains(&phrase));
        assert_ne!(first.email, first.password);

        let other = backup::derive_backup_credentials(
            backup::generate_recovery_phrase().unwrap(),
        )
        .unwrap();
        assert_ne!(first.email, other.email);
        assert_ne!(first.password, other.password);
    }
}
