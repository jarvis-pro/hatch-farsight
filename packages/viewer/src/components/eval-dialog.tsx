/**
 * 脚本运行弹窗：在用户页执行 JS。多行高亮编辑器 + 常用片段 + 命令历史（↑/↓）。
 * ⌘/Ctrl+↵ 运行；运行结果回 Console（弹窗关闭并切到 Console）。
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { Play } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogTitle } from '../ui';
import { store } from '../relay-store';
import type { Relay } from '../use-relay';
import { CodeEditor } from './code-editor';

const HISTORY_KEY = 'remote-debug-eval-history';
const HISTORY_CAP = 50;

const SNIPPETS: { label: string; code: string }[] = [
  { label: '租户配置', code: 'JSON.stringify(window.__TENANT__, null, 2)' },
  { label: 'localStorage', code: 'JSON.stringify({...localStorage}, null, 2)' },
  { label: 'URL', code: 'location.href' },
  { label: 'UA', code: 'navigator.userAgent' },
  { label: '根 class', code: 'document.documentElement.className' },
  { label: '视口', code: 'innerWidth + "x" + innerHeight' },
];

function loadHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function EvalDialog({
  open,
  onOpenChange,
  relay,
  online,
  onRan,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  relay: Relay;
  online: boolean;
  onRan?: () => void;
}) {
  const [code, setCode] = useState('');
  const histRef = useRef<string[]>(loadHistory());
  const [histIdx, setHistIdx] = useState<number | null>(null);

  const pushHistory = (c: string) => {
    const h = histRef.current.filter((x) => x !== c);
    h.push(c);
    if (h.length > HISTORY_CAP) h.splice(0, h.length - HISTORY_CAP);
    histRef.current = h;
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
    } catch {
      /* 忽略写盘失败 */
    }
  };

  const run = () => {
    const c = code.trim();
    if (!c || !online) return;
    store.pushEvalIn(c);
    relay.send({ t: 'eval', code: c });
    pushHistory(c);
    setCode('');
    setHistIdx(null);
    onOpenChange(false);
    onRan?.();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      run();
      return;
    }
    // 仅单行状态翻历史，避免妨碍多行编辑
    const h = histRef.current;
    if (e.key === 'ArrowUp' && !code.includes('\n')) {
      if (h.length === 0) return;
      const next = histIdx === null ? h.length - 1 : Math.max(0, histIdx - 1);
      e.preventDefault();
      setHistIdx(next);
      setCode(h[next]);
    } else if (e.key === 'ArrowDown' && histIdx !== null && !code.includes('\n')) {
      e.preventDefault();
      if (histIdx >= h.length - 1) {
        setHistIdx(null);
        setCode('');
      } else {
        setHistIdx(histIdx + 1);
        setCode(h[histIdx + 1]);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogTitle className="text-sm">在用户页运行脚本</DialogTitle>
        <div className="flex flex-wrap gap-1">
          {SNIPPETS.map((s) => (
            <button
              key={s.label}
              onClick={() => {
                setCode(s.code);
                setHistIdx(null);
              }}
              className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={s.code}
            >
              {s.label}
            </button>
          ))}
        </div>
        <CodeEditor
          value={code}
          onChange={(v) => {
            setCode(v);
            setHistIdx(null);
          }}
          onKeyDown={onKeyDown}
          autoFocus
          placeholder={online ? 'JSON.stringify(window.__TENANT__)' : 'agent 未在线,无法执行'}
          className="h-48"
        />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">
            ⌘/Ctrl+↵ 运行 · ↑ 调历史 · 结果回 Console
          </span>
          <Button size="sm" disabled={!online || !code.trim()} onClick={run}>
            <Play className="size-4" /> 运行
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
