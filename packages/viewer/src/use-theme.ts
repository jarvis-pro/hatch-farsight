/**
 * 明暗主题：三态（浅/深/跟随系统），偏好存 localStorage，默认跟随系统。
 * 从原 ThemeToggle 抽出为 hook，供命令面板下发主题命令。
 */
import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const KEY = 'farsight-theme';
const mql = () => window.matchMedia('(prefers-color-scheme: dark)');

function isDark(theme: Theme) {
  return theme === 'dark' || (theme === 'system' && mql().matches);
}
function apply(theme: Theme) {
  document.documentElement.classList.toggle('dark', isDark(theme));
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void } {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(KEY) as Theme | null) ?? 'system',
  );
  useEffect(() => {
    apply(theme);
    localStorage.setItem(KEY, theme);
    if (theme !== 'system') return;
    const m = mql();
    const onChange = () => apply('system');
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, [theme]);
  return { theme, setTheme };
}
