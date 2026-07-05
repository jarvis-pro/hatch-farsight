/**
 * 页面探针：劫持 console / fetch / XHR / 全局报错 / 用户行为，全部经 emit 转发给 viewer。
 */

import { clip, fmt } from './format';
import { selectorOf } from './selector';
import { emit, state } from './state';

/**
 * ② 从响应原文里抽出业务码并映射可读错误名。
 * 后端响应是 JSON `{code,message}` 时解析 code 并调宿主注入的 {@link FarsightOptions.decodeBusinessCode}，
 * 把「200 但 code=xxxx」这类业务失败一眼标出。须在截断前对原文解析。
 * 宿主未注入解码器 → 跳过业务码解码（viewer 只显示 HTTP status）。
 */
function decodeCode(rawText: string): { code: number; codeName: string } | undefined {
  const decode = state.options.decodeBusinessCode;
  if (!decode) return undefined;
  try {
    const j = JSON.parse(rawText);
    if (j && typeof j.code === 'number') {
      return { code: j.code, codeName: decode(j.code) };
    }
  } catch {
    /* 非 JSON / 已截断：忽略 */
  }
  return undefined;
}

export function installConsoleHook(): void {
  const levels: Array<'log' | 'info' | 'warn' | 'error' | 'debug'> = [
    'log',
    'info',
    'warn',
    'error',
    'debug',
  ];
  for (const level of levels) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      emit({ t: 'log', level, args: args.map((a) => clip(fmt(a))) });
      orig(...args);
    };
  }
}

export function installErrorHook(): void {
  window.addEventListener('error', (e) => {
    emit({ t: 'err', message: clip(String(e.message)), stack: clip(e.error?.stack || '') });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    emit({
      t: 'err',
      message: clip(r instanceof Error ? r.message : String(r)),
      stack: clip(r instanceof Error ? r.stack || '' : ''),
    });
  });
}

export function installNetworkHook(): void {
  // fetch
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const start = performance.now();
    const method = (
      init?.method || (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    try {
      const res = await origFetch(input, init);
      let snippet = '';
      let decoded: { code: number; codeName: string } | undefined;
      try {
        const raw = await res.clone().text();
        decoded = decodeCode(raw); // 截断前解析业务码
        snippet = clip(raw);
      } catch {
        /* 流/二进制响应跳过 */
      }
      emit({
        t: 'net',
        method,
        url: clip(url, 512),
        status: res.status,
        ms: Math.round(performance.now() - start),
        resSnippet: snippet,
        ...decoded,
      });
      return res;
    } catch (err) {
      emit({
        t: 'net',
        method,
        url: clip(url, 512),
        status: 0,
        ms: Math.round(performance.now() - start),
        resSnippet: clip(err instanceof Error ? err.message : String(err)),
      });
      throw err;
    }
  };

  // XHR
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    (this as unknown as { __rd?: { method: string; url: string; start: number } }).__rd = {
      method: String(method).toUpperCase(),
      url: typeof url === 'string' ? url : url.href,
      start: 0,
    };
    // @ts-expect-error 透传原始可变参数
    return origOpen.call(this, method, url, ...rest);
  };
  XHR.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = (this as unknown as { __rd?: { method: string; url: string; start: number } })
      .__rd;
    if (meta) {
      meta.start = performance.now();
      this.addEventListener('loadend', () => {
        let snippet = '';
        let decoded: { code: number; codeName: string } | undefined;
        try {
          const raw = typeof this.responseText === 'string' ? this.responseText : '';
          decoded = decodeCode(raw); // 截断前解析业务码
          snippet = clip(raw);
        } catch {
          /* responseType 非文本时跳过 */
        }
        emit({
          t: 'net',
          method: meta.method,
          url: clip(meta.url, 512),
          status: this.status,
          ms: Math.round(performance.now() - meta.start),
          resSnippet: snippet,
          ...decoded,
        });
      });
    }
    return origSend.call(this, body ?? null);
  };
}

/** ③ 用户行为时间线：点击 / 输入（打码）/ hash / 路由 / 可见性 / 在网。 */
export function installEventHook(): void {
  const ev = (kind: string, detail: string) => emit({ t: 'event', kind, detail });
  window.addEventListener('click', (e) => ev('click', selectorOf(e.target)), {
    capture: true,
    passive: true,
  });
  // 输入只记字段与长度，绝不外发用户实际输入内容
  const onInput = (e: Event) => {
    const t = e.target;
    const len =
      t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement ? t.value.length : 0;
    ev('input', `${selectorOf(t)} (len ${len})`);
  };
  window.addEventListener('change', onInput, { capture: true, passive: true });
  window.addEventListener('hashchange', () => ev('hash', location.hash), { passive: true });
  window.addEventListener('popstate', () => ev('route', location.href), { passive: true });
  window.addEventListener('visibilitychange', () => ev('visibility', document.visibilityState), {
    passive: true,
  });
  window.addEventListener('online', () => ev('network', 'online'), { passive: true });
  window.addEventListener('offline', () => ev('network', 'offline'), { passive: true });
}
