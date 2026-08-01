import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import * as Localization from 'expo-localization';
import pt from './locales/pt.json';
import en from './locales/en.json';
import es from './locales/es.json';

// Auto-selects by device locale (no manual switcher in Settings — see
// docs/threat-model.md if that changes). Falls back to Portuguese for any
// language not in the three supported (pt/en/es), rather than defaulting to
// English, since this app's primary audience is Portuguese-speaking.
const SUPPORTED_LANGUAGES = ['pt', 'en', 'es'] as const;
const FALLBACK_LANGUAGE = 'pt';

function resolveDeviceLanguage(): string {
  const deviceLanguageCode = Localization.getLocales()[0]?.languageCode;
  return SUPPORTED_LANGUAGES.includes(deviceLanguageCode as (typeof SUPPORTED_LANGUAGES)[number])
    ? (deviceLanguageCode as string)
    : FALLBACK_LANGUAGE;
}

i18n.use(initReactI18next).init({
  resources: {
    pt: { translation: pt },
    en: { translation: en },
    es: { translation: es },
  },
  lng: resolveDeviceLanguage(),
  fallbackLng: FALLBACK_LANGUAGE,
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
