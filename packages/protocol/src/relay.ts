/**
 * relay 自行注入的消息（agent 不产生这些）：relay 不解析业务消息，仅做多路复用/转发/历史补发，
 * 并随 agent 上下线/握手、隧道就绪、切换收看等，向 viewer 广播/下发这些控制类消息。
 */

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
 * 已就绪时）；隧道稍后才解析出地址则解析后广播给所有 viewer。未启用自动隧道（`FARVIEW_NO_TUNNEL`）
 * 或地址尚未解析出时不发本条。
 */
export interface TunnelMessage {
  t: 'tunnel';
  /** 隧道子域名（不含 `.trycloudflare.com`），即 `?debug=` 的值。 */
  sub: string;
  /** 完整隧道 URL（`https://<sub>.trycloudflare.com`）。 */
  url: string;
}
