//! A second phone for testing voice calls with only one real iPhone.
//!
//! Built on invite_check: the same throwaway anonymous account, the app's own
//! Signal module, the same API calls. For the sound it uses webrtc-rs and does
//! one thing: it sends back whatever it hears. Whoever is on the iPhone hears
//! their own voice a moment later, which proves both directions of a call
//! (microphone to network, network to earpiece) without any audio codec here.
//!
//!     cargo run --release --example call_check
//!         Prints an invite link. Accept it on the iPhone (Seixo Dev), then
//!         call this phone from the conversation. It answers by itself.
//!
//!     cargo run --release --example call_check -- dial
//!         Same, but once the invite is accepted this phone calls the iPhone.
//!
//! Deletes its account at the end.

use rand::RngCore as _;
use serde_json::{json, Value};
use sha2::Digest as _;
use signal_native::{EncryptedEnvelope, PreKeyBundleData, SignalDevice};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_OPUS};
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};

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
    device: Arc<SignalDevice>,
}

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
    let dir = std::env::temp_dir().join(format!("call-check-{me}"));
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

    /// Sends a call signal exactly as the app's callManager does.
    fn send_call(&self, channel: &str, peer: &str, call: Value) -> String {
        let offer = call["y"] == "o";
        let payload = json!({
            "k": "seixo.msg.v1",
            "t": if offer { "I tried to call you on Seixo. Update the app to answer calls." } else { "" },
            "v": call,
        });
        let envelope = self.device.encrypt(peer.to_string(), 1, payload.to_string()).unwrap();
        let wire = json!({ "t": envelope.message_type, "c": envelope.ciphertext_base64 }).to_string();
        let row = self.api.post(
            "/rest/v1/messages",
            json!({ "channel_id": channel, "ciphertext": wire, "expires_at": in_one_day(), "silent": !offer }),
        );
        s(&row[0]["id"])
    }

    fn open(&self, peer: &str, row: &Value) -> Option<Value> {
        let wire: Value = serde_json::from_str(row["ciphertext"].as_str()?).ok()?;
        let plain = self
            .device
            .decrypt(
                peer.to_string(),
                1,
                EncryptedEnvelope { message_type: wire["t"].as_u64()? as u8, ciphertext_base64: s(&wire["c"]) },
            )
            .map_err(|e| println!("could not decrypt a message: {e:?}"))
            .ok()?;
        Some(serde_json::from_str::<Value>(&plain).unwrap_or(json!({ "t": plain })))
    }

    /// Every message in `channel` not yet seen, oldest first.
    fn new_messages(&self, channel: &str, seen: &mut Vec<String>) -> Vec<Value> {
        let rows = self.api.get(&format!("/rest/v1/messages?select=id,ciphertext,created_at&channel_id=eq.{channel}&order=created_at.asc"));
        let mut out = vec![];
        for row in rows.as_array().unwrap() {
            let id = s(&row["id"]);
            if !seen.contains(&id) {
                seen.push(id);
                out.push(row.clone());
            }
        }
        out
    }

    fn delete(&self) {
        match self.api.req("POST", "/functions/v1/delete-account").send_json(json!({})) {
            Ok(_) => println!("test account {} deleted", self.me),
            Err(e) => println!("could not delete test account {}: {e}", self.me),
        }
    }
}

fn in_one_day() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 86_400;
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (h, m, sec) = (rem / 3600, (rem % 3600) / 60, rem % 60);
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

struct Echo {
    pc: Arc<RTCPeerConnection>,
    received: Arc<AtomicUsize>,
    sent: Arc<AtomicUsize>,
    /// Packets big enough to carry speech. Opus sends tiny packets (a few
    /// bytes) for silence, so this says whether the microphone heard anything.
    voiced: Arc<AtomicUsize>,
}

/// A peer connection that sends back every audio packet it receives.
async fn echo_connection() -> Echo {
    let mut media = MediaEngine::default();
    media.register_default_codecs().unwrap();
    let registry = register_default_interceptors(Registry::new(), &mut media).unwrap();
    let api = APIBuilder::new().with_media_engine(media).with_interceptor_registry(registry).build();
    let config = RTCConfiguration {
        ice_servers: vec![RTCIceServer { urls: vec!["stun:stun.cloudflare.com:3478".to_owned()], ..Default::default() }],
        ..Default::default()
    };
    let pc = Arc::new(api.new_peer_connection(config).await.unwrap());
    let received = Arc::new(AtomicUsize::new(0));
    let sent = Arc::new(AtomicUsize::new(0));
    pc.on_peer_connection_state_change(Box::new(|state: RTCPeerConnectionState| {
        println!("connection: {state}");
        Box::pin(async {})
    }));
    Echo { pc, received, sent, voiced: Arc::new(AtomicUsize::new(0)) }
}

