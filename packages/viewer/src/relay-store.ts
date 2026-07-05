/**
 * viewer 的外部状态仓（useSyncExternalStore）。
 *
 * 为什么不用 useState：日志是高频流，每条都触发整树重渲染会卡。这里把数据放进一个
 * 不可变 state 对象，每次仅替换**受影响的那个数组引用**、其余切片保持同一引用；各面板用
 * {@link useSelector} 只订阅自己的切片，未变的切片不触发其组件重渲染。各通道为**带上限的
 * 环形缓冲**（{@link CAP}），防长时间联调内存无限涨。
 */
import { useSyncExternalStore } from 'react';
import type { AgentInfo, IncomingMessage, NetMessage, SnapshotMessage } from '@farview/protocol';

/** 各通道保留的最大条数（超出丢弃最旧的）。 */
export const CAP = 5000;

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/** 所有条目共有的客户端侧标注（协议消息本身不带时间戳，由 viewer 收到时打）。 */
interface Stamped {
  id: number;
  time: string;
}

export type ConsoleEntry = Stamped &
  (
    | { kind: 'log'; level: string; args: string[] }
    | { kind: 'err'; message: string; stack: string }
    | { kind: 'eval-in'; code: string }
    | { kind: 'eval-out'; ok: boolean; value: string }
    | { kind: 'sys'; message: string }
    | { kind: 'hello'; ua: string; url: string }
  );

export type NetEntry = Stamped & Omit<NetMessage, 't'>;
export type EventEntry = Stamped & { kind: string; detail: string };

/**
 * 「环境」通道条目：仅环境快照。DOM 检视已并入镜像面板、直接读回放 iframe（不再回程取节点），
 * 截图功能已移除，故此通道不再有 dom/node/shot 形态。
 */
export type InspectEntry = Stamped & { kind: 'snapshot'; data: SnapshotMessage['data'] };

/** 可分通道清空 / 计数的四个数据通道名。 */
export type Channel = 'console' | 'network' | 'events' | 'inspect';

/** 网络条目是否业务失败：HTTP 非 2xx/3xx,或业务码非 0。viewer 各处共用此判定。 */
export function isBadNet(e: { status: number; code?: number }): boolean {
  const bizBad = typeof e.code === 'number' && e.code !== 0;
  return !(e.status >= 200 && e.status < 400) || bizBad;
}

export interface State {
  status: ConnStatus;
  /** 当前**被收看**的 agent 是否在线（= watchedId 命中 agents 名册）。供 UI 判「agent 在线」。 */
  agentOnline: boolean;
  /** relay 下发的在线 agent 名册（多设备/多标签）；驱动顶部栏的 agent 切换下拉。 */
  agents: AgentInfo[];
  /** 当前收看的 agent id（null=未选）；各通道/镜像只反映这一个 agent。刷新后从持久化恢复。 */
  watchedId: string | null;
  relayUrl: string;
  /** 自动重连的目标时刻(epoch ms);null = 当前未在排队重连。供顶部栏显示倒计时。 */
  reconnectAt: number | null;
  hello: { ua: string; url: string } | null;
  console: ConsoleEntry[];
  network: NetEntry[];
  events: EventEntry[];
  inspect: InspectEntry[];
  /** 累计错误数(单调递增,清空才归零),供跨 tab「未读错误」红标计算。 */
  consoleErrors: number;
  networkErrors: number;
  /** 是否已有实时镜像在播（收到全量快照即 true,agent 离线/换会话归 false）。供 UI 显隐镜像画面。 */
  mirrorActive: boolean;
  /**
   * relay 自动建立的 Cloudflare 隧道子域名（= `?debug=` 的值）；relay 解析出地址后下发。
   * 供「生成调试链接」弹窗自动回填，免手动粘贴。未启用自动隧道/尚未解析出时为空串。
   */
  tunnelSub: string;
}

