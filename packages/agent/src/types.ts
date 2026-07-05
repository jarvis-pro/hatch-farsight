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
