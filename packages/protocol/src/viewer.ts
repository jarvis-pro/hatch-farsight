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