/** rrweb 事件（此处只取 type 做检查点判定,其余原样转交 Replayer,故宽松类型即可）。 */
export type RrwebEvent = { type: number; [k: string]: unknown };

const DEFAULT_RELAY = (() => {
  // vite dev（自身端口非中继）：直连本地中继；relay 伺服构建产物时取同源（自适配自定义 PORT）。
  if (import.meta.env.DEV || typeof location === 'undefined') return 'ws://localhost:9229';
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
})();

/** 持久化键:刷新后恢复本次会话的数据通道(sessionStorage,不跨标签页)。 */
const PERSIST_KEY = 'remote-debug-session';

/** 从 sessionStorage 恢复上次会话的数据(失败/缺失则空)。大块快照若超配额会在保存时被丢弃。 */
function restore(): Pick<State, Channel | 'consoleErrors' | 'networkErrors' | 'watchedId'> {
  const empty = {
    console: [],
    network: [],
    events: [],
    inspect: [],
    consoleErrors: 0,
    networkErrors: 0,
    watchedId: null,
  };
  try {
    const raw = sessionStorage.getItem(PERSIST_KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw);
    return {
      console: p.console ?? [],
      network: p.network ?? [],
      events: p.events ?? [],
      inspect: p.inspect ?? [],
      consoleErrors: p.consoleErrors ?? 0,
      networkErrors: p.networkErrors ?? 0,
      // 恢复上次收看的 agent：连上后若该 agent 仍在，relay 以 resume 模式补发镜像、保留本地通道。
      watchedId: typeof p.watchedId === 'string' ? p.watchedId : null,
    };
  } catch {
    return empty;
  }
}

const restored = restore();
// 恢复后续号从已有最大 id 继续,避免新条目与旧条目 id 冲突(虚拟列表按 id 取 key)。
const maxId = Math.max(
  -1,
  ...restored.console.map((e) => e.id),
  ...restored.network.map((e) => e.id),
  ...restored.events.map((e) => e.id),
  ...restored.inspect.map((e) => e.id),
);

let state: State = {
  status: 'idle',
  agentOnline: false,
  agents: [],
  relayUrl: DEFAULT_RELAY,
  reconnectAt: null,
  hello: null,
  mirrorActive: false,
  tunnelSub: '',
  ...restored,
};

/** 被收看的 agent 是否在名册里（agentOnline 的唯一真相，取代旧的 sys 文案猜测）。 */
const isWatchedOnline = (s: State): boolean =>
  !!s.watchedId && s.agents.some((a) => a.id === s.watchedId);

/**
 * 实时镜像缓冲：与上面带持久化的环形缓冲**完全分开**——镜像帧高频且大，既不入 sessionStorage、
 * 也不走 useSyncExternalStore 快照（否则每帧重渲染卡死）。这里就地维护一份「当前检查点」的事件序列
 * （收到 meta 即清空重来），供镜像面板**挂载时**播种 Replayer；之后的实时帧经 {@link mirrorListeners}
 * 直接喂给 Replayer.addEvent,不触发 React 重渲染。可变数组、不复制,降低高频流的 GC 压力。
 */
const mirrorBuffer: RrwebEvent[] = [];
const MIRROR_CAP = 2000;
const mirrorListeners = new Set<(ev: RrwebEvent) => void>();
/** pong 回声订阅（延迟探针）：与镜像帧一样走轻量 pub/sub,不进带持久化的 store 切片。 */
const pongListeners = new Set<(id: number) => void>();

