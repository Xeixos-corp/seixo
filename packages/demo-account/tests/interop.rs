//! A phone (the app's own Signal module) and the demo account, end to end.

use signal_native::{open_attachment, PreKeyBundleData, SignalDevice};

const DEMO: &str = "00000000-0000-4000-8000-00000000d3e0";
const PHONE: &str = "11111111-1111-4111-8111-111111111111";

fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as f64
}

fn temp_dir() -> String {
    let dir = std::env::temp_dir().join(format!("demo-account-test-{}", rand::random::<u64>()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.to_string_lossy().into_owned()
}

#[test]
fn a_phone_and_the_demo_account_talk_both_ways() {
    let created = demo_account::create(now(), 5).unwrap();
    let bundle: serde_json::Value = serde_json::from_str(&created.json()).unwrap();
    let mut state = created.state();

    // The phone claims the bundle exactly as claimPeerPrekeyBundle builds it.
    let one_time = &bundle["oneTimePrekeys"][0];
    let phone = SignalDevice::new(PHONE.into(), 1, vec![7; 32], temp_dir()).unwrap();
    phone
        .establish_session(
            DEMO.into(),
            1,
            PreKeyBundleData {
                registration_id: bundle["registrationId"].as_u64().unwrap() as u32,
                device_id: 1,
                identity_key_base64: bundle["identityPublicKey"].as_str().unwrap().into(),
                one_time_prekey_id: one_time["id"].as_u64().unwrap() as u32,
                one_time_prekey_public_base64: one_time["publicKey"].as_str().unwrap().into(),
                signed_prekey_id: bundle["signedPrekeyId"].as_u64().unwrap() as u32,
                signed_prekey_public_base64: bundle["signedPrekeyPublic"].as_str().unwrap().into(),
                signed_prekey_signature_base64: bundle["signedPrekeySignature"].as_str().unwrap().into(),
                kyber_prekey_id: bundle["kyberPrekeyId"].as_u64().unwrap() as u32,
                kyber_prekey_public_base64: bundle["kyberPrekeyPublic"].as_str().unwrap().into(),
                kyber_prekey_signature_base64: bundle["kyberPrekeySignature"].as_str().unwrap().into(),
            },
        )
        .unwrap();
    assert!(!demo_account::has_session(&state, PHONE).unwrap());

    // Two messages before any reply: both PreKey messages, both must open.
    for text in ["Hello", "Anyone there?"] {
        let envelope = phone.encrypt(DEMO.into(), 1, text.into()).unwrap();
        assert_eq!(envelope.message_type, 3);
        let out = demo_account::decrypt(&state, DEMO, PHONE, envelope.message_type, &envelope.ciphertext_base64).unwrap();
        state = out.state();
        let json: serde_json::Value = serde_json::from_str(&out.json()).unwrap();
        assert_eq!(json["plaintext"], text);
    }
    assert!(demo_account::has_session(&state, PHONE).unwrap());

    // Replies, and the conversation carrying on afterwards.
    for round in 0..3 {
        let reply = format!("Reply {round}");
        let out = demo_account::encrypt(&state, DEMO, PHONE, &reply, now()).unwrap();
        state = out.state();
        let wire: serde_json::Value = serde_json::from_str(&out.json()).unwrap();
        let opened = phone
            .decrypt(
                DEMO.into(),
                1,
                signal_native::EncryptedEnvelope {
                    message_type: wire["t"].as_u64().unwrap() as u8,
                    ciphertext_base64: wire["c"].as_str().unwrap().into(),
                },
            )
            .unwrap();
        assert_eq!(opened, reply);

        let next = phone.encrypt(DEMO.into(), 1, format!("Answer {round}")).unwrap();
        let out = demo_account::decrypt(&state, DEMO, PHONE, next.message_type, &next.ciphertext_base64).unwrap();
        state = out.state();
        let json: serde_json::Value = serde_json::from_str(&out.json()).unwrap();
        assert_eq!(json["plaintext"], format!("Answer {round}"));
    }
}

#[test]
fn the_app_opens_a_photo_the_demo_account_sealed() {
    let photo: Vec<u8> = (0..100_000).map(|i| (i % 251) as u8).collect();
    let sealed = demo_account::seal_attachment(&photo).unwrap();
    assert_eq!(open_attachment(sealed.key(), sealed.sealed()).unwrap(), photo);
}

#[test]
fn more_prekeys_never_reuse_an_id() {
    let created = demo_account::create(now(), 3).unwrap();
    let out = demo_account::add_one_time_prekeys(&created.state(), 2).unwrap();
    let ids: Vec<u64> = serde_json::from_str::<serde_json::Value>(&out.json()).unwrap()
        .as_array().unwrap().iter().map(|p| p["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, vec![4, 5]);
}
