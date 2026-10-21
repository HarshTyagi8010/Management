export type ThemePreference = 'system' | 'light' | 'dark';

const ORDER: ThemePreference[] = ['system', 'light', 'dark'];

export function nextTheme(current: ThemePreference): ThemePreference {
  return ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? 'system';
}

/** Applies the preference to <html data-theme>; "system" follows prefers-color-scheme. Saved per user on the server. */
export function applyTheme(preference: ThemePreference, root: HTMLElement = document.documentElement): void {
  if (preference === 'system') delete root.dataset.theme;
  else root.dataset.theme = preference;
}