/// Adds the sending track and starts echoing whatever arrives on it.
async fn start_echo(echo: &Echo) {
    let track = Arc::new(TrackLocalStaticRTP::new(
        RTCRtpCodecCapability { mime_type: MIME_TYPE_OPUS.to_owned(), clock_rate: 48000, channels: 2, ..Default::default() },
        "audio".to_owned(),
        "seixo-call-check".to_owned(),
    ));
    let sender = echo.pc.add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>).await.unwrap();
    // RTCP has to be read for the interceptors (NACK, reports) to work.
    tokio::spawn(async move {
        let mut buf = vec![0u8; 1500];
        while sender.read(&mut buf).await.is_ok() {}
    });
    let (received, sent, voiced) = (Arc::clone(&echo.received), Arc::clone(&echo.sent), Arc::clone(&echo.voiced));
    echo.pc.on_track(Box::new(move |remote, _, _| {
        let (track, received, sent, voiced) =
            (Arc::clone(&track), Arc::clone(&received), Arc::clone(&sent), Arc::clone(&voiced));
        println!("receiving audio: {}", remote.codec().capability.mime_type);
        Box::pin(async move {
            while let Ok((packet, _)) = remote.read_rtp().await {
                received.fetch_add(1, Ordering::Relaxed);
                if packet.payload.len() > 20 {
                    voiced.fetch_add(1, Ordering::Relaxed);
                }
                if track.write_rtp(&packet).await.is_ok() {
                    sent.fetch_add(1, Ordering::Relaxed);
                }
            }
        })
    }));
}

async fn local_sdp(pc: &RTCPeerConnection) -> String {
    pc.local_description().await.unwrap().sdp
}

