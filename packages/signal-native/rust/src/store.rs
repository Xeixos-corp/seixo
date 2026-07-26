//! Persistent (encrypted-at-rest) implementations of libsignal-protocol's
//! storage traits — replaces `InMemSignalProtocolStore`, which loses all
//! identity/session state on every process restart (see
//! packages/signal-native/README.md history and docs/threat-model.md).
//!
//! This is NOT a reimplementation of any Signal Protocol cryptography. The
//! Double Ratchet / X3DH / PQXDH logic is untouched — everything here does
//! is take bytes libsignal-protocol already knows how to produce
//! (`SessionRecord::serialize()`, `IdentityKeyPair::serialize()`, etc.) and
//! wrap them in a thin AES-256-GCM envelope (the well-established
//! `aes-gcm` crate from the RustCrypto project, not hand-written cipher
//! code) before writing them to disk. Custody of the encryption key itself
//! is out of scope for this file — see `app/src/crypto/masterKey.ts`,
//! which stores it via `expo-secure-store` (Keychain/Keystore-backed).
//!
//! Layout: one file per store (identity/prekeys/signed-prekeys/kyber-prekeys/
//! sessions) under `storage_dir`, each independently encrypted with the same
//! master key. Splitting into separate files (rather than one combined file)
//! avoids needing simultaneous mutable access to unrelated data when only
//! one store mutates — each of the five libsignal-protocol traits below is
//! implemented on its own small struct, matching the split-field pattern
//! `InMemSignalProtocolStore` itself uses (required so callers can borrow
//! `&mut dyn SessionStore` and `&mut dyn IdentityKeyStore` simultaneously).
//! Every mutating trait method re-encrypts and rewrites its whole file
//! (write-to-temp-then-rename for atomicity) — not incremental, but fine at
//! this app's scale (one user's own sessions/prekeys).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use async_trait::async_trait;
use libsignal_protocol::{
    Direction, GenericSignedPreKey, IdentityChange, IdentityKey, IdentityKeyPair, IdentityKeyStore,
    InMemSenderKeyStore, KyberPreKeyId, KyberPreKeyRecord, KyberPreKeyStore, PreKeyId, PreKeyRecord,
    PreKeyStore, ProtocolAddress, PublicKey, SessionRecord, SessionStore, SignalProtocolError,
    SignedPreKeyId, SignedPreKeyRecord, SignedPreKeyStore,
};
use rand::RngCore as _;
use rand::TryRngCore as _;
use serde::{Deserialize, Serialize};

use crate::SignalNativeError;

/// `libsignal_protocol::Result` isn't part of that crate's public API (it's
/// a private `use` alias internally), so this module defines its own.
type SignalResult<T> = std::result::Result<T, SignalProtocolError>;

const NONCE_LEN: usize = 12;

fn address_key(address: &ProtocolAddress) -> String {
    format!("{}:{}", address.name(), u32::from(address.device_id()))
}

/// A single AES-256-GCM-encrypted file: fresh random nonce per write,
/// prepended to the ciphertext. Absence of the file is a normal, expected
/// state (fresh install) and yields `Ok(None)`, not an error.
struct EncryptedFile {
    path: PathBuf,
    key: [u8; 32],
}

impl EncryptedFile {
    fn new(dir: &str, filename: &str, key: [u8; 32]) -> Self {
        Self {
            path: Path::new(dir).join(filename),
            key,
        }
    }

