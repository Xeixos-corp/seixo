# The Seixo app

Expo **SDK 52** (`expo` 52.0.49, `react-native` 0.76.9, Hermes, new
architecture on).

Read the docs for **this** version — <https://docs.expo.dev/versions/v52.0.0/>
— not "latest". Expo renames functions and changes their arguments between
SDKs, so guidance written for a later one compiles here and then fails on the
phone. The audio session is the clearest example: what `expo-audio` does to the
session, and in what order, is specific to this version, and the AirPods
microphone bug was exactly that.

When in doubt, the installed package in `node_modules` is the authority.

## What needs a new build, and what does not

Metro serves JavaScript to the development client already installed on the
phone, so **JS and translations are testable immediately** — no build.

A new build is needed for anything native:

- files in `assets/` that a plugin bundles (notification sounds, the launch
  image)
- `app.json` / `app.config.js` plugin configuration, permissions, entitlements
- the local modules in `modules/` and the Rust crate
- a new dependency with native code

`app.config.js` reads `app.json` and adjusts it per variant: `APP_VARIANT=development`
produces "Seixo Dev" with its own bundle identifier, URL scheme and App Group,
so it lives on the phone beside the real app instead of replacing it.

## Two traps

**Hermes stores accented strings as UTF-16.** Grepping a built bundle for
`"Definições"` finds nothing even when it is there. Search for an ASCII
fragment instead.

**`@expo/vector-icons` does not bundle here** — it needs `expo-font`, which
this app does not include. Icons are drawn with `react-native-svg`
(`src/components/icons.tsx`), which is already compiled in for the QR code.
