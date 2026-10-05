//! Talks to the live demo account the way a reviewer's phone does, using the
//! app's own Signal module, and checks every reply arrives and opens.
//!
//! Creates a throwaway anonymous account; delete it afterwards. Reads the
//! project URL and public anon key from app/.env (both already ship in the app).
//!
//!     cargo run --release --example live_check -- <demo-account-id>

use base64::Engine as _;
use serde_json::{json, Value};
use sha2::Digest as _;
use signal_native::{open_attachment, EncryptedEnvelope, PreKeyBundleData, SignalDevice};
use std::time::{Duration, Instant};

const PHOTO_SHA256: &str = "aa4c87d792376be865c33b739c971fbdecf9689bf0771ebb1da1165d4326268c";

struct Api {
    url: String,
    anon: String,
    token: String,
}

impl Api {
    fn req(&self, method: &str, path: &str) -> ureq::Request {
        ureq::request(method, &format!("{}{}", self.url, path))
            .set("apikey", &self.anon)
            .set("Authorization", &format!("Bearer {}", self.token))
    }

    fn get(&self, path: &str) -> Value {
        self.req("GET", path).call().unwrap().into_json().unwrap()
    }

    fn post(&self, path: &str, body: Value) -> Value {
        match self.req("POST", path).set("Prefer", "return=representation").send_json(body) {
            Ok(r) => r.into_json().unwrap_or(Value::Null),
            Err(ureq::Error::Status(code, r)) => {
                panic!("POST {path} -> {code}: {}", r.into_string().unwrap())
            }
            Err(e) => panic!("{e}"),
        }
    }
}

fn s(v: &Value) -> String {
    v.as_str().unwrap().to_string()
}

fn n(v: &Value) -> u32 {
    v.as_u64().unwrap() as u32
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let demo = std::env::args().nth(1).expect("demo account id");
    let env = std::fs::read_to_string("../../app/.env").unwrap();
    let var = |k: &str| {
        env.lines()
            .find_map(|l| l.strip_prefix(&format!("{k}=")))
            .unwrap()
            .trim()
            .to_string()
    };
    let url = var("EXPO_PUBLIC_SUPABASE_URL");
    let anon = var("EXPO_PUBLIC_SUPABASE_ANON_KEY");

    // A new anonymous account, as "Create identity" makes.
    let session: Value = ureq::post(&format!("{url}/auth/v1/signup"))
        .set("apikey", &anon)
        .send_json(json!({ "data": {} }))
        .unwrap()
        .into_json()
        .unwrap();
    let me = s(&session["user"]["id"]);
    let api = Api {
        url,
        anon,
        token: s(&session["access_token"]),
    };
    println!("test account {me}");

    let dir = std::env::temp_dir().join(format!("live-check-{me}"));
    std::fs::create_dir_all(&dir).unwrap();
    let phone =
        SignalDevice::new(me.clone(), 1, vec![9; 32], dir.to_string_lossy().into()).unwrap();
    let own = phone.generate_prekey_bundle(1, 1, 1).unwrap();
    api.post(
        "/rest/v1/identities",
        json!({ "user_id": me, "identity_public_key": own.identity_key_base64, "registration_id": own.registration_id }),
    );

    // Start the conversation exactly as startConversationWithPeer does.
    let channel = s(&api.post("/rest/v1/rpc/create_direct_channel", json!({ "peer_id": demo })));
    let identity = api.get(&format!(
        "/rest/v1/identities?select=identity_public_key,registration_id&user_id=eq.{demo}"
    ))[0]
        .clone();
    let signed = api.get(&format!("/rest/v1/signed_prekeys?select=*&owner_id=eq.{demo}"))[0].clone();
    let one_time = api.get(&format!(
        "/rest/v1/one_time_prekeys?select=id,prekey_id,public_key&owner_id=eq.{demo}&limit=1"
    ))[0]
        .clone();
    api.req("DELETE", &format!("/rest/v1/one_time_prekeys?id=eq.{}", s(&one_time["id"])))
        .call()
        .unwrap();
    phone
        .establish_session(
            demo.clone(),
            1,
            PreKeyBundleData {
                registration_id: n(&identity["registration_id"]),
                device_id: 1,
                identity_key_base64: s(&identity["identity_public_key"]),
                one_time_prekey_id: n(&one_time["prekey_id"]),
                one_time_prekey_public_base64: s(&one_time["public_key"]),
                signed_prekey_id: n(&signed["signed_prekey_id"]),
                signed_prekey_public_base64: s(&signed["public_key"]),
                signed_prekey_signature_base64: s(&signed["signature"]),
                kyber_prekey_id: n(&signed["kyber_prekey_id"]),
                kyber_prekey_public_base64: s(&signed["kyber_prekey_public_key"]),
                kyber_prekey_signature_base64: s(&signed["kyber_prekey_signature"]),
            },
        )
        .unwrap();

    let send = |text: &str| -> String {
        let envelope = phone.encrypt(demo.clone(), 1, text.into()).unwrap();
        let wire = json!({ "t": envelope.message_type, "c": envelope.ciphertext_base64 }).to_string();
        let row = api.post(
            "/rest/v1/messages",
            json!({ "channel_id": channel, "ciphertext": wire,
                    "expires_at": "2099-01-01T00:00:00Z", "silent": false }),
        );
        s(&row[0]["id"])
    };
    let wait_for = |count: usize, skip: &[String]| -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let rows = api.get(&format!(
                "/rest/v1/messages?select=id,ciphertext,created_at&channel_id=eq.{channel}&order=created_at.asc"
            ));
            let theirs: Vec<Value> = rows
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| !skip.contains(&s(&r["id"])))
                .cloned()
                .collect();
            if theirs.len() >= count || Instant::now() > deadline {
                return theirs;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    };
    let open = |row: &Value| -> String {
        let wire: Value = serde_json::from_str(row["ciphertext"].as_str().unwrap()).unwrap();
        phone
            .decrypt(
                demo.clone(),
                1,
                EncryptedEnvelope {
                    message_type: wire["t"].as_u64().unwrap() as u8,
                    ciphertext_base64: s(&wire["c"]),
                },
            )
            .unwrap()
    };

    let mut skip = vec![send("Hello")];
    let started = Instant::now();
    let replies = wait_for(4, &skip);
    println!("{} replies after {:?}", replies.len(), started.elapsed());
    for row in &replies {
        skip.push(s(&row["id"]));
        let text = open(row);
        if text.starts_with('{') {
            let payload: Value = serde_json::from_str(&text).unwrap();
            let key = base64::engine::general_purpose::STANDARD
                .decode(s(&payload["i"]["k"]))
                .unwrap();
            let response = api
                .req("GET", &format!("/storage/v1/object/authenticated/attachments/{}", s(&row["id"])))
                .call()
                .unwrap();
            let mut sealed = vec![];
            std::io::Read::read_to_end(&mut response.into_reader(), &mut sealed).unwrap();
            let photo = open_attachment(key, sealed).unwrap();
            let digest = hex(&sha2::Sha256::digest(&photo));
            println!(
                "  photo {}x{}, {} bytes, matches the original: {}",
                payload["i"]["w"],
                payload["i"]["h"],
                photo.len(),
                digest == PHOTO_SHA256
            );
        } else {
            println!("  text: {}", text.chars().take(70).collect::<String>());
        }
    }

    skip.push(send("Thanks!"));
    for row in &wait_for(1, &skip) {
        println!("  follow-up: {}", open(row).chars().take(70).collect::<String>());
    }
    println!("done; delete test account {me}");
}
