import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatCoordinates } from '../messaging/location';
import { MapPinIcon } from './icons';

type Props = {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  tint: string;
  onOpen: () => void;
  onLongPress: () => void;
};

/**
 * A location in the conversation: coordinates and a button, not a map.
 *
 * Drawing a map, or turning the coordinates into a street name, would make
 * this phone ask a map company about the place the moment the message
 * arrived, without anyone choosing to. Here nothing leaves the phone until
 * the person presses the button and picks a map.
 */
export function LocationMessage({ latitude, longitude, accuracyMeters, tint, onOpen, onLongPress }: Props) {
  const { t, i18n } = useTranslation();

  return (
    <Pressable onLongPress={onLongPress} delayLongPress={350} style={styles.wrapper}>
      <View style={styles.row}>
        <View style={[styles.icon, { borderColor: tint }]}>
          <MapPinIcon size={22} color={tint} />
        </View>
        <View style={styles.text}>
          <Text style={[styles.title, { color: tint }]}>{t('conversation.locationTitle')}</Text>
          <Text style={[styles.detail, { color: tint }]}>{formatCoordinates(latitude, longitude, i18n.language)}</Text>
          {accuracyMeters !== undefined ? (
            <Text style={[styles.detail, { color: tint }]}>
              {t('conversation.locationAccuracy', { meters: Math.round(accuracyMeters) })}
            </Text>
          ) : null}
        </View>
      </View>
      <Pressable
        onPress={onOpen}
        style={({ pressed }) => [styles.button, { borderColor: tint, opacity: pressed ? 0.6 : 1 }]}
        accessibilityRole="button"
      >
        <Text style={{ color: tint, fontWeight: '600' }}>{t('conversation.locationOpen')}</Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    minWidth: 210,
    maxWidth: 260,
    gap: 8,
    paddingVertical: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    gap: 1,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
  },
  detail: {
    fontSize: 12,
    opacity: 0.85,
  },
  button: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 6,
    alignItems: 'center',
  },
});