/** 重置镜像态（换会话 / agent 离线）：清缓冲并熄灭 mirrorActive。 */
function resetMirror(): void {
  mirrorBuffer.length = 0;
  if (state.mirrorActive) set({ mirrorActive: false });
}

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** 防抖持久化:高频流不能每条都写盘。超配额(快照过大)则退化为不含 inspect 再存一次。 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const {
      console: c,
      network: n,
      events: ev,
      inspect: ins,
      consoleErrors,
      networkErrors,
      watchedId,
    } = state;
    try {
      sessionStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          console: c,
          network: n,
          events: ev,
          inspect: ins,
          consoleErrors,
          networkErrors,
          watchedId,
        }),
      );
    } catch {
      try {
        sessionStorage.setItem(
          PERSIST_KEY,
          JSON.stringify({
            console: c,
            network: n,
            events: ev,
            inspect: [],
            consoleErrors,
            networkErrors,
            watchedId,
          }),
        );
      } catch {
        /* 仍超配额:放弃本次持久化 */
      }
    }
  }, 600);
}

const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  emit();
  // 仅数据/计数/收看目标变化才值得落盘;纯连接态变化不触发。
  if (
    'console' in next ||
    'network' in next ||
    'events' in next ||
    'inspect' in next ||
    'watchedId' in next
  )
    schedulePersist();
};

let seq = maxId + 1;
const stamp = (): Stamped => {
  const d = new Date();
  return {
    id: seq++,
    time: d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0'),
  };
};
/** 追加到环形缓冲：超出 CAP 丢弃最旧的，返回新数组（新引用，触发该切片订阅者）。 */
const push = <T>(arr: T[], item: T): T[] => {
  const next = arr.length >= CAP ? arr.slice(arr.length - CAP + 1) : arr.slice();
  next.push(item);
  return next;
};

/** 把一条收到的协议消息路由进对应通道。 */
function ingest(msg: IncomingMessage): void {
  switch (msg.t) {
    case 'agents': {
      // relay 名册（agent 上下线/握手）：更新列表 + 据此重算被看 agent 是否在线。
      // 被看 agent 掉出名册 → 熄灭镜像（其画面已僵死）；App 侧会改看其它 agent。
      const next: State = { ...state, agents: msg.list };
      const online = isWatchedOnline(next);
      if (!online && state.mirrorActive) resetMirror();
      set({ agents: msg.list, agentOnline: online });
      break;
    }
    case 'reset':
      // 切换收看目标：清空各通道 + 镜像，随后 relay 补发新 agent 的历史/镜像。
      resetMirror();
      set({
        hello: null,
        console: [],
        network: [],
        events: [],
        inspect: [],
        consoleErrors: 0,
        networkErrors: 0,
      });
      break;
    case 'hello':
      // agent 握手：记录其 UA/URL 并落一条 console 行（在线与否由 agents 名册裁决，不在此置位）。
      set({
        hello: { ua: msg.ua, url: msg.url },
        console: push(state.console, { ...stamp(), kind: 'hello', ua: msg.ua, url: msg.url }),
      });
      break;
    case 'sys':
      // 通用系统提示，仅作 console 行展示（agent 上下线已由 agents 名册表达，不再据文案猜在线态）。
      set({ console: push(state.console, { ...stamp(), kind: 'sys', message: msg.message }) });
      break;
    case 'rr': {
      const ev = msg.ev as RrwebEvent;
      if (msg.kind === 'meta') mirrorBuffer.length = 0; // 新检查点：丢弃旧缓冲
      mirrorBuffer.push(ev);
      if (mirrorBuffer.length > MIRROR_CAP) mirrorBuffer.shift();
      for (const l of mirrorListeners) l(ev); // 实时喂给已挂载的 Replayer
      if (msg.kind === 'snap' && !state.mirrorActive) set({ mirrorActive: true });
      break;
    }
    case 'pong':
      for (const l of pongListeners) l(msg.id);
      break;
    case 'tunnel':
      // relay 解析出的自动隧道地址：存子域名供「生成调试链接」自动回填（仅变化时 set，避免无谓重渲染）。
      if (msg.sub !== state.tunnelSub) set({ tunnelSub: msg.sub });
      break;
    case 'log':
      set({
        console: push(state.console, { ...stamp(), kind: 'log', level: msg.level, args: msg.args }),
      });
      break;
    case 'err':
      set({
        console: push(state.console, {
          ...stamp(),
          kind: 'err',
          message: msg.message,
          stack: msg.stack,
        }),
        consoleErrors: state.consoleErrors + 1,
      });
      break;
    case 'eval-result':
      set({
        console: push(state.console, {
          ...stamp(),
          kind: 'eval-out',
          ok: msg.ok,
          value: msg.value,
        }),
        ...(msg.ok ? null : { consoleErrors: state.consoleErrors + 1 }),
      });
      break;
    case 'net': {
      const { t: _t, ...rest } = msg;
      set({
        network: push(state.network, { ...stamp(), ...rest }),
        ...(isBadNet(msg) ? { networkErrors: state.networkErrors + 1 } : null),
      });
      break;
    }
    case 'event':
      set({ events: push(state.events, { ...stamp(), kind: msg.kind, detail: msg.detail }) });
      break;
    case 'snapshot':
      set({ inspect: push(state.inspect, { ...stamp(), kind: 'snapshot', data: msg.data }) });
      break;
  }
}

