//! Standalone uniffi-bindgen CLI for this crate, used to generate standard
//! Kotlin/Swift bindings (packages/signal-native-expo) — not to be confused
//! with uniffi-bindgen-react-native's own bundled `ubrn` CLI, which generates
//! a different (RN TurboModule) output and is no longer used by this project.

fn main() {
    uniffi::uniffi_bindgen_main()
}
