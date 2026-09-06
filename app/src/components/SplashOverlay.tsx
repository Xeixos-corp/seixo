import React, { useEffect, useRef, useState } from 'react';
import { Animated, Image, StyleSheet, Text } from 'react-native';

// Must match the expo-splash-screen plugin's backgroundColor and imageWidth in
// app.json. The native screen and this one are meant to look like a single
// screen, so any drift between the two shows up as a jump at launch.
const BACKGROUND = '#EBEBEB';
const IMAGE_SIZE = 200;

/**
 * The launch screen, with the app's name under its icon.
 *
 * Two layers are needed because the native splash screen is a static image and
 * cannot draw text. The native one appears instantly, before any JavaScript
 * has run; this one takes over with the same icon in the same place, and adds
 * the name. Because the background colour and icon size match, the handover is
 * invisible -- the name simply appears.
 *
 * Self-contained on purpose: no theme, no translations, no stores. It is on
 * screen precisely when none of those are guaranteed to be ready yet, and the
 * app name is a proper noun that is not translated anyway.
 */
export function SplashOverlay({ visible }: { visible: boolean }) {
  const opacity = useRef(new Animated.Value(1)).current;
  // Kept mounted through the fade, then removed entirely so it can never
  // intercept a touch meant for the app underneath.
  const [mounted, setMounted] = useState(true);

  useEffect(() => {
    if (visible) return;
    Animated.timing(opacity, {
      toValue: 0,
      duration: 260,
      useNativeDriver: true,
    }).start(() => setMounted(false));
  }, [visible, opacity]);

  if (!mounted) return null;

  return (
    <Animated.View
      style={[styles.container, { opacity }]}
      // Swallows taps while it is up, and lets them through once it starts
      // fading -- a tap during the fade is aimed at the app, not at this.
      pointerEvents={visible ? 'auto' : 'none'}
    >
      <Image
        source={require('../../assets/splash-icon.png')}
        style={styles.image}
        resizeMode="contain"
      />
      <Text style={styles.name}>Seixo</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: BACKGROUND,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: IMAGE_SIZE,
    height: IMAGE_SIZE,
  },
  // Absolutely positioned rather than laid out under the image: a name in
  // normal flow would push the icon up off the centre, and that offset from
  // where the native splash drew it would read as a jump.
  name: {
    position: 'absolute',
    top: '50%',
    marginTop: IMAGE_SIZE / 2 + 24,
    fontSize: 26,
    fontWeight: '600',
    letterSpacing: 1,
    color: '#1A1A1A',
  },
});
