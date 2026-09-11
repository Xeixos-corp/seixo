import React from 'react';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

type IconProps = { size: number; color: string };

/**
 * The two small icons the conversation list needs, drawn with react-native-svg.
 *
 * Not @expo/vector-icons: that library loads its glyphs through expo-font, a
 * native module this app does not include, so it failed to bundle -- and
 * adding expo-font would have meant a new build for two icons.
 * react-native-svg is already compiled in (it draws the QR code).
 */

export function MicIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round">
      <Rect x={9} y={3} width={6} height={11} rx={3} />
      <Path d="M5 11a7 7 0 0 0 14 0" />
      <Line x1={12} y1={18} x2={12} y2={21} />
    </Svg>
  );
}

export function PeopleIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round">
      <Circle cx={9} cy={8} r={3.5} />
      <Path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <Circle cx={17} cy={9} r={2.5} />
      <Path d="M16 14.2c2.9 0.4 5 2.8 5 5.8" />
    </Svg>
  );
}
