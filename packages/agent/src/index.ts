/**
 * Farsight agent（按需懒加载，独立 chunk）。
 *
 * 仅当 URL 带 `?debug=<隧道子域名>` 时由宿主 bootstrap 动态 import，平时不进首屏、
 * 正常用户永不下载。劫持 console / fetch / XHR / 全局报错，反连到你本地经 Cloudflare
 * 隧道暴露的中继（见 @farsight/cli 的 bin.mjs），你在 viewer 里实时看其控制台。
 *
 * 安全：本模块**不读取任何密钥**，只转发日志；eval 仅作用于加载它的那个用户自己的
 * 页面。门禁 = 隧道随机地址不可猜 + 中继只在联调期间存活。
 *
 * 零业务依赖：业务码解码 / 环境快照的业务补充均由宿主经 {@link FarsightOptions} 注入，
 * agent 本体不 import 任何具体项目的模块。
 */

import type { AgentMessage, ViewerCommand } from '@farsight/protocol';

/**
 * 宿主项目的可选适配注入——agent 保持零业务依赖的关键。
 */
export interface FarsightOptions {
  /**
   * 业务码 → 可读名。响应 JSON `{code,message}` 时用于把「HTTP 200 但 code≠0」标红。
   * `code===0` 也会经过本函数（由宿主自行返回如「成功」）。
   * 不传 → 只显示 HTTP status，不做业务码解码。
   */
  decodeBusinessCode?: (code: number) => string;
  /**
   * 环境快照的业务补充（如解析后的租户/主题——**密钥须自行剥离后再返回**）。
   * 不传 → 快照只含通用部分：storage / device / URL / CSS 变量。
   * 返回的键与通用快照同名时，以通用快照为准。
   */
  buildSnapshot?: () => Record<string, unknown>;
}

const TUNNEL_SUFFIX = '.trycloudflare.com';
const MAX_FIELD = 2048; // 单字段最大透传字节，超出截断（控制流量 + 保持 viewer 可读）
const MAX_RETRY = 5;
/** 每页签的稳定身份码持久化键（sessionStorage：每标签独立、刷新不变）。 */
const CODE_KEY = 'rd-agent-code';

// 线协议（agent 发出的消息）由 @farsight/protocol 单一维护，viewer 共用同一份。
let ws: WebSocket | null = null;
let retries = 0;
let installed = false;
/** 宿主注入的业务适配（startFarsight 时赋值；缺省全走通用路径）。 */
let options: FarsightOptions = {};
/** 本页签身份码：同一浏览器多标签下 UA/URL 全同，靠它在 viewer 里区分谁是谁。 */
let agentCode = '';
/** 用户已主动退出联调：一旦置位，断开后不再自动重连、emit 全静默。 */
let stopped = false;
/** 退避重连的定时器句柄（供主动退出时清除，避免断开后又被拉回）。 */
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 取（或首次生成）本页签的身份码。存 sessionStorage——它**每标签独立、且刷新后保留**，恰好
 * 表达「这一个页签」：同标签重连/刷新码不变（relay 据此 resume），新开标签则得新码。
 * 4 位、去掉易混字符（0/O/1/I/L），够区分一台机器上的几个调试页签。
 */
