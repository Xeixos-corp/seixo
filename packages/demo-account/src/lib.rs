//! The demo account's half of the Signal Protocol, for the `demo-account`
//! Edge Function.
//!
//! App Review tests on one phone, so a reviewer has nobody to talk to and
//! never sees the filter, reporting or blocking work. The demo account is that
//! somebody: an ordinary Seixo account whose replies come from the server
//! instead of a phone. To the reviewer's app it is indistinguishable from a
//! person -- same prekey bundle, same PQXDH handshake, same Double Ratchet --
//! which is why this wraps the very libsignal revision the app uses rather
//! than anything simpler.
//!
//! No new cryptography: every primitive is libsignal-protocol's, and sealing
//! a photo is the app's own `seal_attachment` format, reproduced below byte
//! for byte so the reviewer's phone opens it with the code it already has.
//!
//! Stateless by design. An Edge Function keeps nothing between calls, so every
//! entry point takes the whole protocol state as bytes and hands back the
//! updated state; the function stores it in the database between calls. The
//! state is the demo account's own keys and its sessions with whoever wrote
//! to it -- nobody else's.
//!
//! Two things differ from the phone store (packages/signal-native/rust/src/
//! store.rs), both deliberately:
//!
//! - Identity keys are always trusted. A phone refuses a contact whose key
//!   changed so its owner can check; this account has no owner to ask, and
//!   refusing would only leave a reviewer with a conversation that stays
//!   silent.
//! - There is no wall clock in WebAssembly, so the caller passes the time in
//!   wherever libsignal needs one.

use std::collections::HashMap;
use std::future::Future;
use std::task::{Context, Poll, Waker};
use std::time::{Duration, SystemTime};

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use libsignal_protocol::{
    kem, CiphertextMessage, CiphertextMessageType, DeviceId, Direction, GenericSignedPreKey,
    IdentityChange, IdentityKey, IdentityKeyPair, IdentityKeyStore, KeyPair, KyberPreKeyId,
    KyberPreKeyRecord, KyberPreKeyStore, PreKeyId, PreKeyRecord, PreKeySignalMessage, PreKeyStore,
    ProtocolAddress, PublicKey, SessionRecord, SessionStore, SignalMessage, SignalProtocolError,
    SignedPreKeyId, SignedPreKeyRecord, SignedPreKeyStore, Timestamp,
};
use rand::{RngCore as _, TryRngCore as _};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

type SignalResult<T> = std::result::Result<T, SignalProtocolError>;

/// Every Seixo identity is one device, id 1 (app: REMOTE_DEVICE_ID).
const DEVICE_ID: u32 = 1;
const SIGNED_PREKEY_ID: u32 = 1;
const KYBER_PREKEY_ID: u32 = 1;

// ── Errors ──────────────────────────────────────────────────────────────────

fn fail(message: impl std::fmt::Display) -> JsError {
    JsError::new(&message.to_string())
}

// ── Running libsignal's async API without a runtime ─────────────────────────

/// libsignal's store traits are async, but every store here answers from
/// memory, so each future completes on its first poll. A runtime would only
/// add weight to the WebAssembly; a future that did suspend would be a bug,
/// and says so.
fn run<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    match future.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("an in-memory store unexpectedly suspended"),
    }
}

fn system_time(now_ms: f64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_millis(now_ms as u64)
}

fn address(user_id: &str) -> Result<ProtocolAddress, JsError> {
    let device: DeviceId = DEVICE_ID.try_into().map_err(|_| fail("bad device id"))?;
    Ok(ProtocolAddress::new(user_id.to_string(), device))
}

fn address_key(address: &ProtocolAddress) -> String {
    format!("{}:{}", address.name(), u32::from(address.device_id()))
}

// ── State ──────────────────────────────────────────────────────────────────

/// Everything the account knows, as libsignal's own serialized records.
#[derive(Serialize, Deserialize)]
struct State {
    identity_key_pair: Vec<u8>,
    registration_id: u32,
    known_identities: HashMap<String, Vec<u8>>,
    prekeys: HashMap<u32, Vec<u8>>,
    signed_prekeys: HashMap<u32, Vec<u8>>,
    kyber_prekeys: HashMap<u32, Vec<u8>>,
    kyber_base_keys_seen: HashMap<(u32, u32), Vec<Vec<u8>>>,
    sessions: HashMap<String, Vec<u8>>,
    /// The next one-time prekey id to hand out. Ids are never reused: a peer
    /// may hold the public half of a claimed one for a while.
    next_prekey_id: u32,
}

