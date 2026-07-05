/**
 * 面板间复用的零散 UI 小件：复制按钮、搜索命中高亮、筛选下拉（仿 Chrome 控制台）。
 */
import { useState, type ReactNode } from 'react';
import { Ban, Check, ChevronDown, Copy } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger, cn } from '../ui';

/** 一键复制按钮，复制成功短暂变勾。`label` 提供无障碍名与悬浮提示。 */
export function CopyButton({
  value,
  label = '复制',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className={cn('text-muted-foreground/70 transition-colors hover:text-foreground', className)}
    >
      {done ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
    </button>
  );
}

/** 工具栏「清空」按钮（仿 Chrome 控制台最左的 🚫）。 */
export function ClearButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Ban className="size-4" />
    </button>
  );
}

export interface FilterOption {
  value: string;
  /** 选项右侧计数（如各级别/方法/类型的当前条目数）。 */
  count?: number;
  /** 选项文字着色类（如按级别配色）。 */
  className?: string;
}

/**
 * 筛选下拉复选列表（仿 Chrome 控制台「Default levels ▾」）：触发按钮 + 弹层勾选项 + 顶部「全部」。
 * 语义由调用方掌握（isOn/onToggle/onAll/allOn）——本组件只负责 UI,故环境/网络/事件可各用自己的
 * 「启用集」或「隐藏集」模型。
 */
export function FilterMenu({
  trigger,
  allLabel,
  allOn,
  onAll,
  options,
  isOn,
  onToggle,
}: {
  /** 触发按钮文字（如「全部级别」/「级别 3/6」）。 */
  trigger: string;
  /** 弹层顶部「全部」项文字。 */
  allLabel: string;
  allOn: boolean;
  onAll: () => void;
  options: FilterOption[];
  isOn: (value: string) => boolean;
  onToggle: (value: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-input bg-transparent px-2 text-xs text-foreground transition-colors hover:bg-accent"
          title="筛选"
        >
          {trigger}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-44 p-1">
        <button
          onClick={onAll}
          className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent"
        >
          <Check className={cn('size-3.5 shrink-0', allOn ? 'opacity-100' : 'opacity-0')} />
          <span className="flex-1 text-left">{allLabel}</span>
        </button>
        {options.length > 0 && <div className="my-1 h-px bg-border" />}
        {options.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">暂无</div>
        ) : (
          options.map((o) => (
            <button
              key={o.value}
              onClick={() => onToggle(o.value)}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent"
            >
              <Check
                className={cn('size-3.5 shrink-0', isOn(o.value) ? 'opacity-100' : 'opacity-0')}
              />
              <span className={cn('flex-1 text-left', o.className ?? 'text-foreground')}>
                {o.value}
              </span>
              {o.count != null && (
                <span className="tabular-nums text-muted-foreground">{o.count}</span>
              )}
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}

/** 把 text 里命中 needle 的片段用高亮包起来（大小写不敏感）。needle 为空则原样返回。 */
export function highlight(text: string, needle: string): ReactNode {
  const q = needle.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  for (;;) {
    const at = lower.indexOf(ql, i);
    if (at === -1) {
      out.push(text.slice(i));
      break;
    }
    if (at > i) out.push(text.slice(i, at));
    out.push(
      <mark key={key++} className="rounded-[2px] bg-amber-400/30 text-foreground">
        {text.slice(at, at + q.length)}
      </mark>,
    );
    i = at + q.length;
  }
  return out;
}