function ensureCode(): string {
  if (agentCode) return agentCode;
  try {
    const saved = sessionStorage.getItem(CODE_KEY);
    if (saved) return (agentCode = saved);
  } catch {
    /* 隐私模式：退化为内存内一次性码 */
  }
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = '';
  try {
    const r = new Uint8Array(4);
    crypto.getRandomValues(r);
    for (const n of r) c += ALPHABET[n % ALPHABET.length];
  } catch {
    for (let i = 0; i < 4; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  agentCode = c;
  try {
    sessionStorage.setItem(CODE_KEY, c);
  } catch {
    /* ignore */
  }
  return c;
}

/** 悬浮球停靠状态持久化键（sessionStorage：每标签独立，存 `{edge,top}`，刷新后停在原边原高）。 */
const POS_KEY = 'rd-agent-ball-pos';

/**
 * 主动退出联调（用户点悬浮球时）：断开连接、停录、清掉 URL 的 `debug` 参数、移除悬浮球。
 * 用 `history.replaceState` 改地址而非刷新——不打断用户当前操作；之后再手动刷新即彻底干净
 * （`?debug` 已不在，本模块不会再被宿主 bootstrap 加载）。置 `stopped` 后断开不再自动重连、emit 静默。
 */
function disconnectDebug(): void {
  stopped = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  stopMirror(); // 若在镜像，停止 rrweb 录制
  if (ws) {
    try {
      ws.onclose = null; // 摘掉重连回调再关，避免触发退避重连
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
  try {
    const u = new URL(location.href);
    u.searchParams.delete('debug');
    history.replaceState(history.state, '', u.toString());
  } catch {
    /* ignore */
  }
  document.getElementById('rd-agent-badge')?.remove();
  document.getElementById('rd-agent-style')?.remove();
}

/** 悬浮球边长 / 拖动判定阈值（px）。 */
const BALL = 46;
const DRAG_THRESHOLD = 4;

/**
 * 在页面放一枚**可拖拽、会吸附边缘的悬浮块**显示身份码（仅 ?debug 期间存在、正常用户永不加载）：
 *  · 圆角方块 + 角落脉冲红点（应用图标式角标），让被联调的用户**直观察觉**正在被实时查看；
 *  · 拖动避让视线，松手缓动**吸附到最近的左/右边缘**，停靠态贴墙侧削平圆角 + 半透明，hover 浮起；
 *  · **点击即主动退出联调**（{@link disconnectDebug}）；退出提示走球自带的原生 `title`。
 *    拖动与点击靠位移阈值区分。
 * 停靠状态（边 + 高）持久化到 sessionStorage，刷新后停在原处。
 */
function installBadge(code: string): void {
  try {
    if (document.getElementById('rd-agent-badge')) return;
    const style = document.createElement('style');
    style.id = 'rd-agent-style';
    // 基础过渡含 transform/opacity/圆角/阴影（不含 left/top → 拖动跟手 1:1；吸附时临时给 left/top 加过渡）。
    style.textContent =
      '@keyframes rd-ball-pulse{0%{box-shadow:0 0 0 0 rgba(244,63,94,.55)}' +
      '70%{box-shadow:0 0 0 6px rgba(244,63,94,0)}100%{box-shadow:0 0 0 0 rgba(244,63,94,0)}}' +
      `#rd-agent-badge{position:fixed;z-index:2147483647;width:${BALL}px;height:${BALL}px;` +
      'border-radius:14px;display:flex;align-items:center;justify-content:center;cursor:grab;' +
      'touch-action:none;user-select:none;-webkit-user-select:none;' +
      'font:700 13px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.04em;color:#8fd6ff;' +
      'background:rgba(15,17,21,.88);border:1px solid rgba(124,200,255,.4);' +
      'box-shadow:0 4px 14px rgba(0,0,0,.4);' +
      'transition:transform .24s cubic-bezier(.22,1,.36,1),opacity .24s,border-radius .24s,box-shadow .24s}' +
      '#rd-agent-badge:active{cursor:grabbing}' +
      '#rd-agent-badge .rd-code{transition:opacity .14s}' +
      // 停靠态：大部分隐入边缘、只露带红点的窄沿（不挡视线、不显示码）；hover 滑出全显 + 露码。
      '#rd-agent-badge[data-edge=left]{border-radius:0 13px 13px 0;opacity:.7;transform:translateX(-62%)}' +
      '#rd-agent-badge[data-edge=right]{border-radius:13px 0 0 13px;opacity:.7;transform:translateX(62%)}' +
      '#rd-agent-badge[data-edge=left] .rd-code,#rd-agent-badge[data-edge=right] .rd-code{opacity:0}' +
      '#rd-agent-badge[data-edge=left]:hover,#rd-agent-badge[data-edge=right]:hover{' +
      'opacity:1;transform:translateX(0);box-shadow:0 6px 20px rgba(0,0,0,.5)}' +
      '#rd-agent-badge:hover .rd-code{opacity:1}' +
      '#rd-agent-badge[data-edge=free]{border-radius:14px;opacity:1;transform:none}' +
      // 角标红点：随停靠侧落在朝向中心的外角（露在窄沿上、不被墙切）。
      '#rd-agent-badge .rd-dot{position:absolute;top:-3px;width:11px;height:11px;border-radius:50%;' +
      'background:#f43f5e;border:2px solid rgba(15,17,21,.88);animation:rd-ball-pulse 1.8s infinite}' +
      '#rd-agent-badge[data-edge=left] .rd-dot,#rd-agent-badge[data-edge=free] .rd-dot{right:-3px}' +
      '#rd-agent-badge[data-edge=right] .rd-dot{left:-3px}';

    const ball = document.createElement('div');
    ball.id = 'rd-agent-badge';
    ball.title = '远程联调中 · 拖动移开 · 点击停止';
    const codeEl = document.createElement('span');
    codeEl.className = 'rd-code';
    codeEl.textContent = code;
    const dot = document.createElement('div');
    dot.className = 'rd-dot';
    ball.append(codeEl, dot);

    const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));
    const leftFor = (e: 'left' | 'right') => (e === 'right' ? window.innerWidth - BALL : 0);

    // 还原停靠状态（边 + 高）；默认左边、靠下。
    let edge: 'left' | 'right' = 'left';
    let top = window.innerHeight - 80;
    try {
      const raw = sessionStorage.getItem(POS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p.edge === 'left' || p.edge === 'right') edge = p.edge;
        if (typeof p.top === 'number') top = p.top;
      }
    } catch {
      /* ignore */
    }

    let snapTimer: ReturnType<typeof setTimeout> | null = null;
    /** 落位到当前 edge + top；animate 时给 left/top 临时加缓动（吸附动画），结束后撤掉以保拖动 1:1。 */
    const applyEdge = (animate: boolean) => {
      top = clamp(top, window.innerHeight - BALL);
      if (animate) {
        ball.style.transition =
          'left .3s cubic-bezier(.22,1,.36,1),top .3s cubic-bezier(.22,1,.36,1),' +
          'transform .22s,opacity .22s,border-radius .22s,box-shadow .22s';
        if (snapTimer) clearTimeout(snapTimer);
        snapTimer = setTimeout(() => (ball.style.transition = ''), 340);
      }
      ball.dataset.edge = edge;
      ball.style.left = `${leftFor(edge)}px`;
      ball.style.top = `${top}px`;
    };

    // 初次落位：无动画（不闪）。
    ball.style.transition = 'none';
    applyEdge(false);
    requestAnimationFrame(() => (ball.style.transition = ''));
    window.addEventListener('resize', () => applyEdge(false)); // 视口变化保持贴边、夹回可见

    // 拖动/点击：位移 >阈值视为拖动；松手未拖动当点击 → 退出，否则吸附最近边缘并持久化。
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;
    let moved = false;
    let dragging = false;
    ball.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = false;
      sx = e.clientX;
      sy = e.clientY;
      ox = parseFloat(ball.style.left) || 0;
      oy = parseFloat(ball.style.top) || 0;
      ball.dataset.edge = 'free'; // 拖动恢复完整方块形态
      // 只给 transform/opacity 留过渡（从贴边窄沿平滑「滑出」），left/top 不过渡 → 跟手 1:1。
      ball.style.transition = 'transform .2s cubic-bezier(.22,1,.36,1),opacity .2s';
      try {
        ball.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      e.preventDefault();
    });
    ball.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) moved = true;
      ball.style.left = `${clamp(ox + dx, window.innerWidth - BALL)}px`;
      ball.style.top = `${clamp(oy + dy, window.innerHeight - BALL)}px`;
    });
    ball.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      try {
        ball.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (!moved) {
        disconnectDebug(); // 点击（未拖动）→ 主动退出
        return;
      }
      // 吸附到最近的左/右边缘，垂直位置保留。
      edge = parseFloat(ball.style.left) + BALL / 2 < window.innerWidth / 2 ? 'left' : 'right';
      top = parseFloat(ball.style.top) || 0;
      applyEdge(true);
      try {
        sessionStorage.setItem(POS_KEY, JSON.stringify({ edge, top }));
      } catch {
        /* ignore */
      }
    });

    const mount = () => {
      const root = document.body || document.documentElement;
      root.appendChild(style);
      root.appendChild(ball);
    };
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount, { once: true });
  } catch {
    /* 徽标失败不影响联调 */
  }
}

