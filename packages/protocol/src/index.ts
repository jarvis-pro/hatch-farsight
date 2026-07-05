/**
 * 远程联调线协议——agent（生产懒加载模块）与 viewer（dev-only DevTools）共享的**单一真相源**。
 *
 * 历史上协议形状在两处各写一遍（agent 的 `Outbound` 类型 + viewer 里临时拼的 JS），易漂移。
 * 此模块是纯类型、零运行时（编译后被擦除），双方都从这里 import，改一处即对齐两端。
 *
 * 流向：agent(s) —(WebSocket)→ relay —(转发)→ viewer(s)；viewer —(WebSocket)→ relay → 被看 agent。
 * relay 不解析业务消息，仅做多路复用/转发/历史补发；由 relay **自行注入**的是 `agents`（在线名册）
 * 与 `reset`（切换 agent 时清屏标记），外加历史上的 `sys`（系统提示，现已基本由名册取代）。
 *
 * **多 agent**：同一隧道可同时接入多个落地页（多设备/多标签）。relay 给每条 agent 连接分配一个
 * 短 id，并为每个 agent 单独维护日志历史 + 镜像检查点。每个 viewer 一次只「收看」(`watch`) 一个
 * agent——relay 只把被看 agent 的帧转发给它，切换时先发 `reset` 再补发该 agent 的历史/镜像。
 * 名册（{@link AgentsMessage}）随 agent 上下线广播给所有 viewer，驱动其 agent 切换下拉。
 */

/** agent 上线握手：回传其 UA 与当前页 URL。 */
export interface HelloMessage {
  t: 'hello';
  ua: string;
  url: string;
}

/** 一条被劫持的 console 输出（已安全序列化 + 截断）。 */
export interface LogMessage {
  t: 'log';
  level: string;
  args: string[];
}

/** 一次网络请求（fetch/XHR）。`code`/`codeName` 为后端业务码（HTTP 200 但 code≠0 即业务失败）。 */
export interface NetMessage {
  t: 'net';
  method: string;
  url: string;
  status: number;
  ms: number;
  resSnippet: string;
  code?: number;
  codeName?: string;
}

/** 未捕获错误 / unhandledrejection。 */
export interface ErrMessage {
  t: 'err';
  message: string;
  stack: string;
}

/** viewer 下发的 eval 的执行结果。 */
export interface EvalResultMessage {
  t: 'eval-result';
  ok: boolean;
  value: string;
}

/** 环境快照：解析后的租户/主题/storage/设备等（密钥已剥离）。 */
export interface SnapshotMessage {
  t: 'snapshot';
  data: Record<string, unknown>;
}

/** 用户行为时间线的一条（点击/输入/hash/路由/可见性/在网）。 */
export interface EventMessage {
  t: 'event';
  kind: string;
  detail: string;
}

/**
 * 实时镜像的一帧（rrweb）：把用户页面 DOM 的全量快照/增量流给 viewer 重建回放。
 * viewer 端用 rrweb `Replayer` 实时重建当前画面；DOM 检视（盒模型/样式/结构树/诊断）由 viewer
 * **直接读重建出的回放 iframe**完成,零回程、不触碰用户页面（故协议不再有 dom/node/screenshot）。
 *
 * `kind` 是给 relay/viewer 划「检查点」用的（无需解析业务内容）：
 *  - `meta`：rrweb Meta 事件（type 4），每个新全量快照的起点——收到即**重置**镜像缓冲；
 *  - `snap`：rrweb FullSnapshot（type 2），完整 DOM 快照；
 *  - `incr`：其余（增量变更/滚动/输入/加载等），追加在当前检查点之后。
 *
 * agent 用 `checkoutEveryNms` 周期性重拍全量快照,故缓冲有界、且中途连入的 viewer 能立即重建画面。
 * `ev` 是 rrweb 的 `eventWithTime`；此处刻意存为 `unknown` 以保协议包**零依赖**,viewer 原样喂给 Replayer。
 */
export interface MirrorMessage {
  t: 'rr';
  kind: 'meta' | 'snap' | 'incr';
  /** agent 侧单调递增序号（viewer 可据此察觉丢帧；正常无需用到）。 */
  seq: number;
  ev: unknown;
}

