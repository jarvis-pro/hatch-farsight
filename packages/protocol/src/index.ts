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
 *
 * 按消息流向拆分为三个模块，本文件汇总重导出并定义两端组合出的聚合类型：
 *  - {@link ./agent}   —— agent → viewer 的上行消息（{@link AgentMessage}）
 *  - {@link ./relay}   —— relay 注入的控制消息（名册/切换/隧道/系统提示）
 *  - {@link ./viewer}  —— viewer → relay/agent 的指令（{@link ViewerCommand}）
 */

export * from './agent';
export * from './relay';
export * from './viewer';

import type { AgentMessage } from './agent';
import type { SysMessage, AgentsMessage, ResetMessage, TunnelMessage } from './relay';

/** viewer 实际会收到的全部消息 = agent 消息 + relay 注入的 sys / agents / reset / tunnel。 */
export type IncomingMessage =
  AgentMessage | SysMessage | AgentsMessage | ResetMessage | TunnelMessage;

/** 任意消息的判别标签（`msg.t`）。 */
export type IncomingKind = IncomingMessage['t'];
