import React from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useAppTheme } from '../theme/ThemeProvider';
import { ChevronIcon } from './icons';

/**
 * The settings screen's two building blocks: a titled group, and the rows
 * inside it.
 *
 * They exist because the screen had grown to eight sections in which a switch,
 * a row of chips, a coloured link, an outlined button and a filled red button
 * all meant "something you can tap" -- five treatments for one idea, none of
 * them inside anything. Grouped rows on a card is what an iPhone user already
 * knows how to read, and it makes the screen scannable without anyone having
 * to read a word of it.
 *
 * Dividers are drawn between rows rather than on them, so the first and last
 * row of a group never end up with a stray line against the card's edge.
 */
export function SettingsGroup({
  title,
  footer,
  children,
}: {
  /** Shown above the card. Omitted for a group that needs no name. */
  title?: string;
  /** Explanatory text under the card, in the manner of iOS settings. */
  footer?: string;
  children: React.ReactNode;
}) {
  const { colors } = useAppTheme();
  const rows = React.Children.toArray(children).filter(Boolean);

  return (
    <View style={styles.group}>
      {title ? (
        <Text style={[styles.groupTitle, { color: colors.textSecondary }]}>{title}</Text>
      ) : null}
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {rows.map((row, index) => (
          <View key={index}>
            {index > 0 ? (
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
            ) : null}
            {row}
          </View>
        ))}
      </View>
      {footer ? (
        <Text style={[styles.footer, { color: colors.textSecondary }]}>{footer}</Text>
      ) : null}
    </View>
  );
}

type RowProps = {
  label: string;
  /** Second line, for a setting whose consequences are not obvious. */
  hint?: string;
  /** The current choice, shown on the right of a row that opens something. */
  value?: string;
  onPress?: () => void;
  /** Shows the chevron that says "this opens another screen". */
  opensScreen?: boolean;
  /** Turns the label red. For actions that cannot be undone. */
  danger?: boolean;
  disabled?: boolean;
  /** A switch on the right. Mutually exclusive with onPress. */
  toggle?: { value: boolean; onValueChange: (value: boolean) => void; disabled?: boolean };
};

export function SettingsRow({
  label,
  hint,
  value,
  onPress,
  opensScreen,
  danger,
  disabled,
  toggle,
}: RowProps) {
  const { colors } = useAppTheme();
  const labelColor = danger ? colors.danger : colors.textPrimary;

  const body = (
    <View style={[styles.row, disabled ? styles.rowDisabled : null]}>
      <View style={styles.rowText}>
        <Text style={[styles.label, { color: labelColor }]}>{label}</Text>
        {hint ? <Text style={[styles.hint, { color: colors.textSecondary }]}>{hint}</Text> : null}
      </View>
      {value ? <Text style={[styles.value, { color: colors.textSecondary }]}>{value}</Text> : null}
      {toggle ? (
        <Switch
          value={toggle.value}
          onValueChange={toggle.onValueChange}
          disabled={toggle.disabled}
        />
      ) : null}
      {opensScreen ? <ChevronIcon size={16} color={colors.textSecondary} /> : null}
    </View>
  );

  // A row with only a switch is not itself pressable: tapping the label of a
  // switch row does nothing on iOS, and pretending otherwise would make the
  // rest of the screen's press feedback mean less.
  if (!onPress) return body;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => (pressed ? { backgroundColor: colors.surfaceAlt } : null)}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: {
    marginTop: 26,
  },
  groupTitle: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    // Indented so the dividers read as separating rows of one list rather than
    // cutting the card into pieces.
    marginLeft: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
    minHeight: 50,
  },
  rowDisabled: {
    opacity: 0.5,
  },
  rowText: {
    flex: 1,
    gap: 3,
  },
  label: {
    fontSize: 15,
  },
  hint: {
    fontSize: 12,
    lineHeight: 16,
  },
  value: {
    fontSize: 15,
  },
  footer: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 7,
    marginLeft: 4,
  },
});
