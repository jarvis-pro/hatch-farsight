/**
 * Console 面板：实时日志 / 报错 / eval 回显 / 系统提示。级别过滤 + 文本搜索（命中高亮）+ 虚拟化。
 * eval 返回的对象/数组以可折叠 JSON 树呈现。级别 chip：单击切换、Alt/⌘ 单击「只看此项」。
 */
import { memo, useMemo, useState } from 'react';
import { Filter } from 'lucide-react';
import { Input } from '../ui';
import { store, useSelector, type ConsoleEntry } from '../relay-store';
import { VirtualList } from './virtual-list';
import { JsonTree, tryParseStructured } from './json-tree';
import { ClearButton, CopyButton, FilterMenu, highlight } from './ui-bits';

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;
type Level = (typeof LEVELS)[number];
const ALL: (Level | 'system')[] = [...LEVELS, 'system'];

const LEVEL_COLOR: Record<string, string> = {
  warn: 'text-amber-400',
  error: 'text-rose-400',
  info: 'text-sky-400',
  debug: 'text-muted-foreground',
  log: 'text-foreground',
};

/** 取条目用于搜索/过滤的纯文本与级别。 */
function entryText(e: ConsoleEntry): string {
  switch (e.kind) {
    case 'log':
      return e.args.join(' ');
    case 'err':
      return `${e.message}\n${e.stack}`;
    case 'eval-in':
      return e.code;
    case 'eval-out':
      return e.value;
    case 'sys':
      return e.message;
    case 'hello':
      return `${e.ua} ${e.url}`;
  }
}
function entryLevel(e: ConsoleEntry): Level | 'system' {
  if (e.kind === 'log')
    return (LEVELS as readonly string[]).includes(e.level) ? (e.level as Level) : 'log';
  if (e.kind === 'err' || (e.kind === 'eval-out' && !e.ok)) return 'error';
  return 'system'; // eval-in / sys / hello / eval-out(ok)
}

const Row = memo(function Row({ e, q }: { e: ConsoleEntry; q: string }) {
  const body = (() => {
    switch (e.kind) {
      case 'log':
        return (
          <span className={LEVEL_COLOR[e.level] ?? 'text-foreground'}>
            {highlight(e.args.join(' '), q)}
          </span>
        );
      case 'err':
        return (
          <span className="text-rose-400">
            ✖ {highlight(e.message, q)}
            {e.stack && <span className="mt-0.5 block text-rose-400/70">{highlight(e.stack, q)}</span>}
          </span>
        );
      case 'eval-in':
        return <span className="text-[var(--primary)]">⟶ {highlight(e.code, q)}</span>;
      case 'eval-out': {
        const tree = e.ok ? tryParseStructured(e.value) : null;
        if (tree !== null)
          return (
            <span className="block">
              <span className="text-muted-foreground/60">⟵ </span>
              <JsonTree value={tree} className="inline-block align-top" />
            </span>
          );
        return (
          <span className={e.ok ? 'text-foreground' : 'text-rose-400'}>
            {e.ok ? '⟵ ' : '⚠ '}
            {highlight(e.value, q)}
          </span>
        );
      }
      case 'sys':
        return <span className="text-[var(--primary)]">· {highlight(e.message, q)}</span>;
      case 'hello':
        return (
          <span className="text-[var(--primary)]">
            ▶ agent 上线：{e.ua}
            <span className="mt-0.5 block text-muted-foreground">{e.url}</span>
          </span>
        );
    }
  })();

  return (
    <div className="group flex gap-2 border-b border-border/40 px-3 py-1 font-[family-name:var(--rd-mono)] text-xs leading-relaxed whitespace-pre-wrap break-words">
      <span className="shrink-0 text-muted-foreground/70 tabular-nums">{e.time}</span>
      <span className="min-w-0 flex-1">{body}</span>
      <CopyButton
        value={entryText(e)}
        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
      />
    </div>
  );
});

export function ConsolePanel() {
  const list = useSelector((s) => s.console);
  const [active, setActive] = useState<Set<Level | 'system'>>(() => new Set(ALL));
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return list.filter(
      (e) => active.has(entryLevel(e)) && (!needle || entryText(e).toLowerCase().includes(needle)),
    );
  }, [list, active, q]);

  const toggleLevel = (lv: Level | 'system') =>
    setActive((prev) => {
      const next = new Set(prev);
      next.has(lv) ? next.delete(lv) : next.add(lv);
      return next;
    });
  const allOn = active.size === ALL.length;

  // 各级别当前条目数（下拉里像 Chrome 那样在每项右侧显示计数）。
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of list) {
      const lv = entryLevel(e);
      c[lv] = (c[lv] ?? 0) + 1;
    }
    return c;
  }, [list]);

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏（仿 Chrome 控制台）：清空 → 漏斗筛选框 → 级别下拉复选 → 计数。 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
        <ClearButton onClick={() => store.clearChannel('console')} label="清空 Console" />
        <span className="h-4 w-px shrink-0 bg-border" />
        <div className="relative w-72 shrink-0">
          <Filter className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="筛选…"
            className="h-7 pl-7 text-xs"
          />
        </div>
        <FilterMenu
          trigger={allOn ? '全部级别' : `级别 ${active.size}/${ALL.length}`}
          allLabel="全部级别"
          allOn={allOn}
          onAll={() => setActive(new Set(ALL))}
          options={ALL.map((lv) => ({
            value: lv,
            count: counts[lv] ?? 0,
            className: LEVEL_COLOR[lv] ?? 'text-foreground',
          }))}
          isOn={(lv) => active.has(lv as Level | 'system')}
          onToggle={(lv) => toggleLevel(lv as Level | 'system')}
        />
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
          {filtered.length}/{list.length}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <VirtualList
          items={filtered}
          renderItem={(e) => <Row e={e} q={q} />}
          empty="等待 agent 日志…"
        />
      </div>
    </div>
  );
}