    fn load<T: for<'de> Deserialize<'de>>(&self) -> Result<Option<T>, SignalNativeError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(SignalNativeError::Storage(e.to_string())),
        };
        if bytes.len() < NONCE_LEN {
            return Err(SignalNativeError::Storage(format!(
                "stored file {:?} is too short to contain a nonce",
                self.path
            )));
        }
        let (nonce_bytes, ciphertext) = bytes.split_at(NONCE_LEN);
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|e| SignalNativeError::Storage(e.to_string()))?;
        let plaintext = cipher
            .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
            .map_err(|_| {
                SignalNativeError::Storage(
                    "failed to decrypt local store — wrong master key or corrupted file".into(),
                )
            })?;
        bincode::deserialize(&plaintext)
            .map(Some)
            .map_err(|e| SignalNativeError::Storage(e.to_string()))
    }

    fn save<T: Serialize>(&self, data: &T) -> Result<(), SignalNativeError> {
        let plaintext =
            bincode::serialize(data).map_err(|e| SignalNativeError::Storage(e.to_string()))?;
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|e| SignalNativeError::Storage(e.to_string()))?;

        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::rngs::OsRng.unwrap_err().fill_bytes(&mut nonce_bytes);
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_slice())
            .map_err(|_| SignalNativeError::Storage("failed to encrypt local store".into()))?;

        let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| SignalNativeError::Storage(e.to_string()))?;
        }
        let tmp_path = self.path.with_extension("tmp");
        fs::write(&tmp_path, &out).map_err(|e| SignalNativeError::Storage(e.to_string()))?;
        fs::rename(&tmp_path, &self.path).map_err(|e| SignalNativeError::Storage(e.to_string()))?;
        Ok(())
    }
}

// --- Identity store ---------------------------------------------------

#[derive(Serialize, Deserialize)]
struct IdentityFileData {
    identity_key_pair_bytes: Vec<u8>,
    registration_id: u32,
    known_keys: HashMap<String, Vec<u8>>,
}

pub struct FileIdentityKeyStore {
    file: EncryptedFile,
    identity_key_pair: IdentityKeyPair,
    registration_id: u32,
    known_keys: HashMap<String, IdentityKey>,
}

impl FileIdentityKeyStore {
    fn open(dir: &str, key: [u8; 32]) -> Result<Self, SignalNativeError> {
        let file = EncryptedFile::new(dir, "identity.enc", key);
        match file.load::<IdentityFileData>()? {
            Some(data) => {
                let identity_key_pair =
                    IdentityKeyPair::try_from(data.identity_key_pair_bytes.as_slice())?;
                let mut known_keys = HashMap::with_capacity(data.known_keys.len());
                for (address, bytes) in data.known_keys {
                    known_keys.insert(address, IdentityKey::decode(&bytes)?);
                }
                Ok(Self {
                    file,
                    identity_key_pair,
                    registration_id: data.registration_id,
                    known_keys,
                })
            }
            None => {
                let mut rng = rand::rngs::OsRng.unwrap_err();
                let identity_key_pair = IdentityKeyPair::generate(&mut rng);
                let registration_id = rand::Rng::random_range(&mut rng, 1u32..16380);
                let store = Self {
                    file,
                    identity_key_pair,
                    registration_id,
                    known_keys: HashMap::new(),
                };
                store.persist()?;
                Ok(store)
            }
        }
    }

    pub fn identity_key_pair(&self) -> IdentityKeyPair {
        self.identity_key_pair
    }

    fn persist(&self) -> Result<(), SignalNativeError> {
        let known_keys = self
            .known_keys
            .iter()
            .map(|(addr, key)| (addr.clone(), key.serialize().to_vec()))
            .collect();
        self.file.save(&IdentityFileData {
            identity_key_pair_bytes: self.identity_key_pair.serialize().to_vec(),
            registration_id: self.registration_id,
            known_keys,
        })
    }
}

#[async_trait(?Send)]
impl IdentityKeyStore for FileIdentityKeyStore {
    async fn get_identity_key_pair(&self) -> SignalResult<IdentityKeyPair> {
        Ok(self.identity_key_pair)
    }

    async fn get_local_registration_id(&self) -> SignalResult<u32> {
        Ok(self.registration_id)
    }

    async fn save_identity(
        &mut self,
        address: &ProtocolAddress,
        identity: &IdentityKey,
    ) -> SignalResult<IdentityChange> {
        let key = address_key(address);
        let change = match self.known_keys.get(&key) {
            None => IdentityChange::NewOrUnchanged,
            Some(existing) if existing == identity => IdentityChange::NewOrUnchanged,
            Some(_) => IdentityChange::ReplacedExisting,
        };
        self.known_keys.insert(key, *identity);
        self.persist()
            .map_err(|e| SignalProtocolError::InvalidState("save_identity", e.to_string()))?;
        Ok(change)
    }

