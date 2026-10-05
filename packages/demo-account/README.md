# demo-account

The Signal Protocol half of the automatic demo account that App Review uses to
test Seixo on a single phone (why: `supabase/migrations/0032_demo_account.sql`).
The other half, the part that talks to the database, is the Edge Function
`supabase/functions/demo-account`.

It wraps the same `libsignal-protocol` revision as the app (`Cargo.lock` is a
copy of `packages/signal-native/rust/Cargo.lock`) and compiles to WebAssembly
for Deno. Every entry point takes the whole state as bytes and returns the new
state, because an Edge Function keeps nothing between calls.

## Test

The interop test runs the app's own Signal module (`signal_native`) as the
phone: session from the demo bundle, PreKey messages both before and after a
reply, the conversation carrying on, and a sealed photo opened by the app's
`open_attachment`.

```bash
cargo test --release
```

## Build

```bash
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir pkg --no-typescript target/wasm32-unknown-unknown/release/demo_account.wasm
```

Needs `rustup target add wasm32-unknown-unknown` and
`cargo install wasm-bindgen-cli --version <the wasm-bindgen version in Cargo.lock>`.

Then:

1. copy `pkg/demo_account.js` to `supabase/functions/demo-account/` and
   `pkg/demo_account_bg.wasm` to `supabase/functions/demo-account/assets/`;
2. commit and push, so the file is on GitHub;
3. in `supabase/functions/demo-account/index.ts`, set the commit in `ASSETS`
   and the new `WASM_SHA256` (`sha256sum`), and deploy the function.

The function fetches the WebAssembly from GitHub at that exact commit and
refuses it unless the hash matches.
