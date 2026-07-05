/**
 * agent 运行期共享状态 + 唯一的出站原语 {@link emit}。
 *
 * 拆成多文件后，原先散落在模块顶层的可变 `let` 全部收拢到这一个单例 {@link state}——
 * ESM 的导出绑定无法被外部模块重新赋值，用一个可变对象承载才能让各模块读写同一份状态，
 * 且天然不产生循环依赖（本文件不 import 任何兄弟模块，人人可依赖它）。
 * emit 只依赖 `state.ws`，是各 hook / 镜像 / 命令处理向 viewer 发消息的共同出口，故与状态同处一室。
 */

import type { AgentMessage } from '@farview/protocol';
import type { FarviewOptions } from './types';

interface AgentState {
  /** 当前 WebSocket（null = 未连 / 已断）。线协议由 @farview/protocol 单一维护，viewer 共用同一份。 */
  ws: WebSocket | null;
  /** 已连续退避重连次数。 */
  retries: number;
  /** startFarview 是否已执行（防重复安装）。 */
  installed: boolean;
  /** 宿主注入的业务适配（startFarview 时赋值；缺省全走通用路径）。 */
  options: FarviewOptions;
  /** 本页签身份码：同一浏览器多标签下 UA/URL 全同，靠它在 viewer 里区分谁是谁。 */
  agentCode: string;
  /** 用户已主动退出联调：一旦置位，断开后不再自动重连、emit 全静默。 */
  stopped: boolean;
  /** 退避重连的定时器句柄（供主动退出时清除，避免断开后又被拉回）。 */
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** rrweb 录制停止函数（null = 未在镜像）。 */
  rrStop: (() => void) | null;
  /** rrweb 重拍全量快照（重连后重新播种）。 */
  rrTakeFull: ((isCheckout?: boolean) => void) | null;
  /** rrweb 事件序号（viewer 侧据此排序 / 去重）。 */
  rrSeq: number;
  /** 是否正在镜像。 */
  mirroring: boolean;
}

export const state: AgentState = {
  ws: null,
  retries: 0,
  installed: false,
  options: {},
  agentCode: '',
  stopped: false,
  retryTimer: null,
  rrStop: null,
  rrTakeFull: null,
  rrSeq: 0,
  mirroring: false,
};

export function emit(msg: AgentMessage): void {
  const { ws } = state;
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* 发送失败不影响宿主页面 */
    }
  }
}