    async fn is_trusted_identity(
        &self,
        address: &ProtocolAddress,
        identity: &IdentityKey,
        _direction: Direction,
    ) -> SignalResult<bool> {
        match self.known_keys.get(&address_key(address)) {
            None => Ok(true), // trust on first use
            Some(known) => Ok(known == identity),
        }
    }

    async fn get_identity(&self, address: &ProtocolAddress) -> SignalResult<Option<IdentityKey>> {
        Ok(self.known_keys.get(&address_key(address)).copied())
    }
}

// --- One-time prekey store ---------------------------------------------

#[derive(Serialize, Deserialize, Default)]
struct PreKeyFileData {
    keys: HashMap<u32, Vec<u8>>,
}

pub struct FilePreKeyStore {
    file: EncryptedFile,
    keys: HashMap<u32, PreKeyRecord>,
}

impl FilePreKeyStore {
    fn open(dir: &str, key: [u8; 32]) -> Result<Self, SignalNativeError> {
        let file = EncryptedFile::new(dir, "prekeys.enc", key);
        let data = file.load::<PreKeyFileData>()?.unwrap_or_default();
        let mut keys = HashMap::with_capacity(data.keys.len());
        for (id, bytes) in data.keys {
            keys.insert(id, PreKeyRecord::deserialize(&bytes)?);
        }
        Ok(Self { file, keys })
    }

    fn persist(&self) -> Result<(), SignalNativeError> {
        let mut keys = HashMap::with_capacity(self.keys.len());
        for (id, record) in &self.keys {
            keys.insert(*id, record.serialize()?);
        }
        self.file.save(&PreKeyFileData { keys })
    }
}

#[async_trait(?Send)]
impl PreKeyStore for FilePreKeyStore {
    async fn get_pre_key(&self, prekey_id: PreKeyId) -> SignalResult<PreKeyRecord> {
        self.keys
            .get(&u32::from(prekey_id))
            .cloned()
            .ok_or(SignalProtocolError::InvalidPreKeyId)
    }

    async fn save_pre_key(&mut self, prekey_id: PreKeyId, record: &PreKeyRecord) -> SignalResult<()> {
        self.keys.insert(u32::from(prekey_id), record.to_owned());
        self.persist()
            .map_err(|e| SignalProtocolError::InvalidState("save_pre_key", e.to_string()))
    }

    async fn remove_pre_key(&mut self, prekey_id: PreKeyId) -> SignalResult<()> {
        self.keys.remove(&u32::from(prekey_id));
        self.persist()
            .map_err(|e| SignalProtocolError::InvalidState("remove_pre_key", e.to_string()))
    }
}

// --- Signed prekey store -------------------------------------------------

#[derive(Serialize, Deserialize, Default)]
struct SignedPreKeyFileData {
    keys: HashMap<u32, Vec<u8>>,
}

pub struct FileSignedPreKeyStore {
    file: EncryptedFile,
    keys: HashMap<u32, SignedPreKeyRecord>,
}

impl FileSignedPreKeyStore {
    fn open(dir: &str, key: [u8; 32]) -> Result<Self, SignalNativeError> {
        let file = EncryptedFile::new(dir, "signed_prekeys.enc", key);
        let data = file.load::<SignedPreKeyFileData>()?.unwrap_or_default();
        let mut keys = HashMap::with_capacity(data.keys.len());
        for (id, bytes) in data.keys {
            keys.insert(id, SignedPreKeyRecord::deserialize(&bytes)?);
        }
        Ok(Self { file, keys })
    }

    fn persist(&self) -> Result<(), SignalNativeError> {
        let mut keys = HashMap::with_capacity(self.keys.len());
        for (id, record) in &self.keys {
            keys.insert(*id, record.serialize()?);
        }
        self.file.save(&SignedPreKeyFileData { keys })
    }
}

