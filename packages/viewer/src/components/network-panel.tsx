/**
 * Network 面板：fetch/XHR 请求流。HTTP 2xx 但业务 code≠0 也判失败标红（沿用原 viewer 判定，见 isBadNet）。
 * 行可展开看完整 URL + 响应片段、复制响应 / 复制 cURL。可只看失败、按方法过滤、按耗时分级着色。
 */
import { useMemo, useState } from 'react';
import { Filter } from 'lucide-react';
import { Input, cn } from '../ui';
import { store, useSelector, isBadNet, type NetEntry } from '../relay-store';
import { VirtualList } from './virtual-list';
import { ClearButton, CopyButton, FilterMenu } from './ui-bits';

/** 按耗时给 ms 文本分级着色：慢请求一眼可见。 */
function msColor(ms: number): string {
  if (ms >= 1000) return 'text-rose-400';
  if (ms >= 300) return 'text-amber-400';
  return 'text-muted-foreground';
}

/** 拼一条可在终端直接跑的 cURL（仅有 method+url，无 headers/body——协议未回传）。 */
function toCurl(e: NetEntry): string {
  const m = e.method && e.method.toUpperCase() !== 'GET' ? ` -X ${e.method.toUpperCase()}` : '';
  return `curl${m} '${e.url}'`;
}

/** 拆 URL 为「父路径(含尾斜杠)」+「末段名」——末段是 RPC 方法名等区分性信息，要醒目常驻。 */
function splitUrl(url: string): { path: string; name: string } {
  const bare = url.split(/[?#]/)[0];
  const segs = bare.split('/').filter(Boolean);
  if (!segs.length) return { path: '', name: url };
  const name = segs[segs.length - 1];
  const path = bare.slice(0, bare.length - name.length);
  return { path, name };
}

/** HTTP 状态小药丸：成功绿、失败（含业务码异常）红。 */
function StatusBadge({ status, bad }: { status: number; bad: boolean }) {
  return (
    <span
      className={cn(
        'w-10 shrink-0 rounded px-1 py-0.5 text-center text-[10px] font-semibold tabular-nums',
        bad ? 'bg-rose-500/15 text-rose-400' : 'bg-emerald-500/15 text-emerald-400',
      )}
    >
      {status || 'ERR'}
    </span>
  );
}

function NetRow({ e, open, onToggle }: { e: NetEntry; open: boolean; onToggle: () => void }) {
  const bizBad = typeof e.code === 'number' && e.code !== 0;
  const bad = isBadNet(e);
  const { path, name } = splitUrl(e.url);
  return (
    <div className="border-b border-border/40 font-(family-name:--rd-mono) text-xs">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-accent/40"
      >
        <span className="w-20 shrink-0 text-[11px] text-muted-foreground/60 tabular-nums">
          {e.time}
        </span>
        <StatusBadge status={e.status} bad={bad} />
        <span className="w-10 shrink-0 text-[10px] font-semibold tracking-wide text-muted-foreground/80">
          {e.method}
        </span>
        {/* 末段名常驻可见（行可凭此区分），父路径变灰并在末尾截断。 */}
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 font-medium text-foreground">{name}</span>
          {path && <span className="truncate text-[11px] text-muted-foreground/45">{path}</span>}
        </span>
        <span className={cn('shrink-0 text-[11px] tabular-nums', msColor(e.ms))}>{e.ms}ms</span>
        {typeof e.code === 'number' && (
          <span
            className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums',
              bizBad ? 'bg-rose-500/15 text-rose-400' : 'bg-muted text-muted-foreground',
            )}
          >
            code {e.code}
            {e.codeName ? ` ${e.codeName}` : ''}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-2 bg-muted/40 px-3 py-2">
          <Field label="URL" value={e.url} />
          {e.resSnippet && <Field label="响应" value={e.resSnippet} pre />}
          <Field label="cURL" value={toCurl(e)} />
        </div>
      )}
    </div>
  );
}

function Field({ label, value, pre }: { label: string; value: string; pre?: boolean }) {
  return (
    <div>
      <div className="mb-0.5 flex items-center gap-2 text-[10px] tracking-wide text-muted-foreground uppercase">
        {label}
        <CopyButton value={value} />
      </div>
      <div className={cn('wrap-break-word text-foreground', pre && 'whitespace-pre-wrap')}>
        {value}
      </div>
    </div>
  );
}

export function NetworkPanel() {
  const list = useSelector((s) => s.network);
  const [q, setQ] = useState('');
  const [onlyBad, setOnlyBad] = useState(false);
  // 「隐藏集」模型：默认全显示,新出现的方法自动可见。
  const [hiddenMethods, setHiddenMethods] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState<Set<number>>(() => new Set());

  const methods = useMemo(() => {
    const seen: string[] = [];
    for (const e of list) {
      const m = (e.method || '').toUpperCase();
      if (m && !seen.includes(m)) seen.push(m);
    }
    return seen;
  }, [list]);
  const methodCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of list) {
      const m = (e.method || '').toUpperCase();
      if (m) c[m] = (c[m] ?? 0) + 1;
    }
    return c;
  }, [list]);
  const methodsAllOn = methods.every((m) => !hiddenMethods.has(m));
  const shownMethodCount = methods.filter((m) => !hiddenMethods.has(m)).length;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return list.filter(
      (e) =>
        (!onlyBad || isBadNet(e)) &&
        !hiddenMethods.has((e.method || '').toUpperCase()) &&
        (!needle || `${e.method} ${e.url} ${e.codeName ?? ''}`.toLowerCase().includes(needle)),
    );
  }, [list, q, onlyBad, hiddenMethods]);

  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleMethod = (m: string) =>
    setHiddenMethods((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏（仿 Chrome）：清空 → 漏斗筛选框 → 只看失败 → 方法下拉复选 → 计数。 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
        <ClearButton onClick={() => store.clearChannel('network')} label="清空 Network" />
        <span className="h-4 w-px shrink-0 bg-border" />
        <div className="relative w-72 shrink-0">
          <Filter className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="筛选 URL / 方法 / 错误名…"
            className="h-7 pl-7 text-xs"
          />
        </div>
        <button
          onClick={() => setOnlyBad((v) => !v)}
          className={cn(
            'h-7 shrink-0 rounded-md border px-2 text-xs font-medium transition-colors',
            onlyBad
              ? 'border-rose-500/40 bg-rose-500/20 text-rose-400'
              : 'border-input text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          只看失败
        </button>
        {methods.length > 0 && (
          <FilterMenu
            trigger={methodsAllOn ? '全部方法' : `方法 ${shownMethodCount}/${methods.length}`}
            allLabel="全部方法"
            allOn={methodsAllOn}
            onAll={() => setHiddenMethods(new Set())}
            options={methods.map((m) => ({ value: m, count: methodCounts[m] ?? 0 }))}
            isOn={(m) => !hiddenMethods.has(m)}
            onToggle={toggleMethod}
          />
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
          {filtered.length}/{list.length}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <VirtualList
          items={filtered}
          estimateSize={32}
          renderItem={(e) => <NetRow e={e} open={open.has(e.id)} onToggle={() => toggle(e.id)} />}
          empty="等待网络请求…"
        />
      </div>
    </div>
  );
}
