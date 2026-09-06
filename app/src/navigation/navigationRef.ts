import { createNavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from './RootNavigator';

/**
 * Lets code outside the React tree drive navigation -- specifically, the
 * notification handler, which runs before (and independently of) any screen.
 */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();
