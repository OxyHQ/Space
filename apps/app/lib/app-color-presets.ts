import { Platform } from 'react-native';
import { APP_COLOR_PRESETS, type AppColorName } from '@oxyhq/bloom/theme';

function extractHue(hslVar: string): number {
  return parseInt(hslVar.split(' ')[0], 10);
}

function extractSat(hslVar: string): number {
  return parseInt(hslVar.split(' ')[1], 10);
}

/** Bloom's CSS vars extended with Oxy Space-specific vars (card, chart, sidebar-*). */
export function getAppColorVars(
  colorName: AppColorName,
  mode: 'light' | 'dark',
): Record<string, string> {
  const preset = APP_COLOR_PRESETS[colorName];
  const base = mode === 'light' ? preset.light : preset.dark;
  const hue = extractHue(base['--primary']);
  const sat = Math.min(extractSat(base['--primary']), 80);
  const isDark = mode === 'dark';

  return {
    ...base,
    '--card': isDark ? `${hue} 30% 10%` : '0 0% 100%',
    '--card-foreground': base['--foreground'],
    '--chart-1': `${hue} ${sat}% 85%`,
    '--chart-2': `${hue} ${sat}% 75%`,
    '--chart-3': `${hue} ${sat}% 65%`,
    '--chart-4': `${hue} ${sat}% ${isDark ? 55 : 75}%`,
    '--chart-5': `${hue} ${sat}% ${isDark ? 45 : 65}%`,
    '--content-area': isDark ? `${hue} 30% 8%` : base['--surface'],
    '--sidebar-foreground': base['--foreground'],
    '--sidebar-primary': base['--primary'],
    '--sidebar-primary-foreground': base['--primary-foreground'],
    '--sidebar-accent': isDark ? base['--sidebar'] : base['--accent'],
    '--sidebar-accent-foreground': isDark ? base['--foreground'] : base['--accent-foreground'],
    '--sidebar-border': base['--border'],
    '--sidebar-ring': base['--ring'],
  };
}

export function applyAppColorToDocument(
  colorName: AppColorName,
  resolvedMode: 'light' | 'dark',
) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;

  const vars = getAppColorVars(colorName, resolvedMode);
  Object.entries(vars).forEach(([key, value]) => {
    document.documentElement.style.setProperty(key, value);
  });
}
