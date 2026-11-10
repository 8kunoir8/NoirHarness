import { useCallback, useEffect, useState } from "react";

export type Theme = "paper" | "ink";

const STORAGE_KEY = "noir.theme";

export function readTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "ink" ? "ink" : "paper";
  } catch {
    return "paper";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Theme lives on `<html data-theme>`; CSS custom properties do the rest. */
export function useTheme(): [Theme, (theme: Theme) => void, () => void] {
  const [theme, setThemeState] = useState<Theme>(() => readTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A blocked storage write only costs persistence across launches.
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === "paper" ? "ink" : "paper");
  }, [setTheme, theme]);

  return [theme, setTheme, toggle];
}
