import React, { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { useTermsStore } from '../store/termsStore';
import { PRIVACY_POLICY_URL, TERMS_URL, TERMS_VERSION } from '../config/support';

const RULE_KEYS = ['terms.rule1', 'terms.rule2', 'terms.rule3', 'terms.rule4', 'terms.rule5'] as const;

/**
 * Asks for the terms of use once, before anything else in the app is reachable.
 *
 * App Store guideline 1.2 is about apps where people send each other content,
 * and review routinely asks chat apps to have users agree to terms stating
 * there is no tolerance for objectionable content or abusive users. The terms
 * are also where the app says plainly what end-to-end encryption means for
 * moderation: nobody can read the messages, so blocking and reporting are the
 * tools, and they are listed here rather than discovered later.
 *
 * Existing users see this once too, after updating. That is intended: an
 * account made before the terms existed never agreed to them.
 */
export function TermsGate({ children }: { children: React.ReactNode }) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const acceptedVersion = useTermsStore((state) => state.acceptedVersion);
  const accept = useTermsStore((state) => state.accept);

  // The stored acceptance loads asynchronously. Until it has, render nothing
  // rather than the terms: otherwise everyone who already accepted would see
  // them flash on every launch. The splash overlay covers this moment.
  const [hydrated, setHydrated] = useState(() => useTermsStore.persist.hasHydrated());
  useEffect(() => {
    if (hydrated) return;
    const unsubscribe = useTermsStore.persist.onFinishHydration(() => setHydrated(true));
    // Covers hydration finishing between the initial check and subscribing.
    if (useTermsStore.persist.hasHydrated()) setHydrated(true);
    return unsubscribe;
  }, [hydrated]);

  if (!hydrated) return null;
  if (acceptedVersion === TERMS_VERSION) return <>{children}</>;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.brand, { color: colors.accent }]}>Seixo</Text>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{t('terms.title')}</Text>
        <Text style={[styles.intro, { color: colors.textSecondary }]}>{t('terms.intro')}</Text>

        <View style={styles.rules}>
          {RULE_KEYS.map((key) => (
            <View key={key} style={styles.ruleRow}>
              <View style={[styles.bullet, { backgroundColor: colors.accent }]} />
              <Text style={[styles.ruleText, { color: colors.textPrimary }]}>{t(key)}</Text>
            </View>
          ))}
        </View>

        <Pressable onPress={() => Linking.openURL(TERMS_URL)} hitSlop={8}>
          <Text style={[styles.link, { color: colors.accent }]}>{t('terms.readFull')}</Text>
        </Pressable>
        <Pressable onPress={() => Linking.openURL(PRIVACY_POLICY_URL)} hitSlop={8}>
          <Text style={[styles.link, { color: colors.accent }]}>{t('terms.readPrivacy')}</Text>
        </Pressable>
      </ScrollView>

      <Pressable
        onPress={() => accept(TERMS_VERSION)}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: pressed ? colors.accentPressed : colors.accent },
        ]}
      >
        <Text style={[styles.buttonText, { color: colors.onAccent }]}>{t('terms.accept')}</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 24, paddingBottom: 16 },
  content: { paddingTop: 32, paddingBottom: 24, gap: 14 },
  brand: { fontSize: 15, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase' },
  title: { fontSize: 26, fontWeight: '700' },
  intro: { fontSize: 15, lineHeight: 22 },
  rules: { gap: 12, marginVertical: 6 },
  ruleRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  bullet: { width: 6, height: 6, borderRadius: 3, marginTop: 8 },
  ruleText: { flex: 1, fontSize: 15, lineHeight: 22 },
  link: { fontSize: 15, fontWeight: '600', paddingVertical: 4 },
  button: { borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