/**
 * agent 对 viewer `ping` 的即时回声：viewer 据收发时差测**往返延迟**（经 relay+隧道+agent 整条链路,
 * 不依赖两端时钟同步,故是镜像延迟指标的可靠口径）。`id` 原样带回供 viewer 配对。
 */
export interface PongMessage {
  t: 'pong';
  id: number;
}

/**
 * agent → viewer 的全部消息（agent 的 `emit` 只发这些）。
 * 注意：`sys` 不在此列——它由 relay 注入，见 {@link IncomingMessage}。
 */
export type AgentMessage =
  | HelloMessage
  | LogMessage
  | NetMessage
  | ErrMessage
  | EvalResultMessage
  | SnapshotMessage
  | EventMessage
  | MirrorMessage
  | PongMessage;

/** relay 自行注入的系统提示（少量通用提示）；agent 上下线现由 {@link AgentsMessage} 表达。 */
export interface SysMessage {
  t: 'sys';
  message: string;
}

/** 在线名册里的单个 agent：身份码（id）+ 其握手回传的 UA/URL（未握手前为空串）。 */
export interface AgentInfo {
  /**
   * agent 身份码：优先取 agent 自报的**每页签稳定码**（`?code=`，存 sessionStorage，刷新/重连不变），
   * 无码的旧 agent 由 relay 回退分配 `aN`。viewer 据此 `watch`，并显示给用户区分同 url 的多个页签。
   */
  id: string;
  ua: string;
  url: string;
}

/**
 * 在线 agent 名册（relay 注入，随 agent 上下线/握手广播给所有 viewer）。
 * viewer 据此渲染 agent 切换下拉；列表为空即当前无 agent 接入。
 */
export interface AgentsMessage {
  t: 'agents';
  list: AgentInfo[];
}

/**
 * 切换收看标记（relay 注入）：viewer 切到另一个 agent 时，relay 先发本条令其**清空各通道**，
 * 紧接着补发被看 agent 的历史 + 镜像检查点。`resume`（刷新后恢复同一 agent）则不发本条、保留既有数据。
 */
export interface ResetMessage {
  t: 'reset';
  id: string;
}

/**
 * relay 注入：自动建立的 Cloudflare 隧道地址（relay 启动时拉起隧道并解析得到）。viewer 据此
 * **自动回填**「生成调试链接」弹窗的隧道地址，无需手动粘贴子域名。viewer 连上即下发一次（隧道
 * 已就绪时）；隧道稍后才解析出地址则解析后广播给所有 viewer。未启用自动隧道（`FARSIGHT_NO_TUNNEL`）
 * 或地址尚未解析出时不发本条。
 */
export interface TunnelMessage {
  t: 'tunnel';
  /** 隧道子域名（不含 `.trycloudflare.com`），即 `?debug=` 的值。 */
  sub: string;
  /** 完整隧道 URL（`https://<sub>.trycloudflare.com`）。 */
  url: string;
}

/** viewer 实际会收到的全部消息 = agent 消息 + relay 注入的 sys / agents / reset / tunnel。 */
export type IncomingMessage =
  | AgentMessage
  | SysMessage
  | AgentsMessage
  | ResetMessage
  | TunnelMessage;

/** 任意消息的判别标签（`msg.t`）。 */
export type IncomingKind = IncomingMessage['t'];

/**
 * viewer → relay 的指令。`watch` 由 relay **自行消费**（切换收看目标）；其余经 relay 透传给
 * **当前被看 agent**（不再广播到唯一 agent）。
 */
export type ViewerCommand =
  /**
   * 选择收看哪个 agent（`id=null` 取消收看）。relay 据此过滤转发并补发该 agent 的历史/镜像。
   * `resume=true`（刷新后恢复同一 agent）时 relay 跳过清屏与历史补发、仅补发镜像检查点重建画面。
   */
  | { t: 'watch'; id: string | null; resume?: boolean }
  | { t: 'eval'; code: string }
  | { t: 'snapshot' }
  /** 开/关实时镜像：agent 收到后（首次）懒加载 rrweb 开始/停止录制 DOM 流。 */
  | { t: 'mirror'; on: boolean }
  /** 延迟探针：agent 立刻回 `pong` 带回同一 `id`,viewer 据此算往返延迟。 */
  | { t: 'ping'; id: number };
