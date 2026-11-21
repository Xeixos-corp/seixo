import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import * as Localization from 'expo-localization';
import pt from './locales/pt.json';
import en from './locales/en.json';
import es from './locales/es.json';

// Auto-selects by device locale (no manual switcher in Settings: see
// docs/threat-model.md if that changes). Walks the phone's whole list of
// preferred languages and takes the first of the three supported, so an
// iPhone set to German with English second gets English. If none of the
// three is there at all, English: it used to be Portuguese, from when nearly
// everyone using Seixo spoke it, but people now arrive from many countries,
// and the App Store page they came from was already in English.
const SUPPORTED_LANGUAGES = ['pt', 'en', 'es'] as const;
const FALLBACK_LANGUAGE = 'en';

function resolveDeviceLanguage(): string {
  for (const locale of Localization.getLocales()) {
    const code = locale.languageCode;
    if (SUPPORTED_LANGUAGES.includes(code as (typeof SUPPORTED_LANGUAGES)[number])) return code as string;
  }
  return FALLBACK_LANGUAGE;
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
