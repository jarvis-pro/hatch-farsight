// ───────────────────────────── 角落悬浮球（身份码 + 退出联调） ─────────────────────────────

import { stopMirror } from './mirror';
import { state } from './state';

/** 悬浮球停靠状态持久化键（sessionStorage：每标签独立，存 `{edge,top}`，刷新后停在原边原高）。 */
const POS_KEY = 'rd-agent-ball-pos';

/** 悬浮球边长 / 拖动判定阈值（px）。 */
const BALL = 46;
const DRAG_THRESHOLD = 4;

/**
 * 主动退出联调（用户点悬浮球时）：断开连接、停录、清掉 URL 的 `debug` 参数、移除悬浮球。
 * 用 `history.replaceState` 改地址而非刷新——不打断用户当前操作；之后再手动刷新即彻底干净
 * （`?debug` 已不在，本模块不会再被宿主 bootstrap 加载）。置 `stopped` 后断开不再自动重连、emit 静默。
 */
export function disconnectDebug(): void {
  state.stopped = true;
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  stopMirror(); // 若在镜像，停止 rrweb 录制
  if (state.ws) {
    try {
      state.ws.onclose = null; // 摘掉重连回调再关，避免触发退避重连
      state.ws.close();
    } catch {
      /* ignore */
    }
    state.ws = null;
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

/**
 * 在页面放一枚**可拖拽、会吸附边缘的悬浮块**显示身份码（仅 ?debug 期间存在、正常用户永不加载）：
 *  · 圆角方块 + 角落脉冲红点（应用图标式角标），让被联调的用户**直观察觉**正在被实时查看；
 *  · 拖动避让视线，松手缓动**吸附到最近的左/右边缘**，停靠态贴墙侧削平圆角 + 半透明，hover 浮起；
 *  · **点击即主动退出联调**（{@link disconnectDebug}）；退出提示走球自带的原生 `title`。
 *    拖动与点击靠位移阈值区分。
 * 停靠状态（边 + 高）持久化到 sessionStorage，刷新后停在原处。
 */
export function installBadge(code: string): void {
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
