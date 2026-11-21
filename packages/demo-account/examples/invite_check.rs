//! A second "phone" for testing invite links with only one real iPhone.
//!
//! Uses the app's own Signal module and the same API calls the app makes, as
//! live_check does. Creates a throwaway anonymous account and deletes it at
//! the end (through the delete-account Edge Function, as the app does).
//! Reads the project URL and public anon key from app/.env.
//!
//! Two directions:
//!
//!     cargo run --release --example invite_check -- host
//!         Makes an invite and prints its link. Open the link on the iPhone
//!         (Seixo Dev): accept, and send a message. This phone answers it.
//!
//!     cargo run --release --example invite_check -- guest <invite link>
//!         Uses an invite made on the iPhone: starts the conversation and
//!         writes first. Answer it on the iPhone; this phone reads the answer.

use rand::RngCore as _;
use serde_json::{json, Value};
use sha2::Digest as _;
use signal_native::{EncryptedEnvelope, PreKeyBundleData, SignalDevice};
use std::time::{Duration, Instant};

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
            Err(ureq::Error::Status(code, r)) => panic!("POST {path} -> {code}: {}", r.into_string().unwrap()),
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
fn base64url(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

struct Phone {
    api: Api,
    me: String,
    device: std::sync::Arc<SignalDevice>,
}

/// A new anonymous account with published keys, as onboarding makes.
fn new_phone() -> Phone {
    let env = std::fs::read_to_string("../../app/.env").unwrap();
    let var = |k: &str| env.lines().find_map(|l| l.strip_prefix(&format!("{k}="))).unwrap().trim().to_string();
    let (url, anon) = (var("EXPO_PUBLIC_SUPABASE_URL"), var("EXPO_PUBLIC_SUPABASE_ANON_KEY"));
    let session: Value = ureq::post(&format!("{url}/auth/v1/signup"))
        .set("apikey", &anon)
        .send_json(json!({ "data": {} }))
        .unwrap()
        .into_json()
        .unwrap();
    let me = s(&session["user"]["id"]);
    let api = Api { url, anon, token: s(&session["access_token"]) };
    let dir = std::env::temp_dir().join(format!("invite-check-{me}"));
    std::fs::create_dir_all(&dir).unwrap();
    let device = SignalDevice::new(me.clone(), 1, vec![7; 32], dir.to_string_lossy().into()).unwrap();
    let own = device.generate_prekey_bundle(1, 1, 1).unwrap();
    api.post("/rest/v1/identities", json!({ "user_id": me, "identity_public_key": own.identity_key_base64, "registration_id": own.registration_id }));
    api.post(
        "/rest/v1/signed_prekeys",
        json!({ "owner_id": me, "signed_prekey_id": own.signed_prekey_id, "public_key": own.signed_prekey_public_base64,
                "signature": own.signed_prekey_signature_base64, "kyber_prekey_id": own.kyber_prekey_id,
                "kyber_prekey_public_key": own.kyber_prekey_public_base64, "kyber_prekey_signature": own.kyber_prekey_signature_base64 }),
    );
    api.post("/rest/v1/one_time_prekeys", json!({ "owner_id": me, "prekey_id": own.one_time_prekey_id, "public_key": own.one_time_prekey_public_base64 }));
    println!("test account {me}");
    Phone { api, me, device }
}

impl Phone {
    /// Opens a session with `peer` from their published keys, as
    /// startConversationWithPeer does after create_direct_channel.
    fn session_with(&self, peer: &str) {
        let identity = self.api.get(&format!("/rest/v1/identities?select=identity_public_key,registration_id&user_id=eq.{peer}"))[0].clone();
        let signed = self.api.get(&format!("/rest/v1/signed_prekeys?select=*&owner_id=eq.{peer}"))[0].clone();
        let one_time = self.api.get(&format!("/rest/v1/one_time_prekeys?select=id,prekey_id,public_key&owner_id=eq.{peer}&limit=1"))[0].clone();
        self.api.req("DELETE", &format!("/rest/v1/one_time_prekeys?id=eq.{}", s(&one_time["id"]))).call().unwrap();
        self.device
            .establish_session(
                peer.to_string(),
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
    }

    fn send(&self, channel: &str, peer: &str, text: &str) -> String {
        let envelope = self.device.encrypt(peer.to_string(), 1, text.into()).unwrap();
        let wire = json!({ "t": envelope.message_type, "c": envelope.ciphertext_base64 }).to_string();
        let row = self.api.post(
            "/rest/v1/messages",
            json!({ "channel_id": channel, "ciphertext": wire, "expires_at": in_one_day(), "silent": false }),
        );
        s(&row[0]["id"])
    }

    fn open(&self, peer: &str, row: &Value) -> String {
        let wire: Value = serde_json::from_str(row["ciphertext"].as_str().unwrap()).unwrap();
        self.device
            .decrypt(
                peer.to_string(),
                1,
                EncryptedEnvelope { message_type: wire["t"].as_u64().unwrap() as u8, ciphertext_base64: s(&wire["c"]) },
            )
            .unwrap()
    }

    /// Waits up to `secs` for a message in `channel` that is not in `skip`.
    fn wait_message(&self, channel: &str, skip: &[String], secs: u64) -> Option<Value> {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            let rows = self.api.get(&format!("/rest/v1/messages?select=id,ciphertext,created_at&channel_id=eq.{channel}&order=created_at.asc"));
            if let Some(row) = rows.as_array().unwrap().iter().find(|r| !skip.contains(&s(&r["id"]))) {
                return Some(row.clone());
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_secs(3));
        }
    }

    fn delete(&self) {
        match self.api.req("POST", "/functions/v1/delete-account").send_json(json!({})) {
            Ok(_) => println!("test account {} deleted", self.me),
            Err(e) => println!("could not delete test account {}: {e}", self.me),
        }
    }
}

fn in_one_day() -> String {
    // RFC 3339 for now + 24 h, computed without a date crate.
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 86_400;
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (h, m, sec) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil from days (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{sec:02}Z")
}

fn host() {
    let phone = new_phone();
    let mut raw = [0u8; 16];
    rand::rng().fill_bytes(&mut raw);
    let code = base64url(&raw);
    let hash = hex(&sha2::Sha256::digest(code.as_bytes()));
    phone.api.post("/rest/v1/rpc/create_invite", json!({ "code_hash": format!("\\x{hash}") }));
    println!("\nINVITE LINK: https://xeixos-corp.github.io/c/#{code}\n");
    println!("Open it on the iPhone (Seixo Dev), accept, and send a message. Waiting up to 15 minutes...");

    // The iPhone's acceptance creates a channel with this account in it.
    let deadline = Instant::now() + Duration::from_secs(900);
    let (channel, peer) = loop {
        let mine = phone.api.get(&format!("/rest/v1/channel_members?select=channel_id&member_id=eq.{}", phone.me));
        if let Some(row) = mine.as_array().unwrap().first() {
            let channel = s(&row["channel_id"]);
            let members = phone.api.get(&format!("/rest/v1/channel_members?select=member_id&channel_id=eq.{channel}"));
            let peer = members.as_array().unwrap().iter().map(|m| s(&m["member_id"])).find(|m| m != &phone.me);
            if let Some(peer) = peer {
                break (channel, peer);
            }
        }
        if Instant::now() > deadline {
            println!("nobody accepted the invite");
            phone.delete();
            return;
        }
        std::thread::sleep(Duration::from_secs(3));
    };
    let used = phone.api.get("/rest/v1/invites?select=used_at");
    println!("invite accepted: conversation {channel}; invite marked used: {}", !used[0]["used_at"].is_null());

    let mut skip = vec![];
    match phone.wait_message(&channel, &skip, 600) {
        Some(row) => {
            skip.push(s(&row["id"]));
            println!("message from the iPhone: {}", phone.open(&peer, &row));
            phone.send(&channel, &peer, "Recebi! Respondo pelo convite de teste.");
            println!("answer sent; check it arrived on the iPhone");
        }
        None => println!("no message arrived"),
    }
    std::thread::sleep(Duration::from_secs(20));
    phone.delete();
}

fn guest(link: &str) {
    let code = link.rsplit('#').next().unwrap().trim().to_string();
    let phone = new_phone();
    let inviter = s(&phone.api.post("/rest/v1/rpc/redeem_invite", json!({ "code": code })));
    println!("invite redeemed; inviter {inviter}");
    let channel = s(&phone.api.post("/rest/v1/rpc/create_direct_channel", json!({ "peer_id": inviter })));
    phone.session_with(&inviter);
    let sent = phone.send(&channel, &inviter, "Olá! Aceitei o teu convite de teste.");
    println!("message sent in conversation {channel}. Answer it on the iPhone. Waiting up to 10 minutes...");
    match phone.wait_message(&channel, &[sent], 600) {
        Some(row) => println!("answer from the iPhone: {}", phone.open(&inviter, &row)),
        None => println!("no answer arrived"),
    }
    phone.delete();
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("host") => host(),
        Some("guest") => guest(args.get(2).expect("invite link")),
        _ => eprintln!("usage: invite_check host | guest <invite link>"),
    }
}
