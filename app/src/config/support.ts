// App Store Review Guideline 1.2 requires "published contact information so
// users can easily reach you" for any app with user-to-user communication.
// Not set yet — needs a real support email before this app can be submitted
// for review (see docs/threat-model.md "App Store compliance" section).
// SettingsScreen.tsx and the report-abuse flow in ConversationScreen.tsx
// both hide their contact-dependent UI while this is null instead of
// shipping a fake/placeholder address.
export const SUPPORT_CONTACT_EMAIL: string | null = null;
