//! Sealing images before they leave the phone.
//!
//! An image is not sent through the Signal Protocol the way text is. A group
//! message is one row carrying a separately encrypted copy for every member,
//! and a photo multiplied by ten members does not fit in a row realtime will
//! deliver. So the image is sealed once, here, under a key made for it alone;
//! the sealed bytes go to storage, and only the key travels inside each
//! member's ordinary Signal envelope. See docs/plans-deferred.md.
//!
//! No new cryptography: AES-256-GCM from RustCrypto, the same primitive and
//! the same system randomness as the recovery backups in `backup.rs`.
//!
//! What the server can learn from a sealed attachment is its length, so the
//! length is made to say little. The plaintext is padded to a multiple of
//! 64 KiB before sealing: two photos of different sizes usually come out the
//! same size, and the stored length narrows the original down to a band
//! rather than a byte count. Same reasoning as the `p` field in the app's
//! message payload.
//!
//! Why the message id is not authenticated alongside the image. It would be
//! the usual way to stop a sealed blob being moved to another message, but
//! here it adds nothing: every attachment gets its own key, and that key lives
//! only inside the one message it belongs to. A blob moved to another message
//! meets a different key and fails to open. Keeping it out also means sealing
//! does not have to wait for the server to assign the id.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use rand::RngCore as _;
use rand::TryRngCore as _;

use crate::SignalNativeError;

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const LENGTH_PREFIX: usize = 4;

/// Versioned and authenticated, as in `backup.rs`: a future format is refused
/// with a clear reason instead of failing as a bad key.
const MAGIC: &[u8] = b"SEIXOIMG1";

/// The padding unit. Large enough that sizes collapse into few bands; small
/// enough that a typical photo does not grow by more than a small fraction.
const PAD_UNIT: usize = 64 * 1024;

/// The storage bucket refuses anything over 2 MiB (migration 0027). The
/// largest padded body that still fits with the header and tag is 31 units,
/// and this is the plaintext that pads to exactly that. Refused here so a
/// photo that is somehow too large fails with a reason on the phone, rather
/// than as an unexplained upload error.
const MAX_PADDED: usize = 31 * PAD_UNIT;
pub const MAX_ATTACHMENT_BYTES: usize = MAX_PADDED - LENGTH_PREFIX;

/// A sealed image and the key that opens it.
///
/// The key is the only thing that must stay secret, and it never goes to
/// storage: it rides inside the encrypted message. The sealed bytes are
/// useless without it.
#[derive(uniffi::Record, Debug)]
pub struct SealedAttachment {
    pub key: Vec<u8>,
    pub sealed: Vec<u8>,
}

/// Seals `plaintext` under a fresh random key.
#[uniffi::export]
pub fn seal_attachment(plaintext: Vec<u8>) -> Result<SealedAttachment, SignalNativeError> {
    if plaintext.is_empty() {
        return Err(SignalNativeError::Storage("the image is empty".into()));
    }
    if plaintext.len() > MAX_ATTACHMENT_BYTES {
        return Err(SignalNativeError::Storage(format!(
            "the image is too large to send ({} bytes, the limit is {})",
            plaintext.len(),
            MAX_ATTACHMENT_BYTES
        )));
    }

    let mut key = vec![0u8; KEY_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    let mut rng = rand::rngs::OsRng.unwrap_err();
    rng.fill_bytes(&mut key);
    rng.fill_bytes(&mut nonce_bytes);

    let padded = pad(&plaintext);
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| SignalNativeError::Storage(e.to_string()))?;

    // The magic is authenticated, not merely prefixed, so a blob whose header
    // was edited fails to open rather than opening as something else.
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            aes_gcm::aead::Payload {
                msg: &padded,
                aad: MAGIC,
            },
        )
        .map_err(|_| SignalNativeError::Storage("could not seal the image".into()))?;

    let mut sealed = Vec::with_capacity(MAGIC.len() + NONCE_LEN + ciphertext.len());
    sealed.extend_from_slice(MAGIC);
    sealed.extend_from_slice(&nonce_bytes);
    sealed.extend_from_slice(&ciphertext);

    Ok(SealedAttachment { key, sealed })
}

/// Opens bytes produced by `seal_attachment`.
///
/// A wrong key, a truncated download and tampered bytes all fail the same
/// way. The caller only needs to know the image cannot be shown.
#[uniffi::export]
pub fn open_attachment(key: Vec<u8>, sealed: Vec<u8>) -> Result<Vec<u8>, SignalNativeError> {
    let unavailable = || SignalNativeError::Storage("this image cannot be opened".into());

    if key.len() != KEY_LEN {
        return Err(unavailable());
    }
    if sealed.len() < MAGIC.len() + NONCE_LEN + TAG_LEN || &sealed[..MAGIC.len()] != MAGIC {
        return Err(unavailable());
    }

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| unavailable())?;
    let (nonce_bytes, ciphertext) = sealed[MAGIC.len()..].split_at(NONCE_LEN);
    let padded = cipher
        .decrypt(
            Nonce::from_slice(nonce_bytes),
            aes_gcm::aead::Payload {
                msg: ciphertext,
                aad: MAGIC,
            },
        )
        .map_err(|_| unavailable())?;

    unpad(&padded).ok_or_else(unavailable)
}

