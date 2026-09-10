//! Recovery backups: a small encrypted blob that restores *who you are* on a
//! new device, and nothing else.
//!
//! What it deliberately does not contain: message history, session state, or
//! prekey private halves. Restoring ratchet state onto a second device is how
//! you corrupt a Double Ratchet -- two devices advancing the same chain reuse
//! message keys and silently destroy messages, a failure this project has
//! already paid for twice. So a restore keeps the identity key pair (the
//! thing peers have verified, and the thing that makes safety numbers survive
//! the move) and lets every session be built again from scratch, which the
//! protocol already does correctly on first contact.
//!
//! No new cryptography is implemented here. The passphrase becomes a key via
//! HKDF-SHA256 and the blob is sealed with AES-256-GCM, both from RustCrypto,
//! exactly as `store.rs` already does at rest. HKDF rather than a slow
//! password hash is a choice tied to *how the phrase is made*:
//! `generate_recovery_phrase` takes 128 bits from the system CSPRNG, so there
//! is no dictionary to run and stretching would buy nothing. If a user-chosen
//! passphrase ever becomes an option, this must become Argon2id first.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use bip39::Mnemonic;
use hkdf::Hkdf;
use rand::RngCore as _;
use rand::TryRngCore as _;
use sha2::Sha256;

use crate::SignalNativeError;

const NONCE_LEN: usize = 12;
const ENTROPY_LEN: usize = 16;

/// Domain separation, so the same phrase can later derive other keys (server
/// credentials, say) without any of them being the backup key.
const HKDF_INFO_FILE_KEY: &[u8] = b"seixo.backup.file-key.v1";
const HKDF_INFO_EMAIL: &[u8] = b"seixo.backup.account-email.v1";
const HKDF_INFO_PASSWORD: &[u8] = b"seixo.backup.account-password.v1";

/// Reserved by RFC 2606 and guaranteed never to resolve, so the address
/// derived below cannot receive mail even by accident. It exists to name an
/// account, not to reach a person -- there is no inbox, and nothing is ever
/// sent to it.
const ACCOUNT_EMAIL_DOMAIN: &str = "@seixo.invalid";

/// Versioned, so a future format change is recognised and refused with a
/// useful message instead of failing as "wrong phrase".
const MAGIC: &[u8] = b"SEIXOBAK1";

/// A fresh 12-word recovery phrase, 128 bits from the system CSPRNG.
///
/// BIP-39 rather than a homemade wordlist for one practical reason: it
/// carries a checksum, so a phrase mistyped or misread off paper is rejected
/// as invalid instead of silently deriving the wrong key and reporting a
/// perfectly good backup as corrupt.
#[uniffi::export]
pub fn generate_recovery_phrase() -> Result<String, SignalNativeError> {
    let mut entropy = [0u8; ENTROPY_LEN];
    rand::rngs::OsRng.unwrap_err().fill_bytes(&mut entropy);
    let mnemonic = Mnemonic::from_entropy(&entropy)
        .map_err(|e| SignalNativeError::Storage(format!("could not build a phrase: {e}")))?;
    Ok(mnemonic.to_string())
}

/// True if `phrase` is a well-formed recovery phrase (wordlist + checksum).
///
/// Lets the UI reject a typo while the user still has the paper in hand,
/// rather than after they have wiped the old device.
#[uniffi::export]
pub fn is_valid_recovery_phrase(phrase: String) -> bool {
    normalize(&phrase)
        .and_then(|p| Mnemonic::parse_normalized(&p).ok())
        .is_some()
}

/// Seals `plaintext` under a key derived from `phrase`.
///
/// The caller decides what goes in; this module only guarantees that whatever
/// went in comes back byte for byte, or not at all.
#[uniffi::export]
pub fn encrypt_backup(phrase: String, plaintext: String) -> Result<String, SignalNativeError> {
    let key = derive_file_key(&phrase)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| SignalNativeError::Storage(e.to_string()))?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.unwrap_err().fill_bytes(&mut nonce_bytes);

    // The magic is authenticated, not merely prefixed: passing it as the AEAD
    // associated data means a blob whose header was edited fails to open,
    // rather than opening as something it is not.
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            aes_gcm::aead::Payload {
                msg: plaintext.as_bytes(),
                aad: MAGIC,
            },
        )
        .map_err(|_| SignalNativeError::Storage("could not encrypt the backup".into()))?;

    let mut out = Vec::with_capacity(MAGIC.len() + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(BASE64.encode(out))
}

