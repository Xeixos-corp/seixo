// EAS Build lifecycle hook (see package.json "eas-build-post-install"):
// https://docs.expo.dev/build-reference/npm-hooks/
//
// Distinct from and complementary to eas-build-pre-install.js (which builds
// the Rust xcframework *before* `npm install`/`pod install`, see that
// file's comment for the hook-ordering bug it fixes). This one deliberately
// needs to run *after* `pod install`, since it patches a file that only
// exists once CocoaPods has actually vendored the `fmt` pod
// (ios/Pods/fmt/include/fmt/base.h) -- there'd be nothing to patch any
// earlier in the pipeline.
//
// What this fixes: Xcode 26's Clang enforces stricter C++20 `consteval`
// rules than the `fmt` 11.0.2 pod (pulled in transitively via RCT-Folly on
// this React Native version, 0.76.9) satisfies -- `pod install` succeeds,
// but the actual Xcode archive step fails with errors like:
//   call to consteval function 'fmt::basic_format_string<...>' is not a
//   constant expression
// Fixed upstream in fmt 12.1.0 (React Native >= 0.83.9 / Expo SDK 56), well
// past this project's SDK 52.
//
// A first attempt tried to fix this via a Podfile post_install override
// (an Expo config plugin setting CLANG_CXX_LANGUAGE_STANDARD=c++17 on just
// the 'fmt' pod target) -- `pod install` succeeded, but the error persisted
// unchanged at the Xcode-archive step. Most likely cause: React Native's
// own `react_native_post_install` helper (called from the same Podfile
// block) also normalizes C++ language-standard build settings across pods,
// and since it's very plausible that helper's own pass runs after or
// otherwise supersedes a plain per-target Ruby override, our setting never
// actually reached the compiler. Rather than fight over post_install
// ordering/precedence, this patches the actual header text instead, which
// has no such ambiguity: see
// https://bleepingswift.com/blog/fmt-consteval-error-xcode-26-4-react-native
// and docs/threat-model.md's "App Store submission needs a newer EAS build
// image" follow-up for the full story.
//
// The patch: flip fmt's own FMT_USE_CONSTEVAL feature-detection so it never
// enables the consteval code path on Apple's Clang specifically (detected
// via the `__apple_build_version__` macro, which Apple's clang forks define
// and upstream/GCC do not) -- `fmt` then falls back to its ordinary
// (working) `constexpr`-based format-string validation instead.
//
// **First version of this patch only touched one of TWO independent
// branches and didn't actually fix anything** -- the archive step failed
// with byte-for-byte the same errors even after it ran. fmt's real
// FMT_USE_CONSTEVAL logic (include/fmt/base.h) is an #if/#elif chain with
// two separate branches that each independently set it to 1:
//   #elif defined(__cpp_consteval)
//   #  define FMT_USE_CONSTEVAL 1
//   #elif FMT_GCC_VERSION >= 1002 || FMT_CLANG_VERSION >= 1101
//   #  define FMT_USE_CONSTEVAL 1
// The first patch excluded Apple's clang from the first branch correctly,
// but fmt's FMT_CLANG_VERSION macro (`__clang_major__ * 100 +
// __clang_minor__`) does NOT special-case Apple's clang the way
// FMT_USE_CONSTEVAL's own Apple-version check does elsewhere in the same
// chain -- it treats Apple clang's self-reported __clang_major__/__clang_minor__
// (which for Xcode 26 is comfortably >= 11.01) the same as upstream LLVM
// clang. So even with the first branch excluded, the second branch matched
// anyway and set FMT_USE_CONSTEVAL back to 1 regardless. Both branches now
// exclude Apple's clang.
//
// Remove this whole hook once the project upgrades past React Native
// 0.83.9 / Expo SDK 56, at which point fmt itself no longer needs it.

const fs = require('node:fs');
const path = require('node:path');

if (process.env.EAS_BUILD_PLATFORM !== 'ios') {
  process.exit(0);
}

const fmtBaseHeaderPath = path.join(__dirname, '..', 'ios', 'Pods', 'fmt', 'include', 'fmt', 'base.h');

if (!fs.existsSync(fmtBaseHeaderPath)) {
  console.log(
    `[eas-build-post-install] ${fmtBaseHeaderPath} not found -- nothing to patch (fmt pod not installed, or its layout changed).`
  );
  process.exit(0);
}

let contents = fs.readFileSync(fmtBaseHeaderPath, 'utf8');
const alreadyPatchedMarker = '!defined(__apple_build_version__)';

if (contents.includes(alreadyPatchedMarker)) {
  console.log('[eas-build-post-install] fmt/base.h already patched -- skipping.');
  process.exit(0);
}

// Both text targets confirmed verbatim against fmt 11.0.2's actual
// include/fmt/base.h source. If this project's fmt version ever changes,
// these strings may no longer match -- fail loudly rather than silently
// shipping a build with the unpatched (and known-broken, on Xcode 26)
// consteval path.
const patches = [
  {
    target: '#elif defined(__cpp_consteval)',
    replacement: '#elif defined(__cpp_consteval) && !defined(__apple_build_version__)',
  },
  {
    target: '#elif FMT_GCC_VERSION >= 1002 || FMT_CLANG_VERSION >= 1101',
    replacement:
      '#elif FMT_GCC_VERSION >= 1002 || (FMT_CLANG_VERSION >= 1101 && !defined(__apple_build_version__))',
  },
];

for (const { target } of patches) {
  if (!contents.includes(target)) {
    console.error(
      `[eas-build-post-install] Could not find "${target}" in fmt/base.h -- the fmt version bundled by this project may have changed. This patch (app/scripts/eas-build-post-install.js) needs updating to match, or may no longer be necessary at all (fmt >= 12.1.0 fixed this upstream) -- check before removing.`
    );
    process.exit(1);
  }
}

for (const { target, replacement } of patches) {
  contents = contents.replace(target, replacement);
}

// CocoaPods installs vendored pod sources read-only (to discourage editing
// them directly) -- confirmed by a real build failing here with EACCES.
// Make it writable just for this one write; no need to restore the
// original mode afterward, nothing else in the pipeline cares.
fs.chmodSync(fmtBaseHeaderPath, 0o644);
fs.writeFileSync(fmtBaseHeaderPath, contents);
console.log(
  '[eas-build-post-install] Patched fmt/base.h: disabled FMT_USE_CONSTEVAL on Apple Clang in both branches that could set it (Xcode 26 consteval-vs-fmt-11.0.2 incompatibility workaround).'
);