export const store = {
  subscribe,
  getState: () => state,
  ingest,
  setStatus: (status: ConnStatus) => set({ status }),
  setRelayUrl: (relayUrl: string) => set({ relayUrl }),
  /** 记录当前收看的 agent id（由 useRelay.watch 调用）并据名册重算在线态。 */
  setWatched: (watchedId: string | null) =>
    set({ watchedId, agentOnline: isWatchedOnline({ ...state, watchedId }) }),
  /** 中继连接断开：清空名册、熄灭在线/镜像；保留 watchedId 以便重连后 resume 恢复。 */
  onDisconnect: () => {
    resetMirror();
    set({ agents: [], agentOnline: false });
  },
  setReconnectAt: (reconnectAt: number | null) => set({ reconnectAt }),
  /** 取当前检查点的镜像事件序列（镜像面板挂载时用来播种 Replayer）。 */
  getMirrorBuffer: (): RrwebEvent[] => mirrorBuffer,
  /** 订阅实时镜像帧（返回取消函数）；用于把新帧喂给已挂载的 Replayer.addEvent。 */
  subscribeMirror: (cb: (ev: RrwebEvent) => void): (() => void) => {
    mirrorListeners.add(cb);
    return () => mirrorListeners.delete(cb);
  },
  /** 本地熄灭镜像（用户点「停止」时立即生效,不等 agent 回包）。 */
  clearMirror: () => resetMirror(),
  /** 订阅 pong 回声（返回取消函数）；用于延迟探针配对收发算往返延迟。 */
  subscribePong: (cb: (id: number) => void): (() => void) => {
    pongListeners.add(cb);
    return () => pongListeners.delete(cb);
  },
  /** 回显 viewer 下发的 eval 命令（与原 viewer 的「⟶ code」一致）。 */
  pushEvalIn: (code: string) =>
    set({ console: push(state.console, { ...stamp(), kind: 'eval-in', code }) }),
  clear: () =>
    set({ console: [], network: [], events: [], inspect: [], consoleErrors: 0, networkErrors: 0 }),
  /** 清除环境历史快照、只保留最近一份：清掉积累的 diff 历史，但当前环境仍可见（不回空态）。 */
  clearInspectKeepLast: () =>
    set({ inspect: state.inspect.length ? [state.inspect[state.inspect.length - 1]] : [] }),
  /** 只清空某一个数据通道（连带归零其错误计数）。 */
  clearChannel: (ch: Channel) =>
    set({
      [ch]: [],
      ...(ch === 'console' ? { consoleErrors: 0 } : ch === 'network' ? { networkErrors: 0 } : null),
    } as Partial<State>),
};

/**
 * 订阅 state 的一个切片。selector **必须返回 state 里已有的引用**（如 `s.console`），
 * 不要在此返回新对象，否则 useSyncExternalStore 会因快照不稳定报错。派生/过滤放到组件里。
 */
export function useSelector<S>(selector: (s: State) => S): S {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}
