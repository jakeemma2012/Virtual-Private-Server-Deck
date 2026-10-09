'use client';

import { ReactNode, createContext, useContext, useEffect, useState } from 'react';
import { DEFAULT_THEME } from './theme.config';

const COOKIE_NAME = 'active_theme';

function setThemeCookie(theme: string) {
  if (typeof window === 'undefined') return;
  document.cookie = `${COOKIE_NAME}=${theme}; path=/; max-age=31536000; SameSite=Lax; ${window.location.protocol === 'https:' ? 'Secure;' : ''}`;
}

type ThemeContextType = {
  activeTheme: string;
  setActiveTheme: (theme: string) => void;
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ActiveThemeProvider({
  children,
  initialTheme
}: {
  children: ReactNode;
  initialTheme?: string;
}) {
  const themeToUse = initialTheme || DEFAULT_THEME;
  const [activeTheme, setActiveTheme] = useState<string>(themeToUse);

  // Không được truyền initialTheme (static export: server không đọc cookie hộ)
  // thì tự đọc ở client. Script inline trong <head> đã đặt data-theme trước khi
  // vẽ nên không có flash; chỗ này chỉ để state của React khớp với DOM.
  useEffect(() => {
    if (initialTheme) return;
    const fromDom = document.documentElement.getAttribute('data-theme');
    if (fromDom && fromDom !== activeTheme) setActiveTheme(fromDom);
    // Chỉ chạy một lần lúc mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    if (currentTheme !== activeTheme) {
      setThemeCookie(activeTheme);
      document.documentElement.removeAttribute('data-theme');
      Array.from(document.body.classList)
        .filter((className) => className.startsWith('theme-'))
        .forEach((className) => {
          document.body.classList.remove(className);
        });
      if (activeTheme) {
        document.documentElement.setAttribute('data-theme', activeTheme);
      }
    } else {
      setThemeCookie(activeTheme);
    }
  }, [activeTheme]);

  return (
    <ThemeContext.Provider value={{ activeTheme, setActiveTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useThemeConfig() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useThemeConfig must be used within an ActiveThemeProvider');
  }
  return context;
}
