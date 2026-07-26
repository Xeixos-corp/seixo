#!/usr/bin/env bash
# Builds packages/signal-native/rust for iOS (device + simulator) and packages
# the result as an .xcframework the Expo Module's podspec can vendor.
#
# Rust cannot cross-compile for iOS from Windows (no Apple SDK/linker
# available outside macOS), so this only ever runs on a Mac — in practice,
# an EAS Build macOS worker via the `eas-build-post-install` hook (see
# app/package.json and https://docs.expo.dev/build-reference/npm-hooks/).
#
# NOT YET RUN OR VERIFIED — written without access to a Mac. Expect to need
# to debug this on the first real EAS iOS build. Known soft spots:
#   - exact `protoc`/rustup install commands on the EAS macOS image (may
#     already be present, or brew names may differ)
#   - whether the simulator slice should target aarch64-apple-ios-sim only
#     (Apple Silicon EAS workers) or also x86_64-apple-ios-sim (Intel);
#     currently builds both and lipo's them together for the simulator slice
#   - the exact xcframework output path the podspec expects
#     (SignalNativeExpo.podspec's `vendored_frameworks`)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$SCRIPT_DIR"
IOS_MODULE_DIR="$SCRIPT_DIR/../../../app/modules/signal-native-expo/ios"
XCFRAMEWORK_OUT="$IOS_MODULE_DIR/SignalNative.xcframework"
HEADERS_DIR="$RUST_DIR/target/ios-headers"

echo "==> Ensuring Rust + iOS targets are installed"
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

echo "==> Ensuring protoc is installed (spqr dependency compiles .proto files at build time)"
if ! command -v protoc >/dev/null 2>&1; then
  brew install protobuf
fi

cd "$RUST_DIR"

echo "==> Building for device (aarch64-apple-ios)"
cargo build --release --target aarch64-apple-ios

echo "==> Building for simulator (aarch64-apple-ios-sim, x86_64-apple-ios)"
cargo build --release --target aarch64-apple-ios-sim
cargo build --release --target x86_64-apple-ios

echo "==> Creating a fat simulator library (arm64 + x86_64 simulator slices)"
mkdir -p target/ios-sim-fat
lipo -create \
  target/aarch64-apple-ios-sim/release/libsignal_native.a \
  target/x86_64-apple-ios/release/libsignal_native.a \
  -output target/ios-sim-fat/libsignal_native.a

echo "==> Preparing headers"
mkdir -p "$HEADERS_DIR"
cp "$IOS_MODULE_DIR/generated/signal_nativeFFI.h" "$HEADERS_DIR/"
cat > "$HEADERS_DIR/module.modulemap" <<'EOF'
module signal_nativeFFI {
    header "signal_nativeFFI.h"
    export *
}
EOF

echo "==> Assembling SignalNative.xcframework"
rm -rf "$XCFRAMEWORK_OUT"
xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/libsignal_native.a -headers "$HEADERS_DIR" \
  -library target/ios-sim-fat/libsignal_native.a -headers "$HEADERS_DIR" \
  -output "$XCFRAMEWORK_OUT"

echo "==> Done: $XCFRAMEWORK_OUT"
