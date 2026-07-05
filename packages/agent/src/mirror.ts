// ───────────────────────────── 实时镜像（rrweb 录制） ─────────────────────────────
// 仅当 viewer 显式下发 `mirror:on` 才懒加载 @rrweb/record（再一个独立子 chunk，常规联调都不下载），
// 把页面 DOM 的全量快照 + 增量流给 viewer 重建。隐私默认收紧：所有输入值打码、密码天然打码，
// 敏感区可加 `.rd-block`（整块屏蔽）/ `.rd-mask`（文本打码）。

import { clip } from './format';
import { emit, state } from './state';

export async function startMirror(): Promise<void> {
  if (state.mirroring) return;
  state.mirroring = true;
  try {
    const { record } = await import('@rrweb/record');
    const stop = record({
      emit: (ev) => {
        // 仅看事件类型给 relay 划检查点：4=Meta（新检查点起点）、2=FullSnapshot、其余=增量。
        const kind = ev.type === 4 ? 'meta' : ev.type === 2 ? 'snap' : 'incr';
        emit({ t: 'rr', kind, seq: state.rrSeq++, ev });
      },
      maskAllInputs: true, // 绝不外发用户真实输入（与「行为时间线只记长度」同一克制）
      maskTextClass: 'rd-mask',
      blockClass: 'rd-block',
      recordCanvas: false, // canvas 像素录制开销大且本场景用不到
      checkoutEveryNms: 10000, // 每 10s 重拍全量快照：界定 relay 缓冲上限 + 让中途连入者立即重建
      // 滚动约 30fps（原 100=10fps,体感发顿）；鼠标采点 16ms + 每 16ms flush 一批 ≈ 60fps
      // （rrweb 默认 50ms 采点 / 500ms flush → 光标每 500ms 才换一次目标,被饿出瞬移感）。
      sampling: { scroll: 16, media: 400, input: 'last', mousemove: 16, mousemoveCallback: 16 },
    });
    state.rrStop = stop ?? null;
    state.rrTakeFull = record.takeFullSnapshot ?? null;
  } catch (err) {
    state.mirroring = false;
    emit({
      t: 'log',
      level: 'warn',
      args: [clip('远程联调：镜像启动失败 ' + (err instanceof Error ? err.message : String(err)))],
    });
  }
}

export function stopMirror(): void {
  if (state.rrStop) {
    try {
      state.rrStop();
    } catch {
      /* ignore */
    }
  }
  state.rrStop = null;
  state.rrTakeFull = null;
  state.mirroring = false;
}
