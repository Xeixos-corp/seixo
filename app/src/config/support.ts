// App Store Review Guideline 1.2 requires "published contact information so
// users can easily reach you" for any app with user-to-user communication —
// see docs/threat-model.md "App Store compliance" section. SettingsScreen.tsx
// and the report-abuse flow in ConversationScreen.tsx both hide their
// contact-dependent UI while this is null instead of shipping a fake
// address; now that a real one exists, both surface it.
export const SUPPORT_CONTACT_EMAIL: string | null = 'seixo.app@proton.me';

// App Store Guideline 5.1.1 and Google Play both require a hosted privacy
// policy URL, linked both in the app and in the respective developer
// console. Source content lives at docs/privacy-policy.md (this repo) and
// is published (PT/EN/ES) from the separate public Xeixos-corp/Seixo-Legal
// repo via GitHub Pages — kept separate so the app's own source stays
// private without needing a paid GitHub plan for Pages.
export const PRIVACY_POLICY_URL = 'https://xeixos-corp.github.io/Seixo-Legal/';