/// Offline check of what this phone answers to an offer like the iPhone's:
/// prints the answer's audio section.
fn selftest(rt: &tokio::runtime::Runtime) {
    rt.block_on(async {
        let caller = echo_connection().await;
        start_echo(&caller).await;
        let offer = caller.pc.create_offer(None).await.unwrap();
        let callee = echo_connection().await;
        start_echo(&callee).await;
        callee.pc.set_remote_description(offer).await.unwrap();
        let answer = callee.pc.create_answer(None).await.unwrap();
        for line in answer.sdp.lines().filter(|l| l.starts_with("m=") || l.starts_with("a=send") || l.starts_with("a=recv") || l.starts_with("a=ssrc") || l.starts_with("a=msid") || l.starts_with("a=inactive")) {
            println!("{line}");
        }
    });
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("selftest") {
        let rt = tokio::runtime::Runtime::new().unwrap();
        return selftest(&rt);
    }
    let dial = std::env::args().nth(1).as_deref() == Some("dial");
    let rt = tokio::runtime::Runtime::new().unwrap();
    let phone = new_phone();

    let mut raw = [0u8; 16];
    rand::rng().fill_bytes(&mut raw);
    let code = base64url(&raw);
    let hash = hex(&sha2::Sha256::digest(code.as_bytes()));
    phone.api.post("/rest/v1/rpc/create_invite", json!({ "code_hash": format!("\\x{hash}") }));
    // The web link opens whichever Seixo iOS picks, which is the App Store one
    // when both are installed; the dev scheme opens Seixo Dev for certain.
    println!("\nINVITE LINK (Seixo Dev): seixo-dev://invite#{code}");
    println!("INVITE LINK (web):       https://xeixos-corp.github.io/c/#{code}\n");
    println!("Accept it on the iPhone (Seixo Dev). Waiting up to an hour...");

    let deadline = Instant::now() + Duration::from_secs(3600);
    let (channel, peer) = loop {
        let mine = phone.api.get(&format!("/rest/v1/channel_members?select=channel_id&member_id=eq.{}", phone.me));
        if let Some(row) = mine.as_array().unwrap().first() {
            let channel = s(&row["channel_id"]);
            let members = phone.api.get(&format!("/rest/v1/channel_members?select=member_id&channel_id=eq.{channel}"));
            if let Some(peer) = members.as_array().unwrap().iter().map(|m| s(&m["member_id"])).find(|m| m != &phone.me) {
                break (channel, peer);
            }
        }
        if Instant::now() > deadline {
            println!("nobody accepted the invite");
            phone.delete();
            return;
        }
        std::thread::sleep(Duration::from_secs(2));
    };
    println!("conversation {channel} with {peer}");

    let echo = rt.block_on(echo_connection());
    let mut seen: Vec<String> = vec![];
    let mut call_id = String::new();
    let mut answered_at: Option<Instant> = None;

    if dial {
        // The iPhone started the conversation, so it has a session with this
        // phone; this phone makes its own from the iPhone's published keys,
        // as the app does when it writes first.
        phone.session_with(&peer);
        // Time to close Seixo Dev on the iPhone, so the call has to wake it.
        let wait: u64 = std::env::var("DIAL_DELAY").ok().and_then(|v| v.parse().ok()).unwrap_or(60);
        println!("Close Seixo Dev on the iPhone now (swipe it away). Calling in {wait} seconds...");
        std::thread::sleep(Duration::from_secs(wait));
        call_id = hex(&raw);
        let sdp = rt.block_on(async {
            start_echo(&echo).await;
            let offer = echo.pc.create_offer(None).await.unwrap();
            let mut gathered = echo.pc.gathering_complete_promise().await;
            echo.pc.set_local_description(offer).await.unwrap();
            let _ = gathered.recv().await;
            local_sdp(&echo.pc).await
        });
        let id = phone.send_call(&channel, &peer, json!({ "i": call_id, "y": "o", "s": sdp }));
        seen.push(id);
        // Wake the iPhone if Seixo Dev is closed, as the app does after an offer.
        match phone.api.req("POST", "/functions/v1/call-push").send_json(json!({ "channel_id": channel, "call_id": call_id })) {
            Ok(r) => println!("call push: {}", r.into_string().unwrap_or_default()),
            Err(e) => println!("call push failed: {e}"),
        }
        println!("calling the iPhone (call {call_id}). Answer it there.");
    } else {
        println!("Now call this phone from the conversation on the iPhone.");
    }

    let deadline = Instant::now() + Duration::from_secs(3600);
    let mut last_report = Instant::now();
    'outer: while Instant::now() < deadline {
        for row in phone.new_messages(&channel, &mut seen) {
            let Some(payload) = phone.open(&peer, &row) else { continue };
            let Some(call) = payload.get("v") else {
                println!("message: {}", payload["t"]);
                continue;
            };
            let kind = call["y"].as_str().unwrap_or("");
            println!("call signal: {kind} (call {})", call["i"]);
            match kind {
                "o" if !dial && call_id.is_empty() && std::env::var("DECLINE").is_ok() => {
                    // Let it ring for a few seconds (ringback on the iPhone), then
                    // decline (busy signal on the iPhone).
                    call_id = s(&call["i"]);
                    println!("ringing; declining in 8 seconds...");
                    std::thread::sleep(Duration::from_secs(8));
                    let id = phone.send_call(&channel, &peer, json!({ "i": call_id, "y": "r" }));
                    seen.push(id);
                    println!("declined");
                    std::thread::sleep(Duration::from_secs(5));
                    break 'outer;
                }
                "o" if !dial && call_id.is_empty() => {
                    call_id = s(&call["i"]);
                    let offer = s(&call["s"]);
                    let sdp = rt.block_on(async {
                        // The track must exist before the offer is applied: added
                        // after, webrtc-rs gives it a transceiver of its own and the
                        // answer says recvonly, so the iPhone never listens for it.
                        start_echo(&echo).await;
                        echo.pc.set_remote_description(RTCSessionDescription::offer(offer).unwrap()).await.unwrap();
                        let answer = echo.pc.create_answer(None).await.unwrap();
                        let mut gathered = echo.pc.gathering_complete_promise().await;
                        echo.pc.set_local_description(answer).await.unwrap();
                        let _ = gathered.recv().await;
                        local_sdp(&echo.pc).await
                    });
                    let id = phone.send_call(&channel, &peer, json!({ "i": call_id, "y": "a", "s": sdp }));
                    seen.push(id);
                    answered_at = Some(Instant::now());
                    println!("answered. Speak: you should hear yourself a moment later.");
                }
                "a" if dial && s(&call["i"]) == call_id => {
                    let answer = s(&call["s"]);
                    rt.block_on(echo.pc.set_remote_description(RTCSessionDescription::answer(answer).unwrap())).unwrap();
                    answered_at = Some(Instant::now());
                    println!("the iPhone answered. Speak: you should hear yourself a moment later.");
                }
                "r" | "b" => {
                    println!("the iPhone {}", if kind == "r" { "declined" } else { "was busy" });
                    break 'outer;
                }
                "e" => {
                    println!("the iPhone hung up (duration it reports: {}s)", call["d"]);
                    break 'outer;
                }
                _ => {}
            }
        }
        if answered_at.is_some() && last_report.elapsed() > Duration::from_secs(5) {
            last_report = Instant::now();
            println!(
                "audio packets: {} received from the iPhone ({} with speech), {} sent back",
                echo.received.load(Ordering::Relaxed),
                echo.voiced.load(Ordering::Relaxed),
                echo.sent.load(Ordering::Relaxed)
            );
        }
        std::thread::sleep(Duration::from_millis(700));
    }

    if let Some(at) = answered_at {
        println!(
            "call lasted about {}s here; {} packets received, {} echoed",
            at.elapsed().as_secs(),
            echo.received.load(Ordering::Relaxed),
            echo.sent.load(Ordering::Relaxed)
        );
    }
    rt.block_on(async {
        let _ = echo.pc.close().await;
    });
    std::thread::sleep(Duration::from_secs(5));
    phone.delete();
}
