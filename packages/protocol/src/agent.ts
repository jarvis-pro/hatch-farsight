/**
 * agent → viewer 方向的上行消息：agent 的 `emit` 只发这些。
 * 注意 `sys` 不在此列——它由 relay 注入，见 ./relay 的 {@link SysMessage} 与根 {@link IncomingMessage}。
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
