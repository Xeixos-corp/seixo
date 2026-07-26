# signal-native-rn — ABANDONED

This package (a React Native TurboModule generated via
`uniffi-bindgen-react-native`) is **not used by the app**. It's kept here as
a record of what was tried, not as something to build on.

## Why abandoned

`uniffi-bindgen-react-native` generates a TurboModule assuming a vanilla
React Native CLI project (its own getting-started guide scaffolds via
`create-react-native-library`, never an Expo app). Our app is Expo-managed,
which uses its own autolinking system
(`expo-modules-autolinking`/`expo-autolinking-settings`) instead of the
plain React Native Community CLI's. In practice this caused the generated
CMake/Gradle glue to look for the compiled Rust static library in the wrong
location (`node_modules/react-native/ReactAndroid/cmake-utils/default-app-setup/.../jniLibs/...`,
which Expo's autolinking never populates) — a real, reproducible link failure,
not a version mismatch (we also independently found and fixed a genuine RN
0.86 incompatibility along the way, downgrading to RN 0.76.9 to match what
`uniffi-bindgen-react-native` v0.31.0-3 was actually tested against — that
fix alone was not enough). Trying `EXPO_USE_COMMUNITY_AUTOLINKING=1` (Expo's
own escape hatch back to vanilla RN CLI autolinking) was the next step but
adds its own dependency chain and was not pursued further once a cleaner
alternative was available.

## What replaced it

`app/modules/signal-native-expo` — a proper **Expo Module** (Expo's own,
well-supported native module system, not a third-party TurboModule
generator). It wraps the exact same Rust crate
(`packages/signal-native/rust`) via uniffi's **standard Kotlin/Swift
bindgen** (`cargo run --bin uniffi-bindgen -- generate --language kotlin`) —
the same binding style Mozilla and Signal itself use for production Android
apps — rather than uniffi's newer, less-proven React Native-specific JSI/C++
generator. No Rust code changed between the two attempts; only the
JS-native bridging layer did.
