const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Xcode 26's Clang enforces stricter C++20 `consteval` rules than the `fmt`
// 11.0.2 pod (bundled transitively via RCT-Folly by this React Native
// version, 0.76.9) satisfies -- the build fails with errors like:
//   call to consteval function 'fmt::basic_format_string<...>' is not a
//   constant expression
// This is fixed upstream in fmt 12.1.0, which only ships with React Native
// >= 0.83.9 / Expo SDK 56 -- well past this project's current SDK 52.
// See docs/threat-model.md's "App Store submission needs a newer EAS build
// image" follow-up for the full story (this surfaced right after pinning
// the production build image to Xcode 26 to satisfy Apple's April 2026
// App Store submission requirement).
//
// Workaround (community-confirmed, e.g.
// https://bleepingswift.com/blog/fmt-consteval-error-xcode-26-4-react-native):
// compile *only* the `fmt` pod against the C++17 standard, where `consteval`
// doesn't exist as a language feature at all, so `fmt` falls back to its
// (working) `constexpr` code path. Every other pod stays on this project's
// normal C++ standard -- this isn't a project-wide downgrade.
//
// `ios/Podfile` is generated fresh by `expo prebuild` on every build (it's
// gitignored, not checked in -- see app/.gitignore), so this can't be a
// one-off manual edit; it has to be a config plugin that runs every time.
//
// Remove this plugin once the project upgrades past React Native 0.83.9 /
// Expo SDK 56, at which point `fmt` itself no longer needs the workaround.
const FMT_FIX_MARKER = 'withFmtConstevalFix';

function withFmtConstevalFix(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf8');

      if (contents.includes(FMT_FIX_MARKER)) {
        // Already patched -- the mod pipeline can run more than once in some
        // flows, and this must stay idempotent rather than duplicate the
        // injected block.
        return config;
      }

      const injected =
        `    # --- ${FMT_FIX_MARKER}: see app/plugins/withFmtConstevalFix.js ---\n` +
        `    installer.pods_project.targets.each do |target|\n` +
        `      if target.name == 'fmt'\n` +
        `        target.build_configurations.each do |build_config|\n` +
        `          build_config.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'\n` +
        `        end\n` +
        `      end\n` +
        `    end\n` +
        `    # --- end ${FMT_FIX_MARKER} ---\n`;

      // Insert immediately *after* the line that opens the Podfile's
      // `post_install do |installer|` block, rather than trying to locate
      // where the block *closes*. Locating the closing `end` via regex is
      // unreliable -- the real block contains its own nested `do ... end`
      // constructs (react_native_post_install's internals,
      // target_installation_results iteration, etc.), and a naive
      // non-greedy match stops at the first `end` it finds, which can be
      // one of those nested ones. That's exactly what happened on the
      // first attempt: the injected code landed *after* the block had
      // already closed, so `installer` was out of scope ("undefined local
      // variable or method `installer'"). Inserting right after the
      // opening line has no such ambiguity: it's unconditionally inside
      // the block, statement order doesn't matter here since this is
      // independent of react_native_post_install's own work.
      const postInstallOpenRegex = /(post_install do \|installer\|\r?\n)/;
      if (!postInstallOpenRegex.test(contents)) {
        throw new Error(
          `${FMT_FIX_MARKER}: could not find a "post_install do |installer|" block in the generated Podfile to patch.`
        );
      }
      contents = contents.replace(postInstallOpenRegex, `$1${injected}`);

      fs.writeFileSync(podfilePath, contents);
      return config;
    },
  ]);
}

module.exports = withFmtConstevalFix;