impl State {
    fn decode(bytes: &[u8]) -> Result<Self, JsError> {
        bincode::deserialize(bytes).map_err(|e| fail(format!("unreadable state: {e}")))
    }

    fn encode(&self) -> Result<Vec<u8>, JsError> {
        bincode::serialize(self).map_err(fail)
    }

    fn identity(&self) -> Result<IdentityKeyPair, JsError> {
        IdentityKeyPair::try_from(self.identity_key_pair.as_slice()).map_err(fail)
    }
}

// ── The five libsignal stores, over the state's maps ────────────────────────
//
// Split into separate structs, like InMemSignalProtocolStore, because libsignal
// borrows several of them mutably at once.

struct Identities<'a> {
    pair: IdentityKeyPair,
    registration_id: u32,
    known: &'a mut HashMap<String, Vec<u8>>,
}

#[async_trait(?Send)]
impl IdentityKeyStore for Identities<'_> {
    async fn get_identity_key_pair(&self) -> SignalResult<IdentityKeyPair> {
        Ok(self.pair)
    }

    async fn get_local_registration_id(&self) -> SignalResult<u32> {
        Ok(self.registration_id)
    }

    async fn save_identity(
        &mut self,
        address: &ProtocolAddress,
        identity: &IdentityKey,
    ) -> SignalResult<IdentityChange> {
        let bytes = identity.serialize().to_vec();
        let previous = self.known.insert(address_key(address), bytes.clone());
        Ok(match previous {
            Some(old) if old != bytes => IdentityChange::ReplacedExisting,
            _ => IdentityChange::NewOrUnchanged,
        })
    }

    /// Always: see the module docs.
    async fn is_trusted_identity(
        &self,
        _address: &ProtocolAddress,
        _identity: &IdentityKey,
        _direction: Direction,
    ) -> SignalResult<bool> {
        Ok(true)
    }

    async fn get_identity(&self, address: &ProtocolAddress) -> SignalResult<Option<IdentityKey>> {
        match self.known.get(&address_key(address)) {
            Some(bytes) => Ok(Some(IdentityKey::decode(bytes)?)),
            None => Ok(None),
        }
    }
}

struct PreKeys<'a>(&'a mut HashMap<u32, Vec<u8>>);

#[async_trait(?Send)]
impl PreKeyStore for PreKeys<'_> {
    async fn get_pre_key(&self, id: PreKeyId) -> SignalResult<PreKeyRecord> {
        let bytes = self.0.get(&u32::from(id)).ok_or(SignalProtocolError::InvalidPreKeyId)?;
        PreKeyRecord::deserialize(bytes)
    }

    async fn save_pre_key(&mut self, id: PreKeyId, record: &PreKeyRecord) -> SignalResult<()> {
        self.0.insert(u32::from(id), record.serialize()?);
        Ok(())
    }

    async fn remove_pre_key(&mut self, id: PreKeyId) -> SignalResult<()> {
        self.0.remove(&u32::from(id));
        Ok(())
    }
}

struct SignedPreKeys<'a>(&'a mut HashMap<u32, Vec<u8>>);

#[async_trait(?Send)]
impl SignedPreKeyStore for SignedPreKeys<'_> {
    async fn get_signed_pre_key(&self, id: SignedPreKeyId) -> SignalResult<SignedPreKeyRecord> {
        let bytes = self
            .0
            .get(&u32::from(id))
            .ok_or(SignalProtocolError::InvalidSignedPreKeyId)?;
        SignedPreKeyRecord::deserialize(bytes)
    }

    async fn save_signed_pre_key(
        &mut self,
        id: SignedPreKeyId,
        record: &SignedPreKeyRecord,
    ) -> SignalResult<()> {
        self.0.insert(u32::from(id), record.serialize()?);
        Ok(())
    }
}

