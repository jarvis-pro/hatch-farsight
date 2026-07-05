// ───────────────────────────── 反连中继 + 命令处理 ─────────────────────────────
// 经 Cloudflare 隧道 WebSocket 反连本地中继，接收 viewer 下发的命令（eval / snapshot / mirror / ping），
// 断开自动退避重连（除非用户已主动退出）。

import type { ViewerCommand } from '@farsight/protocol';
import { clip, fmt } from './format';
import { ensureCode } from './identity';
import { startMirror, stopMirror } from './mirror';
import { buildSnapshot } from './snapshot';
import { emit, state } from './state';

const MAX_RETRY = 5;

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

export function connect(host: string): void {
  if (state.stopped) return; // 用户已主动退出：不再连
  const url = `wss://${host}/?role=agent&code=${encodeURIComponent(ensureCode())}`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    return;
  }
  state.ws = ws;
  ws.onopen = () => {
    state.retries = 0;
    emit({ t: 'hello', ua: navigator.userAgent, url: location.href });
    // 重连后 relay 已清空旧会话历史/镜像缓冲：若正在镜像，立刻重拍一帧全量快照重新播种。
    if (state.mirroring && state.rrTakeFull) {
      try {
        state.rrTakeFull(true);
      } catch {
        /* ignore */
      }
    }
  };
  ws.onmessage = (e) => handleCommand(typeof e.data === 'string' ? e.data : '');
  ws.onclose = () => {
    state.ws = null;
    if (state.stopped) return; // 用户主动退出：不重连
    if (state.retries < MAX_RETRY) {
      state.retries += 1;
      state.retryTimer = setTimeout(() => connect(host), 1000 * state.retries); // 退避重连
    }
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
}
