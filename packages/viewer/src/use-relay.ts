/**
 * viewer 端的中继连接。封装 WebSocket 生命周期：连接 / 断线自动重连 / 手动重连 / 下发命令。
 * 收到的消息按协议类型分发进 {@link store}；命令以 {@link ViewerCommand} 类型化发出。
 *
 * 关键：被替换/卸载的旧 socket 会先**摘掉自己的 onclose**，自动重连只认「当前活跃 socket」
 * （`wsRef.current === ws`）。否则 StrictMode 的挂载→卸载→挂载、或任一次重连产生的“陈旧
 * socket”的迟到 onclose 会误触发重连，连环关掉好连接，形成每隔几秒断连重连的死循环。
 */
import { useCallback, useEffect, useRef } from 'react';
import type { IncomingMessage, ViewerCommand } from '@farview/protocol';
import { store } from './relay-store';

/** 自动重连间隔（ms）。 */
const RETRY_MS = 1500;

export interface Relay {
  /** 用给定地址（重新）连接；不传则用 store 里当前 relayUrl。 */
  connect: (url?: string) => void;
  /** 主动断开并停止自动重连（手动操作，非掉线）。 */
  disconnect: () => void;
  /** 向**当前被看 agent**下发一条命令（经 relay 路由）。 */
  send: (cmd: ViewerCommand) => boolean;
  /**
   * 切换收看的 agent（`id=null` 取消）。本地立即记录 watchedId，并通知 relay 过滤转发该 agent 的帧。
   * `resume=true`（刷新后恢复同一 agent）时 relay 跳过清屏/历史补发、仅补发镜像重建画面。
   */
  watch: (id: string | null, resume?: boolean) => void;
}

export function useRelay(): Relay {
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 关闭并彻底弃用一个 socket：摘掉 onclose，使其迟到的关闭事件不再触发任何重连。 */
  const discard = (ws: WebSocket | null) => {
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };

  const connect = useCallback((url?: string) => {
    const target = (url ?? store.getState().relayUrl).replace(/\/$/, '');
    if (url) store.setRelayUrl(url);
    if (retryRef.current) clearTimeout(retryRef.current);

    // 弃用旧连接（其 onclose 已摘除，不会反弹重连）
    discard(wsRef.current);
    wsRef.current = null;

    store.setStatus('connecting');
    store.setReconnectAt(null);
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${target}/?role=viewer`);
    } catch {
      store.setStatus('error');
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      store.setStatus('open');
      store.setReconnectAt(null);
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      try {
        store.ingest(JSON.parse(e.data) as IncomingMessage);
      } catch {
        /* 非 JSON / 损坏帧：忽略单条 */
      }
    };
    ws.onerror = () => store.setStatus('error');
    ws.onclose = () => {
      // 只有「当前活跃 socket」自发断开才重连；被替换/弃用的陈旧 socket 已摘除 onclose，不会到这
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      store.setStatus('closed');
      store.onDisconnect(); // 清名册/熄灭镜像（保留 watchedId 供重连后 resume）
      store.setReconnectAt(Date.now() + RETRY_MS);
      retryRef.current = setTimeout(() => connect(target), RETRY_MS);
    };
  }, []);

  /** 主动断开：摘除重连、关闭 socket、停在 closed 态（顶部栏可再「连接」）。 */
  const disconnect = useCallback(() => {
    if (retryRef.current) clearTimeout(retryRef.current);
    retryRef.current = null;
    discard(wsRef.current);
    wsRef.current = null;
    store.setReconnectAt(null);
    store.onDisconnect();
    store.setStatus('closed');
  }, []);

  const send = useCallback((cmd: ViewerCommand) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(cmd));
    return true;
  }, []);

  const watch = useCallback((id: string | null, resume?: boolean) => {
    store.setWatched(id); // 本地立即记住收看目标（agentOnline 随之重算 + 落盘）
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'watch', id, resume }));
  }, []);

  // 挂载即连一次本地中继（沿用原 viewer 行为）；卸载清理。
  useEffect(() => {
    connect();
    return () => {
      if (retryRef.current) clearTimeout(retryRef.current);
      discard(wsRef.current);
      wsRef.current = null;
    };
  }, [connect]);

  return { connect, disconnect, send, watch };
}