/// Opens a blob produced by `encrypt_backup`.
///
/// Wrong phrase, truncated file and tampered bytes all fail the same way on
/// purpose: telling them apart would tell whoever holds the file which of
/// their guesses was closest.
#[uniffi::export]
pub fn decrypt_backup(phrase: String, blob: String) -> Result<String, SignalNativeError> {
    let bytes = BASE64
        .decode(blob.trim())
        .map_err(|_| SignalNativeError::Storage("this is not a Seixo backup file".into()))?;

    if bytes.len() < MAGIC.len() + NONCE_LEN || &bytes[..MAGIC.len()] != MAGIC {
        return Err(SignalNativeError::Storage(
            "this is not a Seixo backup file".into(),
        ));
    }

    let key = derive_file_key(&phrase)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| SignalNativeError::Storage(e.to_string()))?;

    let (nonce_bytes, ciphertext) = bytes[MAGIC.len()..].split_at(NONCE_LEN);
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce_bytes),
            aes_gcm::aead::Payload {
                msg: ciphertext,
                aad: MAGIC,
            },
        )
        .map_err(|_| {
            SignalNativeError::Storage("wrong recovery phrase, or the file is damaged".into())
        })?;

    String::from_utf8(plaintext)
        .map_err(|_| SignalNativeError::Storage("the backup contents are not valid text".into()))
}

/// The account credentials a recovery phrase implies.
///
/// Restoring an identity is only half of coming back: the account itself has
/// to be re-entered, or contacts would be writing to a user id nobody can
/// read. Rather than store a token that expires, the phrase *derives* a
/// credential pair deterministically, so the same words always reopen the
/// same account and nothing has to be kept anywhere.
///
/// The address is deliberately unreachable (see `ACCOUNT_EMAIL_DOMAIN`) and
/// reveals nothing: it is a hash of a secret the server never sees. The
/// password carries the phrase's full 128 bits, so guessing it is guessing
/// the phrase.
#[derive(uniffi::Record)]
pub struct BackupCredentials {
    pub email: String,
    pub password: String,
}

/// Derives the account credentials for a phrase. Same phrase, same account,
/// on any device and at any time -- no state, nothing stored.
#[uniffi::export]
pub fn derive_backup_credentials(phrase: String) -> Result<BackupCredentials, SignalNativeError> {
    let entropy = phrase_entropy(&phrase)?;
    let hkdf = Hkdf::<Sha256>::new(None, &entropy);

    let mut email_bytes = [0u8; 16];
    hkdf.expand(HKDF_INFO_EMAIL, &mut email_bytes)
        .map_err(|e| SignalNativeError::Storage(e.to_string()))?;
    let local_part: String = email_bytes.iter().map(|b| format!("{b:02x}")).collect();

    let mut password_bytes = [0u8; 32];
    hkdf.expand(HKDF_INFO_PASSWORD, &mut password_bytes)
        .map_err(|e| SignalNativeError::Storage(e.to_string()))?;

    Ok(BackupCredentials {
        email: format!("{local_part}{ACCOUNT_EMAIL_DOMAIN}"),
        password: BASE64.encode(password_bytes),
    })
}

/// Lowercases and collapses whitespace, so a phrase read off paper opens the
/// backup whether or not it was typed with the same spacing or capitals.
fn normalize(phrase: &str) -> Option<String> {
    let words: Vec<&str> = phrase.split_whitespace().collect();
    if words.is_empty() {
        return None;
    }
    Some(words.join(" ").to_lowercase())
}

/// The phrase's underlying bytes.
///
/// Keyed on the entropy, not the text: the words are only a way of writing
/// those bytes down, so the same secret written in another wordlist language
/// still derives the same keys.
fn phrase_entropy(phrase: &str) -> Result<Vec<u8>, SignalNativeError> {
    let normalized = normalize(phrase)
        .ok_or_else(|| SignalNativeError::Storage("the recovery phrase is empty".into()))?;
    let mnemonic = Mnemonic::parse_normalized(&normalized)
        .map_err(|_| SignalNativeError::Storage("that is not a valid recovery phrase".into()))?;
    let (entropy, len) = mnemonic.to_entropy_array();
    Ok(entropy[..len].to_vec())
}

fn derive_file_key(phrase: &str) -> Result<[u8; 32], SignalNativeError> {
    let hkdf = Hkdf::<Sha256>::new(None, &phrase_entropy(phrase)?);
    let mut key = [0u8; 32];
    hkdf.expand(HKDF_INFO_FILE_KEY, &mut key)
        .map_err(|e| SignalNativeError::Storage(e.to_string()))?;
    Ok(key)
}
