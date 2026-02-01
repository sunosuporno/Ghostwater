import { useColorScheme as useRNColorScheme } from 'react-native';

/** Force dark UI (dark background, white chart) everywhere. Set to false to follow system light/dark. */
const FORCE_DARK_MODE = true;

export function useColorScheme(): 'light' | 'dark' | null {
  if (FORCE_DARK_MODE) return 'dark';
  return useRNColorScheme();
}
