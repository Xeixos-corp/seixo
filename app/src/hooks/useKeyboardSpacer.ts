import { useEffect, useRef } from 'react';
import { Animated, Dimensions, Easing, Keyboard, Platform, type KeyboardEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * How much empty space to leave under the content so the keyboard does not
 * cover it -- animated in step with the keyboard itself.
 *
 * This exists because KeyboardAvoidingView does not keep step, and it is worth
 * recording why rather than leaving it as "the built-in one felt laggy". Its
 * handler awaits an asynchronous measurement of the view before it knows where
 * to move to, so the keyboard is already travelling by the time it decides;
 * it then calls LayoutAnimation.configureNext *after* the state update that
 * causes the layout change, rather than before; and LayoutAnimation is
 * unreliable under the new architecture, which this app has enabled. The
 * result is a bar that starts late and catches up.
 *
 * iOS announces a keyboard move before making it, and the announcement carries
 * both the duration and the curve. Starting an animation with those same
 * numbers, in the same moment, is what makes the bar look attached to the
 * keyboard rather than chasing it.
 *
 * `keyboardWillChangeFrame` rather than willShow/willHide: it is the one event
 * that also covers the keyboard changing height in place -- switching to an
 * emoji keyboard, the autocorrect strip appearing -- which the other two miss.
 *
 * Android gets the same spacing without the animation: it has no "will change"
 * event to animate from, and this app has never shipped there (see AGENTS.md).
 */
export function useKeyboardSpacer(): Animated.Value {
  const insets = useSafeAreaInsets();
  const spacer = useRef(new Animated.Value(0)).current;
  // Read inside the listener, which is registered once: without this the
  // listener would close over the first inset value it ever saw.
  const bottomInset = useRef(insets.bottom);
  bottomInset.current = insets.bottom;

  useEffect(() => {
    const animateTo = (height: number, duration: number) => {
      // The container already reserves the home indicator's space, so only the
      // part of the keyboard beyond it needs covering -- otherwise the bar
      // floats that much too high while the keyboard is up.
      const target = Math.max(0, height - bottomInset.current);
      Animated.timing(spacer, {
        toValue: target,
        duration: duration > 10 ? duration : 10,
        // UIKit's keyboard curve is not one of the standard easings; this
        // bezier is the usual approximation of it, and at 250ms the
        // difference is not visible.
        easing: Easing.bezier(0.17, 0.59, 0.25, 1),
        // paddingBottom/height cannot be driven on the native thread. The
        // timing still matches, which is what was wrong before.
        useNativeDriver: false,
      }).start();
    };

    if (Platform.OS === 'ios') {
      const subscription = Keyboard.addListener('keyboardWillChangeFrame', (event: KeyboardEvent) => {
        // A floating or split iPad keyboard covers nothing at the bottom.
        const { screenY } = event.endCoordinates;
        const covered = Math.max(0, Dimensions.get('window').height - screenY);
        animateTo(covered, event.duration);
      });
      return () => subscription.remove();
    }

    const show = Keyboard.addListener('keyboardDidShow', (event: KeyboardEvent) => {
      animateTo(event.endCoordinates.height, 0);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => animateTo(0, 0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [spacer]);

  return spacer;
}