/** 截断超长字符串，标注被截掉的长度，控制隧道流量并保持 viewer 可读。 */
function clip(s: string, max = MAX_FIELD): string {
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max})` : s;
}

/** 安全序列化任意 console 参数（处理 Error / 循环引用 / 不可序列化值）。 */
function fmt(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(a, (_k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      if (typeof v === 'bigint') return `${v}n`;
      if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
      return v;
    });
  } catch {
    return String(a);
  }
}

/**
 * ② 从响应原文里抽出业务码并映射可读错误名。
 * 后端响应是 JSON `{code,message}` 时解析 code 并调宿主注入的 {@link FarsightOptions.decodeBusinessCode}，
 * 把「200 但 code=xxxx」这类业务失败一眼标出。须在截断前对原文解析。
 * 宿主未注入解码器 → 跳过业务码解码（viewer 只显示 HTTP status）。
 */
function decodeCode(rawText: string): { code: number; codeName: string } | undefined {
  const decode = options.decodeBusinessCode;
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

function emit(msg: AgentMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* 发送失败不影响宿主页面 */
    }
  }
}

function installConsoleHook(): void {
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

function installErrorHook(): void {
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

function installNetworkHook(): void {
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

/** 单个元素的简短 token：tag + id / [name] / 首两类 + 同类兄弟序号（撞脸时才补序号）。 */
function tokenOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`; // id 已足够唯一，直接返回
  const name = el.getAttribute('name');
  if (name) return `${tag}[name=${name}]`;
  const cls =
    typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
  let token = tag + cls;
  // 同一父级下「相同 tag + 相同 class」的兄弟超过一个时,补 :nth 以区分撞脸节点。
  const parent = el.parentElement;
  if (parent) {
    const twins = Array.from(parent.children).filter(
      (c) => c.tagName === el.tagName && c.className === el.className,
    );
    if (twins.length > 1) token += `:nth(${twins.indexOf(el) + 1})`;
  }
  return token;
}