struct KyberPreKeys<'a> {
    keys: &'a mut HashMap<u32, Vec<u8>>,
    base_keys_seen: &'a mut HashMap<(u32, u32), Vec<Vec<u8>>>,
}

#[async_trait(?Send)]
impl KyberPreKeyStore for KyberPreKeys<'_> {
    async fn get_kyber_pre_key(&self, id: KyberPreKeyId) -> SignalResult<KyberPreKeyRecord> {
        let bytes = self
            .keys
            .get(&u32::from(id))
            .ok_or(SignalProtocolError::InvalidKyberPreKeyId)?;
        KyberPreKeyRecord::deserialize(bytes)
    }

    async fn save_kyber_pre_key(
        &mut self,
        id: KyberPreKeyId,
        record: &KyberPreKeyRecord,
    ) -> SignalResult<()> {
        self.keys.insert(u32::from(id), record.serialize()?);
        Ok(())
    }

    /// The Kyber key is a last-resort key shared by every new session, so it
    /// is never deleted; replaying the same handshake is refused instead,
    /// exactly as the phone store does.
    async fn mark_kyber_pre_key_used(
        &mut self,
        kyber_id: KyberPreKeyId,
        ec_id: SignedPreKeyId,
        base_key: &PublicKey,
    ) -> SignalResult<()> {
        let seen = self
            .base_keys_seen
            .entry((u32::from(kyber_id), u32::from(ec_id)))
            .or_default();
        let bytes = base_key.serialize().to_vec();
        if seen.contains(&bytes) {
            return Err(SignalProtocolError::InvalidMessage(
                CiphertextMessageType::PreKey,
                "reused base key".to_owned(),
            ));
        }
        seen.push(bytes);
        Ok(())
    }
}

struct Sessions<'a>(&'a mut HashMap<String, Vec<u8>>);

#[async_trait(?Send)]
impl SessionStore for Sessions<'_> {
    async fn load_session(&self, address: &ProtocolAddress) -> SignalResult<Option<SessionRecord>> {
        match self.0.get(&address_key(address)) {
            Some(bytes) => Ok(Some(SessionRecord::deserialize(bytes)?)),
            None => Ok(None),
        }
    }

    async fn store_session(
        &mut self,
        address: &ProtocolAddress,
        record: &SessionRecord,
    ) -> SignalResult<()> {
        self.0.insert(address_key(address), record.serialize()?);
        Ok(())
    }
}

// ── What goes back to JavaScript ────────────────────────────────────────────

/// An updated state plus a JSON result. Every call that changes the state
/// returns one, so the caller cannot forget to keep the new state.
#[wasm_bindgen]
pub struct Output {
    state: Vec<u8>,
    json: String,
}

#[wasm_bindgen]
impl Output {
    #[wasm_bindgen(getter)]
    pub fn state(&self) -> Vec<u8> {
        self.state.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn json(&self) -> String {
        self.json.clone()
    }
}

fn output(state: &State, json: serde_json::Value) -> Result<Output, JsError> {
    Ok(Output {
        state: state.encode()?,
        json: json.to_string(),
    })
}

fn b64(bytes: impl AsRef<[u8]>) -> String {
    BASE64.encode(bytes)
}

fn generate_one_time_prekeys(state: &mut State, count: u32) -> Vec<serde_json::Value> {
    let mut rng = rand::rngs::OsRng.unwrap_err();
    let mut published = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let id = state.next_prekey_id;
        state.next_prekey_id += 1;
        let pair = KeyPair::generate(&mut rng);
        let record = PreKeyRecord::new(id.into(), &pair);
        if let Ok(bytes) = record.serialize() {
            state.prekeys.insert(id, bytes);
            published.push(serde_json::json!({
                "id": id,
                "publicKey": b64(pair.public_key.serialize()),
            }));
        }
    }
    published
}

// ── Entry points ────────────────────────────────────────────────────────────

