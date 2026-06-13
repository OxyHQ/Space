import { useColorScheme as useNativeWindColorScheme } from 'nativewind';
import { useCallback, useMemo } from 'react';
import { APP_COLOR_PRESETS, getPresetVars, useBloomTheme } from '@oxyhq/bloom/theme';
import type { ThemeMode } from '@oxyhq/bloom/theme';

/** Convert an HSL CSS variable value like "153 50% 5%" to "hsl(153, 50%, 5%)".
 *  Also handles alpha syntax "0 0% 100% / 10%" → "hsla(0, 0%, 100%, 0.1)". */
function hslVarToCSS(value: string): string {
  const parts = value.split('/').map((s) => s.trim());
  if (parts.length === 2) {
    const alpha = parseFloat(parts[1]) / 100;
    return `hsla(${parts[0].replace(/ /g, ', ')}, ${alpha})`;
  }
  return `hsl(${value.replace(/ /g, ', ')})`;
}

export function useColorScheme() {
  const { colorScheme: nwScheme } = useNativeWindColorScheme();
  const { mode, colorPreset, setMode } = useBloomTheme();

  const resolved: 'light' | 'dark' =
    mode === 'system' || mode === 'adaptive'
      ? (nwScheme ?? 'light')
      : mode;

  const setColorScheme = useCallback(
    (newMode: ThemeMode) => {
      setMode(newMode);
    },
    [setMode],
  );

  const colors = useMemo(() => {
    const v = getPresetVars(colorPreset, resolved);
    return {
      background: hslVarToCSS(v['--background']),
      foreground: hslVarToCSS(v['--foreground']),
      card: hslVarToCSS(v['--card']),
      sidebar: hslVarToCSS(v['--sidebar']),
      surface: hslVarToCSS(v['--surface']),
      muted: hslVarToCSS(v['--muted']),
      mutedForeground: hslVarToCSS(v['--muted-foreground']),
      border: hslVarToCSS(v['--border']),
      primary: APP_COLOR_PRESETS[colorPreset].hex,
      primaryForeground: hslVarToCSS(v['--primary-foreground']),
    };
  }, [resolved, colorPreset]);

  return {
    colorScheme: resolved,
    isDarkColorScheme: resolved === 'dark',
    setColorScheme,
    mode,
    colors,
  };
}