#[async_trait(?Send)]
impl SignedPreKeyStore for FileSignedPreKeyStore {
    async fn get_signed_pre_key(&self, signed_prekey_id: SignedPreKeyId) -> SignalResult<SignedPreKeyRecord> {
        self.keys
            .get(&u32::from(signed_prekey_id))
            .cloned()
            .ok_or(SignalProtocolError::InvalidSignedPreKeyId)
    }

    async fn save_signed_pre_key(
        &mut self,
        signed_prekey_id: SignedPreKeyId,
        record: &SignedPreKeyRecord,
    ) -> SignalResult<()> {
        self.keys.insert(u32::from(signed_prekey_id), record.to_owned());
        self.persist()
            .map_err(|e| SignalProtocolError::InvalidState("save_signed_pre_key", e.to_string()))
    }
}

// --- Kyber prekey store ----------------------------------------------------

#[derive(Serialize, Deserialize, Default)]
struct KyberPreKeyFileData {
    keys: HashMap<u32, Vec<u8>>,
    // (kyber_prekey_id, ec_prekey_id) -> serialized base keys seen (replay protection)
    base_keys_seen: HashMap<(u32, u32), Vec<Vec<u8>>>,
}

pub struct FileKyberPreKeyStore {
    file: EncryptedFile,
    keys: HashMap<u32, KyberPreKeyRecord>,
    base_keys_seen: HashMap<(u32, u32), Vec<PublicKey>>,
}

impl FileKyberPreKeyStore {
    fn open(dir: &str, key: [u8; 32]) -> Result<Self, SignalNativeError> {
        let file = EncryptedFile::new(dir, "kyber_prekeys.enc", key);
        let data = file.load::<KyberPreKeyFileData>()?.unwrap_or_default();
        let mut keys = HashMap::with_capacity(data.keys.len());
        for (id, bytes) in data.keys {
            keys.insert(id, KyberPreKeyRecord::deserialize(&bytes)?);
        }
        let mut base_keys_seen = HashMap::with_capacity(data.base_keys_seen.len());
        for (id_pair, key_bytes_list) in data.base_keys_seen {
            let mut parsed = Vec::with_capacity(key_bytes_list.len());
            for bytes in key_bytes_list {
                parsed.push(PublicKey::deserialize(&bytes).map_err(|e| {
                    SignalNativeError::Storage(format!("invalid stored base key: {e}"))
                })?);
            }
            base_keys_seen.insert(id_pair, parsed);
        }
        Ok(Self {
            file,
            keys,
            base_keys_seen,
        })
    }

    fn persist(&self) -> Result<(), SignalNativeError> {
        let mut keys = HashMap::with_capacity(self.keys.len());
        for (id, record) in &self.keys {
            keys.insert(*id, record.serialize()?);
        }
        let mut base_keys_seen = HashMap::with_capacity(self.base_keys_seen.len());
        for (id_pair, key_list) in &self.base_keys_seen {
            base_keys_seen.insert(
                *id_pair,
                key_list.iter().map(|k| k.serialize().to_vec()).collect(),
            );
        }
        self.file.save(&KyberPreKeyFileData {
            keys,
            base_keys_seen,
        })
    }
}

#[async_trait(?Send)]
impl KyberPreKeyStore for FileKyberPreKeyStore {
    async fn get_kyber_pre_key(&self, kyber_prekey_id: KyberPreKeyId) -> SignalResult<KyberPreKeyRecord> {
        self.keys
            .get(&u32::from(kyber_prekey_id))
            .cloned()
            .ok_or(SignalProtocolError::InvalidKyberPreKeyId)
    }

    async fn save_kyber_pre_key(
        &mut self,
        kyber_prekey_id: KyberPreKeyId,
        record: &KyberPreKeyRecord,
    ) -> SignalResult<()> {
        self.keys.insert(u32::from(kyber_prekey_id), record.to_owned());
        self.persist()
            .map_err(|e| SignalProtocolError::InvalidState("save_kyber_pre_key", e.to_string()))
    }

