export type V2Theme = 'light' | 'dark';

export const V2_THEME_STORAGE_KEY = 'id-business-v2-theme';

function isV2Theme(value: string | null): value is V2Theme {
  return value === 'light' || value === 'dark';
}

export function getPreferredV2Theme(): V2Theme {
  try {
    const storedTheme = window.localStorage.getItem(V2_THEME_STORAGE_KEY);
    if (isV2Theme(storedTheme)) return storedTheme;
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
  return 'light';
}

export function applyV2Theme(theme: V2Theme) {
  const root = document.documentElement;
  root.dataset.v2Theme = theme;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

export function initializeV2Theme() {
  const theme = getPreferredV2Theme();
  applyV2Theme(theme);
  return theme;
}

export function persistV2Theme(theme: V2Theme) {
  applyV2Theme(theme);
  try {
    window.localStorage.setItem(V2_THEME_STORAGE_KEY, theme);
  } catch {
    // The applied theme still works for this session when storage is unavailable.
  }
}
