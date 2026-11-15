import { useEffect, useState } from 'react';

export type ColorScheme = 'light' | 'dark';

const query = '(prefers-color-scheme: dark)';

export function useColorScheme(): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>(() =>
    window.matchMedia(query).matches ? 'dark' : 'light',
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setScheme(e.matches ? 'dark' : 'light');
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return scheme;
}