    async fn mark_kyber_pre_key_used(
        &mut self,
        kyber_prekey_id: KyberPreKeyId,
        ec_prekey_id: SignedPreKeyId,
        base_key: &PublicKey,
    ) -> SignalResult<()> {
        let seen = self
            .base_keys_seen
            .entry((u32::from(kyber_prekey_id), u32::from(ec_prekey_id)))
            .or_default();
        if seen.contains(base_key) {
            return Err(SignalProtocolError::InvalidMessage(
                libsignal_protocol::CiphertextMessageType::PreKey,
                "reused base key".to_owned(),
            ));
        }
        seen.push(*base_key);
        self.persist()
            .map_err(|e| SignalProtocolError::InvalidState("mark_kyber_pre_key_used", e.to_string()))
    }
}

// --- Session store -------------------------------------------------------

#[derive(Serialize, Deserialize, Default)]
struct SessionFileData {
    sessions: HashMap<String, Vec<u8>>,
}

pub struct FileSessionStore {
    file: EncryptedFile,
    sessions: HashMap<String, SessionRecord>,
}

impl FileSessionStore {
    fn open(dir: &str, key: [u8; 32]) -> Result<Self, SignalNativeError> {
        let file = EncryptedFile::new(dir, "sessions.enc", key);
        let data = file.load::<SessionFileData>()?.unwrap_or_default();
        let mut sessions = HashMap::with_capacity(data.sessions.len());
        for (address, bytes) in data.sessions {
            sessions.insert(address, SessionRecord::deserialize(&bytes)?);
        }
        Ok(Self { file, sessions })
    }

    fn persist(&self) -> Result<(), SignalNativeError> {
        let mut sessions = HashMap::with_capacity(self.sessions.len());
        for (address, record) in &self.sessions {
            sessions.insert(address.clone(), record.serialize()?);
        }
        self.file.save(&SessionFileData { sessions })
    }
}

#[async_trait(?Send)]
impl SessionStore for FileSessionStore {
    async fn load_session(&self, address: &ProtocolAddress) -> SignalResult<Option<SessionRecord>> {
        Ok(self.sessions.get(&address_key(address)).cloned())
    }

    async fn store_session(
        &mut self,
        address: &ProtocolAddress,
        record: &SessionRecord,
    ) -> SignalResult<()> {
        self.sessions
            .insert(address_key(address), record.to_owned());
        self.persist()
            .map_err(|e| SignalProtocolError::InvalidState("store_session", e.to_string()))
    }
}

// --- Combined store --------------------------------------------------------

/// Mirrors `InMemSignalProtocolStore`'s field layout (same field names) so
/// call sites in lib.rs that destructure it for disjoint `&mut dyn Trait`
/// borrows barely change. `sender_key_store` stays in-memory-only: sender
/// keys are for group messaging, which this app doesn't implement yet, so
/// there's nothing meaningful to persist there.
pub struct PersistentSignalProtocolStore {
    pub session_store: FileSessionStore,
    pub pre_key_store: FilePreKeyStore,
    pub signed_pre_key_store: FileSignedPreKeyStore,
    pub kyber_pre_key_store: FileKyberPreKeyStore,
    pub identity_store: FileIdentityKeyStore,
    pub sender_key_store: InMemSenderKeyStore,
}

impl PersistentSignalProtocolStore {
    /// Opens (or creates, on first run) the encrypted on-disk store for one
    /// device identity. `master_key` must be exactly 32 bytes — custody of
    /// it is the caller's responsibility (see module docs).
    pub fn open(storage_dir: &str, master_key: &[u8]) -> Result<Self, SignalNativeError> {
        let key: [u8; 32] = master_key
            .try_into()
            .map_err(|_| SignalNativeError::InvalidMasterKeyLength(master_key.len()))?;

        Ok(Self {
            identity_store: FileIdentityKeyStore::open(storage_dir, key)?,
            pre_key_store: FilePreKeyStore::open(storage_dir, key)?,
            signed_pre_key_store: FileSignedPreKeyStore::open(storage_dir, key)?,
            kyber_pre_key_store: FileKyberPreKeyStore::open(storage_dir, key)?,
            session_store: FileSessionStore::open(storage_dir, key)?,
            sender_key_store: InMemSenderKeyStore::new(),
        })
    }
}