/// Length-prefixed, then zero-filled to the next whole unit.
fn pad(plaintext: &[u8]) -> Vec<u8> {
    let body = LENGTH_PREFIX + plaintext.len();
    let padded_len = body.div_ceil(PAD_UNIT) * PAD_UNIT;
    let mut padded = Vec::with_capacity(padded_len);
    padded.extend_from_slice(&(plaintext.len() as u32).to_be_bytes());
    padded.extend_from_slice(plaintext);
    padded.resize(padded_len, 0);
    padded
}

/// Reverses `pad`, refusing a length prefix that points past the data. That
/// cannot happen to anything that authenticated -- AES-GCM already rejected
/// every altered byte -- but a decoder should never trust a length it did not
/// check.
fn unpad(padded: &[u8]) -> Option<Vec<u8>> {
    if padded.len() < LENGTH_PREFIX {
        return None;
    }
    let len = u32::from_be_bytes(padded[..LENGTH_PREFIX].try_into().ok()?) as usize;
    let end = LENGTH_PREFIX.checked_add(len)?;
    if end > padded.len() {
        return None;
    }
    Some(padded[LENGTH_PREFIX..end].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 31 % 251) as u8).collect()
    }

    #[test]
    fn round_trips_small_and_large_images() {
        for len in [1usize, 700, PAD_UNIT - LENGTH_PREFIX, PAD_UNIT, 900_000, MAX_ATTACHMENT_BYTES] {
            let original = bytes(len);
            let sealed = seal_attachment(original.clone()).expect("seal");
            assert_eq!(sealed.key.len(), KEY_LEN);
            let opened = open_attachment(sealed.key, sealed.sealed).expect("open");
            assert_eq!(opened, original, "round trip failed at {len} bytes");
        }
    }

    #[test]
    fn padding_hides_the_exact_size() {
        // Everything that fits in one unit seals to the same length, so the
        // stored size cannot tell a small picture from a slightly larger one.
        let tiny = seal_attachment(bytes(10)).unwrap().sealed.len();
        let fuller = seal_attachment(bytes(60_000)).unwrap().sealed.len();
        assert_eq!(tiny, fuller);

        // Crossing a unit boundary is the only thing that moves it.
        let next_unit = seal_attachment(bytes(70_000)).unwrap().sealed.len();
        assert_eq!(next_unit, tiny + PAD_UNIT);
    }

    #[test]
    fn largest_image_still_fits_the_bucket() {
        let sealed = seal_attachment(bytes(MAX_ATTACHMENT_BYTES)).unwrap().sealed;
        assert!(sealed.len() <= 2 * 1024 * 1024, "sealed {} bytes", sealed.len());
    }

    #[test]
    fn refuses_empty_and_oversized_images() {
        assert!(seal_attachment(Vec::new()).is_err());
        assert!(seal_attachment(bytes(MAX_ATTACHMENT_BYTES + 1)).is_err());
    }

    #[test]
    fn every_seal_gets_its_own_key() {
        let original = bytes(5_000);
        let a = seal_attachment(original.clone()).unwrap();
        let b = seal_attachment(original).unwrap();
        assert_ne!(a.key, b.key);
        assert_ne!(a.sealed, b.sealed);
    }

    #[test]
    fn another_messages_key_does_not_open_it() {
        // The property that makes authenticating the message id unnecessary:
        // a blob moved to another message meets that message's key and fails.
        let a = seal_attachment(bytes(5_000)).unwrap();
        let b = seal_attachment(bytes(5_000)).unwrap();
        assert!(open_attachment(b.key, a.sealed).is_err());
    }

    #[test]
    fn any_altered_byte_is_refused() {
        let sealed = seal_attachment(bytes(5_000)).unwrap();
        for index in [0, MAGIC.len(), MAGIC.len() + NONCE_LEN, sealed.sealed.len() - 1] {
            let mut tampered = sealed.sealed.clone();
            tampered[index] ^= 0x01;
            assert!(
                open_attachment(sealed.key.clone(), tampered).is_err(),
                "a flipped bit at {index} was accepted"
            );
        }
    }

    #[test]
    fn malformed_input_fails_without_panicking() {
        let sealed = seal_attachment(bytes(5_000)).unwrap();
        assert!(open_attachment(sealed.key.clone(), Vec::new()).is_err());
        assert!(open_attachment(sealed.key.clone(), sealed.sealed[..20].to_vec()).is_err());
        assert!(open_attachment(vec![0u8; 5], sealed.sealed.clone()).is_err());
        assert!(open_attachment(sealed.key, b"not an image at all".to_vec()).is_err());
    }

    #[test]
    fn unpad_refuses_a_length_that_points_past_the_data() {
        let mut forged = vec![0u8; 16];
        forged[..4].copy_from_slice(&1_000_000u32.to_be_bytes());
        assert_eq!(unpad(&forged), None);
    }
}
