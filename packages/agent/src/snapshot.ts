import { clip } from './format';
import { state } from './state';

/** 读取 :root 上声明的全部 CSS 自定义属性的运行时计算值（换肤 / 主题排障）。 */
function collectCssVars(): Record<string, string> {
  const names = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | undefined;
    try {
      rules = sheet.cssRules; // 跨域样式表读 cssRules 会抛，跳过
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule && /(:root|html)/.test(rule.selectorText)) {
        for (const prop of Array.from(rule.style)) {
          if (prop.startsWith('--')) names.add(prop);
        }
      }
    }
  }
  const cs = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const n of Array.from(names).sort()) out[n] = cs.getPropertyValue(n).trim();
  return out;
}

/** 收集某个 Storage 的全部键值（值原样透传，不截断——联调常需看完整 token/JSON）。 */
function dumpStorage(s: Storage): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k) out[k] = s.getItem(k) ?? '';
    }
  } catch {
    /* 隐私模式 / 禁用 storage */
  }
  return out;
}

/**
 * ① 构建环境快照 = 业务补充（宿主经 {@link FarsightOptions.buildSnapshot} 注入，如租户/主题）
 * + 通用部分（CSS 变量 + URL + 设备 + storage）。宿主未注入 → 只有通用部分。
 */
export function buildSnapshot(): Record<string, unknown> {
  /** 业务补充（宿主自行剥离密钥）；抛错不影响通用快照，错误进 `snapshotError`。 */
  let extra: Record<string, unknown>;
  try {
    extra = state.options.buildSnapshot?.() ?? {};
  } catch (e) {
    extra = { snapshotError: String(e) };
  }
  return {
    ...extra,
    cssVars: collectCssVars(),
    location: { href: location.href, referrer: document.referrer },
    device: {
      ua: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      online: navigator.onLine,
      viewport: `${window.innerWidth}×${window.innerHeight}`,
      screen: `${screen.width}×${screen.height}`,
      dpr: window.devicePixelRatio,
      visibility: document.visibilityState,
    },
    localStorage: dumpStorage(localStorage),
    sessionStorage: dumpStorage(sessionStorage),
    cookie: clip(document.cookie, 1024),
  };
}
