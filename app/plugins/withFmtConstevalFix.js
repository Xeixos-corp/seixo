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

      const injected = `
    # --- ${FMT_FIX_MARKER}: see app/plugins/withFmtConstevalFix.js ---
    installer.pods_project.targets.each do |target|
      if target.name == 'fmt'
        target.build_configurations.each do |build_config|
          build_config.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'
        end
      end
    end
    # --- end ${FMT_FIX_MARKER} ---
`;

      // Insert right before the `end` that closes the Podfile's
      // `post_install do |installer| ... end` block, so this runs alongside
      // (not instead of) React Native's own required `react_native_post_install`
      // call already in that block -- a second, separate `post_install do`
      // block would silently replace the first one instead of both running.
      const postInstallRegex = /(post_install do \|installer\|[\s\S]*?)(\nend\b)/;
      if (!postInstallRegex.test(contents)) {
        throw new Error(
          `${FMT_FIX_MARKER}: could not find a "post_install do |installer|" block in the generated Podfile to patch.`
        );
      }
      contents = contents.replace(postInstallRegex, `$1\n${injected}$2`);

      fs.writeFileSync(podfilePath, contents);
      return config;
    },
  ]);
}

module.exports = withFmtConstevalFix;
