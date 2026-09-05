import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

/**
 * Catches render/lifecycle errors anywhere below it and shows what went
 * wrong instead of letting React unmount the whole tree.
 *
 * Why this exists: a production build has no red box. An uncaught error --
 * even something small, like a zustand selector returning a fresh array on
 * every render -- takes down the entire app and leaves a completely white
 * screen with no header, no text, nothing to report. That happened twice in
 * one week (see docs/threat-model.md) and cost a lot of guesswork, because
 * "white screen" is the same symptom for every possible cause.
 *
 * Deliberately self-contained: no theme, no i18n, no store access. Those are
 * exactly the things that might be broken when this renders, so it uses
 * hardcoded colours and English-only text. It is a diagnostic, not a
 * designed screen -- if a user ever sees it, something is already wrong.
 *
 * Mounted outside ThemeProvider in App.tsx so it also survives a failure in
 * the theme itself.
 */
type Props = { children: React.ReactNode };
type State = { error: Error | null; componentStack: string | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error('[ErrorBoundary] uncaught error', error, info.componentStack);
  }

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>Something broke</Text>
          <Text style={styles.subtitle}>
            The app hit an error it could not recover from. Please send this text to the developer.
          </Text>

          <Text style={styles.heading}>Error</Text>
          <Text style={styles.mono} selectable>
            {error.name}: {error.message}
          </Text>

          {error.stack ? (
            <>
              <Text style={styles.heading}>Stack</Text>
              <Text style={styles.mono} selectable>
                {error.stack}
              </Text>
            </>
          ) : null}

          {componentStack ? (
            <>
              <Text style={styles.heading}>Component stack</Text>
              <Text style={styles.mono} selectable>
                {componentStack}
              </Text>
            </>
          ) : null}
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F1EC' },
  content: { padding: 20, paddingTop: 64, gap: 8 },
  title: { fontSize: 20, fontWeight: '700', color: '#1F1E1D' },
  subtitle: { fontSize: 14, color: '#6B6660', marginBottom: 8, lineHeight: 20 },
  heading: { fontSize: 13, fontWeight: '700', color: '#CC785C', marginTop: 12 },
  mono: { fontSize: 11, color: '#1F1E1D', fontFamily: 'Courier' },
});