/** 交互元素的可读标签：aria-label / 按钮·链接文本 / input 的 placeholder（绝不取 value）。 */
function labelOf(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return aria.trim();
  const tag = el.tagName.toLowerCase();
  if (tag === 'input')
    return el.getAttribute('placeholder')?.trim() || `[${el.getAttribute('type') || 'text'}]`;
  if (/^(button|a|summary|label|option)$/.test(tag) || el.getAttribute('role') === 'button') {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

/**
 * 为元素生成可读且尽量唯一的选择器（用于行为时间线 / DOM 审查标注）。
 * 光一个 tag/class 很容易撞脸,故附上祖先路径（向上至多取到带 id 的锚点、最多 3 级）
 * 与交互文本标签——基本能一眼定位是哪个节点。文本仅取 UI 标签,非用户输入内容。
 */
function selectorOf(el: EventTarget | null): string {
  if (!(el instanceof Element)) return '';
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && depth < 3; depth++) {
    parts.unshift(tokenOf(node));
    if (node.id) break; // 命中 id 锚点即停,上层路径无意义
    node = node.parentElement;
  }
  let sel = parts.join(' > ');
  const label = labelOf(el);
  if (label) sel += ` 「${clip(label, 40)}」`;
  return sel;
}

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
function buildSnapshot(): Record<string, unknown> {
  /** 业务补充（宿主自行剥离密钥）；抛错不影响通用快照，错误进 `snapshotError`。 */
  let extra: Record<string, unknown>;
  try {
    extra = options.buildSnapshot?.() ?? {};
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

/** ③ 用户行为时间线：点击 / 输入（打码）/ hash / 路由 / 可见性 / 在网。 */
function installEventHook(): void {
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

// ───────────────────────────── 实时镜像（rrweb 录制） ─────────────────────────────
// 仅当 viewer 显式下发 `mirror:on` 才懒加载 @rrweb/record（再一个独立子 chunk，常规联调都不下载），
// 把页面 DOM 的全量快照 + 增量流给 viewer 重建。隐私默认收紧：所有输入值打码、密码天然打码，
// 敏感区可加 `.rd-block`（整块屏蔽）/ `.rd-mask`（文本打码）。
let rrStop: (() => void) | null = null;
let rrTakeFull: ((isCheckout?: boolean) => void) | null = null;
let rrSeq = 0;
let mirroring = false;

async function startMirror(): Promise<void> {
  if (mirroring) return;
  mirroring = true;
  try {
    const { record } = await import('@rrweb/record');
    const stop = record({
      emit: (ev) => {
        // 仅看事件类型给 relay 划检查点：4=Meta（新检查点起点）、2=FullSnapshot、其余=增量。
        const kind = ev.type === 4 ? 'meta' : ev.type === 2 ? 'snap' : 'incr';
        emit({ t: 'rr', kind, seq: rrSeq++, ev });
      },
      maskAllInputs: true, // 绝不外发用户真实输入（与「行为时间线只记长度」同一克制）
      maskTextClass: 'rd-mask',
      blockClass: 'rd-block',
      recordCanvas: false, // canvas 像素录制开销大且本场景用不到
      checkoutEveryNms: 10000, // 每 10s 重拍全量快照：界定 relay 缓冲上限 + 让中途连入者立即重建
      // 滚动约 30fps（原 100=10fps,体感发顿）；鼠标采点 16ms + 每 16ms flush 一批 ≈ 60fps
      // （rrweb 默认 50ms 采点 / 500ms flush → 光标每 500ms 才换一次目标,被饿出瞬移感）。
      sampling: { scroll: 16, media: 400, input: 'last', mousemove: 16, mousemoveCallback: 16 },
    });
    rrStop = stop ?? null;
    rrTakeFull = record.takeFullSnapshot ?? null;
  } catch (err) {
    mirroring = false;
    emit({
      t: 'log',
      level: 'warn',
      args: [clip('远程联调：镜像启动失败 ' + (err instanceof Error ? err.message : String(err)))],
    });
  }
}

function stopMirror(): void {
  if (rrStop) {
    try {
      rrStop();
    } catch {
      /* ignore */
    }
  }
  rrStop = null;
  rrTakeFull = null;
  mirroring = false;
}

function handleCommand(text: string): void {
  let cmd: Partial<ViewerCommand & { code: string; on: boolean; id: number }>;
  try {
    cmd = JSON.parse(text);
  } catch {
    return;
  }
  if (cmd.t === 'eval' && typeof cmd.code === 'string') {
    try {
      // 间接 eval → 在全局作用域执行
      const value = (0, eval)(cmd.code);
      emit({ t: 'eval-result', ok: true, value: clip(fmt(value)) });
    } catch (err) {
      emit({
        t: 'eval-result',
        ok: false,
        value: clip(err instanceof Error ? err.stack || err.message : String(err)),
      });
    }
  } else if (cmd.t === 'snapshot') {
    try {
      emit({ t: 'snapshot', data: buildSnapshot() });
    } catch {
      /* 快照失败不影响宿主页面 */
    }
  } else if (cmd.t === 'mirror' && typeof cmd.on === 'boolean') {
    if (cmd.on) void startMirror();
    else stopMirror();
  } else if (cmd.t === 'ping' && typeof cmd.id === 'number') {
    emit({ t: 'pong', id: cmd.id }); // 即时回声,供 viewer 测往返延迟
  }
}

function connect(host: string): void {
  if (stopped) return; // 用户已主动退出：不再连
  const url = `wss://${host}/?role=agent&code=${encodeURIComponent(ensureCode())}`;
  try {
    ws = new WebSocket(url);
  } catch {
    return;
  }
  ws.onopen = () => {
    retries = 0;
    emit({ t: 'hello', ua: navigator.userAgent, url: location.href });
    // 重连后 relay 已清空旧会话历史/镜像缓冲：若正在镜像，立刻重拍一帧全量快照重新播种。
    if (mirroring && rrTakeFull) {
      try {
        rrTakeFull(true);
      } catch {
        /* ignore */
      }
    }
  };
  ws.onmessage = (e) => handleCommand(typeof e.data === 'string' ? e.data : '');
  ws.onclose = () => {
    ws = null;
    if (stopped) return; // 用户主动退出：不重连
    if (retries < MAX_RETRY) {
      retries += 1;
      retryTimer = setTimeout(() => connect(host), 1000 * retries); // 退避重连
    }
  };
  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
}

/**
 * 启动 Farsight agent。
 * @param token URL `?debug=` 的值：Cloudflare 隧道子域名（如 `able-modern-foo-bar`，
 *   自动补 `.trycloudflare.com`），或含点的完整主机名（如命名隧道 / 自定义域名）则原样使用。
 * @param opts 宿主项目的可选业务适配注入（见 {@link FarsightOptions}）；不传全走通用路径。
 */
export function startFarsight(token: string, opts?: FarsightOptions): void {
  if (installed || !token) return;
  installed = true;
  options = opts ?? {};
  const host = token.includes('.') ? token : `${token}${TUNNEL_SUFFIX}`;
  try {
    installConsoleHook();
    installErrorHook();
    installNetworkHook();
    installEventHook();
    installBadge(ensureCode()); // 角落码徽标，对应 viewer 下拉里的本页签
    connect(host);
  } catch {
    /* agent 任何异常都不得影响宿主页面 */
  }
}