/// Creates the account's identity and its first prekeys.
///
/// The JSON is everything to publish, in the shape the app's tables hold it
/// (`identities`, `signed_prekeys`, `one_time_prekeys`).
#[wasm_bindgen]
pub fn create(now_ms: f64, one_time_prekeys: u32) -> Result<Output, JsError> {
    let mut rng = rand::rngs::OsRng.unwrap_err();
    let identity = IdentityKeyPair::generate(&mut rng);
    // Same range the app draws from (store.rs).
    let registration_id = 1 + (rng.next_u32() % 16379);
    let now = Timestamp::from_epoch_millis(now_ms as u64);

    let signed_pair = KeyPair::generate(&mut rng);
    let signed_signature = identity
        .private_key()
        .calculate_signature(&signed_pair.public_key.serialize(), &mut rng)
        .map_err(fail)?;
    let signed = SignedPreKeyRecord::new(
        SIGNED_PREKEY_ID.into(),
        now,
        &signed_pair,
        &signed_signature,
    );

    // KyberPreKeyRecord::generate reads the wall clock, which WebAssembly does
    // not have; this is the same thing with the time passed in.
    let kyber_pair = kem::KeyPair::generate(kem::KeyType::Kyber1024, &mut rng);
    let kyber_signature = identity
        .private_key()
        .calculate_signature(&kyber_pair.public_key.serialize(), &mut rng)
        .map_err(fail)?;
    let kyber = KyberPreKeyRecord::new(KYBER_PREKEY_ID.into(), now, &kyber_pair, &kyber_signature);

    let mut state = State {
        identity_key_pair: identity.serialize().to_vec(),
        registration_id,
        known_identities: HashMap::new(),
        prekeys: HashMap::new(),
        signed_prekeys: HashMap::from([(SIGNED_PREKEY_ID, signed.serialize().map_err(fail)?)]),
        kyber_prekeys: HashMap::from([(KYBER_PREKEY_ID, kyber.serialize().map_err(fail)?)]),
        kyber_base_keys_seen: HashMap::new(),
        sessions: HashMap::new(),
        next_prekey_id: 1,
    };
    let one_time = generate_one_time_prekeys(&mut state, one_time_prekeys);

    let json = serde_json::json!({
        "identityPublicKey": b64(identity.identity_key().serialize()),
        "registrationId": registration_id,
        "signedPrekeyId": SIGNED_PREKEY_ID,
        "signedPrekeyPublic": b64(signed_pair.public_key.serialize()),
        "signedPrekeySignature": b64(&signed_signature),
        "kyberPrekeyId": KYBER_PREKEY_ID,
        "kyberPrekeyPublic": b64(kyber_pair.public_key.serialize()),
        "kyberPrekeySignature": b64(&kyber_signature),
        "oneTimePrekeys": one_time,
    });
    output(&state, json)
}

/// More one-time prekeys, for when the published pool runs low. Each new
/// conversation claims one.
#[wasm_bindgen]
pub fn add_one_time_prekeys(state: &[u8], count: u32) -> Result<Output, JsError> {
    let mut state = State::decode(state)?;
    let published = generate_one_time_prekeys(&mut state, count);
    output(&state, serde_json::Value::Array(published))
}

/// Decrypts a message from `peer`. `message_type` and `ciphertext` are the
/// `t` and `c` of the app's wire envelope (crypto/messageCodec.ts).
#[wasm_bindgen]
pub fn decrypt(
    state: &[u8],
    self_id: &str,
    peer: &str,
    message_type: u8,
    ciphertext: &str,
) -> Result<Output, JsError> {
    let mut state = State::decode(state)?;
    let bytes = BASE64.decode(ciphertext).map_err(fail)?;
    let message = if message_type == CiphertextMessageType::PreKey as u8 {
        CiphertextMessage::PreKeySignalMessage(
            PreKeySignalMessage::try_from(bytes.as_slice()).map_err(fail)?,
        )
    } else if message_type == CiphertextMessageType::Whisper as u8 {
        CiphertextMessage::SignalMessage(SignalMessage::try_from(bytes.as_slice()).map_err(fail)?)
    } else {
        return Err(fail(format!("unsupported message type {message_type}")));
    };

    let pair = state.identity()?;
    let registration_id = state.registration_id;
    let State {
        known_identities,
        prekeys,
        signed_prekeys,
        kyber_prekeys,
        kyber_base_keys_seen,
        sessions,
        ..
    } = &mut state;
    let mut identities = Identities {
        pair,
        registration_id,
        known: known_identities,
    };
    let mut rng = rand::rngs::OsRng.unwrap_err();
    let plaintext = run(libsignal_protocol::message_decrypt(
        &message,
        &address(peer)?,
        &address(self_id)?,
        &mut Sessions(sessions),
        &mut identities,
        &mut PreKeys(prekeys),
        &SignedPreKeys(signed_prekeys),
        &mut KyberPreKeys {
            keys: kyber_prekeys,
            base_keys_seen: kyber_base_keys_seen,
        },
        &mut rng,
    ))
    .map_err(fail)?;

    let text = String::from_utf8(plaintext).map_err(|_| fail("plaintext is not UTF-8"))?;
    output(&state, serde_json::json!({ "plaintext": text }))
}

