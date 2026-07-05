/**
 * Events 面板：用户行为时间线（点击/输入/hash/路由/可见性/在网）。kind 按类别着色 + 可过滤。
 * 过滤用「禁用集」而非「启用集」：新出现的 kind 默认可见，无需每次手动勾选。
 */
import { useMemo, useState } from 'react';
import { Filter } from 'lucide-react';
import { Input, cn } from '../ui';
import { store, useSelector, type EventEntry } from '../relay-store';
import { VirtualList } from './virtual-list';
import { ClearButton, CopyButton, FilterMenu, highlight } from './ui-bits';

/** kind → 配色（点 + 文字同色）。未知 kind 回退中性灰。匹配按子串（如 'pushState' 命中 'route'）。 */
const KIND_COLOR: { test: RegExp; text: string; dot: string }[] = [
  { test: /click|tap|pointer/i, text: 'text-sky-400', dot: 'bg-sky-400' },
  { test: /input|change|submit/i, text: 'text-emerald-400', dot: 'bg-emerald-400' },
  { test: /hash|route|nav|pop|push/i, text: 'text-violet-400', dot: 'bg-violet-400' },
  { test: /visib|focus|blur/i, text: 'text-amber-400', dot: 'bg-amber-400' },
  { test: /online|offline|net/i, text: 'text-rose-400', dot: 'bg-rose-400' },
];
const KIND_FALLBACK = { text: 'text-muted-foreground', dot: 'bg-muted-foreground' };
function kindColor(kind: string) {
  return KIND_COLOR.find((c) => c.test.test(kind)) ?? KIND_FALLBACK;
}

function EventRow({ e, q }: { e: EventEntry; q: string }) {
  const color = kindColor(e.kind);
  return (
    <div className="group flex items-center gap-2 border-b border-border/40 px-3 py-1 font-(family-name:--rd-mono) text-xs">
      <span className="shrink-0 text-muted-foreground/70 tabular-nums">{e.time}</span>
      {/* 类别列：定宽对齐，点 + 文字同色，过长 kind 截断（完整见 title）。 */}
      <span className={cn('flex w-28 shrink-0 items-center gap-1.5', color.text)} title={e.kind}>
        <span className={cn('size-1.5 shrink-0 rounded-full', color.dot)} />
        <span className="truncate font-medium">{e.kind}</span>
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground" title={e.detail}>
        {highlight(e.detail, q)}
      </span>
      <CopyButton
        value={`${e.kind} ${e.detail}`}
        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
      />
    </div>
  );
}

export function EventsPanel() {
  const list = useSelector((s) => s.events);
  const [q, setQ] = useState('');
  const [disabled, setDisabled] = useState<Set<string>>(() => new Set());

  // 出现过的 kind（用于渲染过滤项），按首次出现顺序去重。
  const kinds = useMemo(() => {
    const seen: string[] = [];
    for (const e of list) if (!seen.includes(e.kind)) seen.push(e.kind);
    return seen;
  }, [list]);
  const kindCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of list) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [list]);
  const kindsAllOn = kinds.every((k) => !disabled.has(k));
  const shownKindCount = kinds.filter((k) => !disabled.has(k)).length;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return list.filter(
      (e) =>
        !disabled.has(e.kind) &&
        (!needle || `${e.kind} ${e.detail}`.toLowerCase().includes(needle)),
    );
  }, [list, q, disabled]);

  const toggle = (kind: string) =>
    setDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏（仿 Chrome）：清空 → 漏斗筛选框 → 类型下拉复选 → 计数。 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
        <ClearButton onClick={() => store.clearChannel('events')} label="清空 Events" />
        <span className="h-4 w-px shrink-0 bg-border" />
        <div className="relative w-72 shrink-0">
          <Filter className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="筛选事件…"
            className="h-7 pl-7 text-xs"
          />
        </div>
        {kinds.length > 0 && (
          <FilterMenu
            trigger={kindsAllOn ? '全部类型' : `类型 ${shownKindCount}/${kinds.length}`}
            allLabel="全部类型"
            allOn={kindsAllOn}
            onAll={() => setDisabled(new Set())}
            options={kinds.map((k) => ({
              value: k,
              count: kindCounts[k] ?? 0,
              className: kindColor(k).text,
            }))}
            isOn={(k) => !disabled.has(k)}
            onToggle={toggle}
          />
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
          {filtered.length}/{list.length}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <VirtualList
          items={filtered}
          renderItem={(e) => <EventRow e={e} q={q} />}
          empty="等待用户行为…"
        />
      </div>
    </div>
  );
}
