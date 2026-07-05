/**
 * 命令面板（⌘K）：把全局动作收成一处可搜索列表，让顶部/底部界面保持干净。
 * 键盘：输入过滤、↑/↓ 选择（跳过禁用项）、↵ 执行、Esc 关闭。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from 'react';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, cn } from '../ui';

export interface Command {
  id: string;
  label: string;
  /** 左侧图标（lucide 组件），便于区分。 */
  icon?: ComponentType<{ className?: string }>;
  /** 右侧提示（快捷键 / 分类）。 */
  hint?: string;
  /** 搜索可匹配的附加关键词。 */
  keywords?: string;
  disabled?: boolean;
  run: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  commands,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  commands: Command[];
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) => `${c.label} ${c.hint ?? ''} ${c.keywords ?? ''}`.toLowerCase().includes(needle));
  }, [commands, q]);

  // 打开时重置；过滤变化时把选中收敛到首个可用项
  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
    }
  }, [open]);
  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const move = (dir: number) => {
    if (filtered.length === 0) return;
    let i = sel;
    for (let n = 0; n < filtered.length; n++) {
      i = (i + dir + filtered.length) % filtered.length;
      if (!filtered[i].disabled) break;
    }
    setSel(i);
    listRef.current?.querySelectorAll('[data-cmd]')[i]?.scrollIntoView({ block: 'nearest' });
  };

  const exec = (c: Command) => {
    if (c.disabled) return;
    onOpenChange(false);
    c.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = filtered[sel];
      if (c) exec(c);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-lg">
        <DialogTitle className="sr-only">命令面板</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索命令…"
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div ref={listRef} className="rd-scroll max-h-80 overflow-auto p-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">无匹配命令</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                data-cmd
                disabled={c.disabled}
                onMouseMove={() => !c.disabled && setSel(i)}
                onClick={() => exec(c)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded px-3 py-2 text-left text-sm',
                  c.disabled
                    ? 'cursor-not-allowed text-muted-foreground/40'
                    : i === sel
                      ? 'bg-accent text-accent-foreground'
                      : 'text-foreground',
                )}
              >
                {c.icon && <c.icon className="size-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                {c.hint && <span className="shrink-0 text-[10px] text-muted-foreground">{c.hint}</span>}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
