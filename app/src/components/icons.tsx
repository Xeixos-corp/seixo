import React from 'react';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

type IconProps = { size: number; color: string };

/**
 * The small icons the conversation list needs, drawn with react-native-svg.
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

/** A bell with a line through it: this conversation does not notify. */
export function BellOffIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <Path d="M13.7 21a2 2 0 0 1-3.4 0" />
      <Line x1={3.5} y1={3.5} x2={20.5} y2={20.5} />
    </Svg>
  );
}

/** The chevron that means "this row opens another screen". */
export function ChevronIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M9 5l7 7-7 7" />
    </Svg>
  );
}

/** A bin: throw this away, as with a recording that should not be sent. */
export function TrashIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M4 7h16" />
      <Path d="M9 7V4.5h6V7" />
      <Path d="M6 7l1 13h10l1-13" />
      <Line x1={10} y1={11} x2={10} y2={16.5} />
      <Line x1={14} y1={11} x2={14} y2={16.5} />
    </Svg>
  );
}

/** A sheet with a folded corner: a document, either to send or in a message. */
export function FileIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <Path d="M14 3v5h5" />
    </Svg>
  );
}

/** A paperclip: attach something, a photo or a file. */
export function PaperclipIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20.5 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
    </Svg>
  );
}

/** A clipboard: put in what was copied. */
export function PasteIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Rect x={5} y={4.5} width={14} height={16.5} rx={2} />
      <Rect x={9} y={3} width={6} height={3.5} rx={1} />
    </Svg>
  );
}

/** A framed landscape: an image, either to send or in a message. */
export function ImageIcon({ size, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Rect x={3} y={4} width={18} height={16} rx={2.5} />
      <Circle cx={9} cy={9.5} r={1.6} />
      <Path d="M21 16l-5.2-5.2a1.4 1.4 0 0 0-2 0L5 19.5" />
    </Svg>
  );
}