/// Encrypts `plaintext` for `peer`, who must already have a session -- which
/// they do once their first message has been decrypted. The JSON is the app's
/// wire envelope, ready to store as the message's ciphertext column.
#[wasm_bindgen]
pub fn encrypt(
    state: &[u8],
    self_id: &str,
    peer: &str,
    plaintext: &str,
    now_ms: f64,
) -> Result<Output, JsError> {
    let mut state = State::decode(state)?;
    let pair = state.identity()?;
    let registration_id = state.registration_id;
    let State {
        known_identities,
        sessions,
        ..
    } = &mut state;
    let mut identities = Identities {
        pair,
        registration_id,
        known: known_identities,
    };
    let mut rng = rand::rngs::OsRng.unwrap_err();
    let message = run(libsignal_protocol::message_encrypt(
        plaintext.as_bytes(),
        &address(peer)?,
        &address(self_id)?,
        &mut Sessions(sessions),
        &mut identities,
        system_time(now_ms),
        &mut rng,
    ))
    .map_err(fail)?;

    output(
        &state,
        serde_json::json!({ "t": message.message_type() as u8, "c": b64(message.serialize()) }),
    )
}

/// Whether there is a session with `peer` yet.
#[wasm_bindgen]
pub fn has_session(state: &[u8], peer: &str) -> Result<bool, JsError> {
    let state = State::decode(state)?;
    Ok(state.sessions.contains_key(&address_key(&address(peer)?)))
}

// ── Photos ──────────────────────────────────────────────────────────────────
//
// The app's attachment format (packages/signal-native/rust/src/attachment.rs),
// reproduced exactly: "SEIXOIMG1" || nonce || AES-256-GCM(padded) with the
// magic as associated data, padded to whole 64 KiB units behind a big-endian
// length. Kept in step by hand; the test below opens a sealed image the same
// way the app does.

const MAGIC: &[u8] = b"SEIXOIMG1";
const PAD_UNIT: usize = 64 * 1024;

#[wasm_bindgen]
pub struct Sealed {
    key: Vec<u8>,
    sealed: Vec<u8>,
}

#[wasm_bindgen]
impl Sealed {
    #[wasm_bindgen(getter)]
    pub fn key(&self) -> Vec<u8> {
        self.key.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn sealed(&self) -> Vec<u8> {
        self.sealed.clone()
    }
}

#[wasm_bindgen]
pub fn seal_attachment(plaintext: &[u8]) -> Result<Sealed, JsError> {
    let mut rng = rand::rngs::OsRng.unwrap_err();
    let mut key = vec![0u8; 32];
    let mut nonce = [0u8; 12];
    rng.fill_bytes(&mut key);
    rng.fill_bytes(&mut nonce);

    let body = 4 + plaintext.len();
    let mut padded = Vec::with_capacity(body.div_ceil(PAD_UNIT) * PAD_UNIT);
    padded.extend_from_slice(&(plaintext.len() as u32).to_be_bytes());
    padded.extend_from_slice(plaintext);
    padded.resize(body.div_ceil(PAD_UNIT) * PAD_UNIT, 0);

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(fail)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            aes_gcm::aead::Payload {
                msg: &padded,
                aad: MAGIC,
            },
        )
        .map_err(|_| fail("could not seal the image"))?;

    let mut sealed = Vec::with_capacity(MAGIC.len() + nonce.len() + ciphertext.len());
    sealed.extend_from_slice(MAGIC);
    sealed.extend_from_slice(&nonce);
    sealed.extend_from_slice(&ciphertext);
    Ok(Sealed { key, sealed })
}
