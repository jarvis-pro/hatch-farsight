/**
 * 「环境」一级面板：设备当前状态（租户/主题/storage/设备）。最新一份常驻，可选基线做 **diff 高亮**
 * （联调要看「差在哪」）。数据走 store 的 inspect 通道（kind='snapshot'）。
 *
 * 布局：顶部仿 Chrome 工具栏（筛选 + 基线 + 变化数 + 复制），下方按「区块」拆成多张紧凑卡片，
 * 自适应分栏（masonry），各区块带图标/键数/变化角标、可单独复制。筛选按 键/值 子串命中、
 * 高亮并隐藏空区块。DOM 检视已并入「镜像」面板（直接读回放 iframe），截图已移除——故此处只剩环境快照。
 */
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import {
  Cookie,
  Database,
  Filter,
  Fingerprint,
  Globe,
  MonitorSmartphone,
  Package,
  Palette,
  RotateCw,
} from 'lucide-react';
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
  toast,
} from '../ui';
import { store, useSelector, type InspectEntry } from '../relay-store';
import type { Relay } from '../use-relay';
import { ClearButton, CopyButton, highlight } from './ui-bits';

type Snap = Extract<InspectEntry, { kind: 'snapshot' }>;
type IconType = ComponentType<{ className?: string }>;

/** 已知区块的图标与中文标签；未登记的区块回退通用图标 + 原 key。 */
const SECTION_META: Record<string, { icon: IconType; label: string }> = {
  tenant: { icon: Fingerprint, label: '租户' },
  location: { icon: Globe, label: '位置' },
  device: { icon: MonitorSmartphone, label: '设备' },
  localStorage: { icon: Database, label: 'localStorage' },
  sessionStorage: { icon: Database, label: 'sessionStorage' },
  cookie: { icon: Cookie, label: 'Cookie' },
  cssVars: { icon: Palette, label: '主题变量' },
};
/** 区块展示顺序：身份/环境在前，体积大的主题变量垫后。未登记的接在最后（按原顺序）。 */
const SECTION_ORDER = [
  'tenant',
  'location',
  'device',
  'localStorage',
  'sessionStorage',
  'cookie',
  'cssVars',
];

/** 把任意值渲染成可读字符串（对象/数组 → JSON）。 */
function show(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 把快照 data 拍平成 `section/key → 值字符串`（标量区块直接用 section 名），用于跨两份快照逐键对比。 */
function flatten(data: Record<string, unknown>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [section, val] of Object.entries(data)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const [k, v] of Object.entries(val as Record<string, unknown>))
        m.set(`${section}/${k}`, show(v));
    } else {
      m.set(section, show(val));
    }
  }
  return m;
}

type RowStatus = 'same' | 'added' | 'changed' | 'removed';
const STATUS_CLS: Record<RowStatus, string> = {
  same: 'text-foreground',
  added: 'text-emerald-400',
  changed: 'text-amber-400',
  removed: 'text-rose-400 line-through',
};

interface Row {
  k: string;
  /** 与 {@link flatten} 同构的对比键（对象 `section/k`、标量 `section`）。 */
  flatKey: string;
  cur: string | null;
  old: string | null;
  status: RowStatus;
}

/** 把一个区块（对象或标量）算成带 diff 状态的行集合；标量区块只有一行（key = 区块名）。 */
function buildRows(section: string, val: unknown, prev: Map<string, string> | null): Row[] {
  const isObj = val && typeof val === 'object' && !Array.isArray(val);
  const entries: { k: string; flatKey: string; cur: string }[] = isObj
    ? Object.entries(val as Record<string, unknown>).map(([k, v]) => ({
        k,
        flatKey: `${section}/${k}`,
        cur: show(v),
      }))
    : [{ k: section, flatKey: section, cur: show(val) }];

  const rows: Row[] = entries.map(({ k, flatKey, cur }) => {
    const old = prev?.get(flatKey);
    const status: RowStatus = !prev
      ? 'same'
      : old === undefined
        ? 'added'
        : old !== cur
          ? 'changed'
          : 'same';
    return { k, flatKey, cur, old: old ?? null, status };
  });

  // 基线里有、当前没有的键 = removed（仅对象区块逐键比；标量区块整块消失另算）。
  if (prev && isObj) {
    const present = new Set(rows.map((r) => r.k));
    const pfx = `${section}/`;
    for (const key of prev.keys()) {
      if (key.startsWith(pfx)) {
        const k = key.slice(pfx.length);
        if (!present.has(k))
          rows.push({ k, flatKey: key, cur: null, old: prev.get(key) ?? null, status: 'removed' });
      }
    }
  }
  return rows;
}

function RowValue({ row, q }: { row: Row; q: string }) {
  if (row.status === 'changed')
    return (
      <span className={cn('break-all whitespace-pre-wrap', STATUS_CLS.changed)}>
        <span className="text-muted-foreground/60 line-through">{row.old}</span>
        <span className="px-1 text-muted-foreground/60">→</span>
        {highlight(row.cur ?? '', q)}
      </span>
    );
  const text = row.status === 'removed' ? (row.old ?? '') : (row.cur ?? '');
  return (
    <span className={cn('break-all whitespace-pre-wrap', STATUS_CLS[row.status])}>
      {highlight(text, q)}
    </span>
  );
}

function SectionCard({
  section,
  val,
  prev,
  q,
}: {
  section: string;
  val: unknown;
  prev: Map<string, string> | null;
  q: string;
}) {
  const meta = SECTION_META[section] ?? { icon: Package, label: section };
  const Icon = meta.icon;

  const rows = useMemo(() => buildRows(section, val, prev), [section, val, prev]);
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? rows.filter(
        (r) =>
          r.k.toLowerCase().includes(needle) ||
          (r.cur ?? '').toLowerCase().includes(needle) ||
          (r.old ?? '').toLowerCase().includes(needle),
      )
    : rows;
  const changeCount = rows.filter((r) => r.status !== 'same').length;

  // 仅「过滤无命中」时隐藏；无过滤时空区块照常显示（标「空」），让人看出已同步、只是无数据。
  if (needle && shown.length === 0) return null;

  return (
    <section className="group mb-3 break-inside-avoid overflow-hidden rounded-lg border bg-card">
      <header className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-semibold">{meta.label}</span>
        <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
          {rows.filter((r) => r.status !== 'removed').length}
        </span>
        {changeCount > 0 && (
          <span className="shrink-0 rounded bg-amber-400/20 px-1.5 text-[10px] tabular-nums text-amber-400">
            {changeCount} 变化
          </span>
        )}
        <CopyButton
          value={JSON.stringify(val, null, 2)}
          label={`复制 ${meta.label}`}
          className="ml-auto shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
        />
      </header>
      {shown.length === 0 ? (
        <div className="px-3 py-2 font-(family-name:--rd-mono) text-xs text-muted-foreground/50">
          （空）
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-1 px-3 py-2 font-(family-name:--rd-mono) text-xs">
          {shown.map((row) => (
            <div key={row.flatKey} className="contents">
              <span className="break-all text-muted-foreground" title={row.k}>
                {highlight(row.k, q)}
              </span>
              <RowValue row={row} q={q} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function EnvView({ snaps, relay, online }: { snaps: Snap[]; relay: Relay; online: boolean }) {
  const latest = snaps[snaps.length - 1];
  // 基线：'prev'（永远比上一份，随新快照自动跟随）/ 'none' / 某历史 id。
  const [baseline, setBaseline] = useState<'prev' | 'none' | number>('prev');
  const [q, setQ] = useState('');

  // 主动点同步时挂起，待新快照实际回传后弹 toast（自动同步/其它快照增长不触发）。
  const pendingSync = useRef(false);
  const handleSync = () => {
    if (relay.send({ t: 'snapshot' })) pendingSync.current = true;
    else toast.error('agent 未连接，无法同步');
  };
  useEffect(() => {
    if (pendingSync.current) {
      pendingSync.current = false;
      toast.success('已同步环境快照');
    }
  }, [snaps.length]);

  const prevSnap = useMemo(() => {
    if (!latest) return null;
    if (baseline === 'none') return null;
    if (baseline === 'prev') return snaps[snaps.length - 2] ?? null;
    return snaps.find((s) => s.id === baseline) ?? snaps[snaps.length - 2] ?? null;
  }, [baseline, snaps, latest]);

  const prevFlat = useMemo(() => (prevSnap ? flatten(prevSnap.data) : null), [prevSnap]);

  const changeCount = useMemo(() => {
    if (!latest || !prevFlat) return 0;
    const cur = flatten(latest.data);
    let n = 0;
    for (const [k, v] of cur) if (prevFlat.get(k) !== v) n++;
    for (const k of prevFlat.keys()) if (!cur.has(k)) n++;
    return n;
  }, [latest, prevFlat]);

  // 区块排序：已登记顺序在前、未登记接后（保原顺序）。
  const orderedKeys = latest
    ? [
        ...SECTION_ORDER.filter((k) => k in latest.data),
        ...Object.keys(latest.data).filter((k) => !SECTION_ORDER.includes(k)),
      ]
    : [];
  const others = snaps.slice(0, -1).reverse();

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏（仿 Chrome）：清除 → 筛选框 + 同步 → 基线下拉 → 变化角标 → 时间 → 复制全量。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
        <ClearButton
          onClick={() => store.clearInspectKeepLast()}
          label="清除历史快照（保留最近一份）"
        />
        <span className="h-4 w-px shrink-0 bg-border" />
        <div className="relative w-56 shrink-0">
          <Filter className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="筛选键 / 值…"
            className="h-7 pl-7 text-xs"
          />
        </div>
        {/* 同步 + 基线对比：分段组合控件（同步图标在左，基线下拉在右，共享一个描边）。 */}
        <div className="flex h-7 shrink-0 items-center overflow-hidden rounded-md border border-input">
          <button
            type="button"
            onClick={handleSync}
            disabled={!online}
            title={online ? '向 agent 拉取一份新的环境快照' : 'agent 未连接'}
            aria-label="同步环境快照"
            className="flex h-full items-center px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <RotateCw className="size-3.5" />
          </button>
          {snaps.length > 1 && (
            <>
              <span className="h-full w-px shrink-0 bg-input" />
              <Select
                value={String(baseline)}
                onValueChange={(v) => setBaseline(v === 'prev' || v === 'none' ? v : Number(v))}
              >
                <SelectTrigger className="h-full w-44 gap-1 rounded-none border-0 bg-transparent px-2 text-xs whitespace-nowrap shadow-none focus-visible:ring-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="prev">对比上一份</SelectItem>
                  <SelectItem value="none">不对比</SelectItem>
                  {others.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      对比 {s.time}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
        </div>
        {prevSnap && (
          <span
            className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
              changeCount > 0 ? 'bg-amber-400/20 text-amber-400' : 'bg-muted text-muted-foreground',
            )}
          >
            {changeCount > 0 ? `${changeCount} 处变化` : '无变化'}
          </span>
        )}
        {latest && (
          <>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
              {latest.time}
            </span>
            <CopyButton value={JSON.stringify(latest.data, null, 2)} label="复制快照 JSON" />
          </>
        )}
      </div>

      {/* 区块卡片：自适应分栏（masonry），各卡片随内容高、按列回流。 */}
      {latest ? (
        <div className="rd-scroll min-h-0 flex-1 overflow-auto p-3">
          <div className="columns-1 gap-3 sm:columns-2 xl:columns-3 2xl:columns-4">
            {orderedKeys.map((key) => (
              <SectionCard key={key} section={key} val={latest.data[key]} prev={prevFlat} q={q} />
            ))}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <Empty>
            {online
              ? '点「同步」拉取环境快照（租户/主题/storage/设备）'
              : '等待 agent 连接，连上后自动同步一次'}
          </Empty>
        </div>
      )}
    </div>
  );
}

/** 环境快照面板（diff）。`relay`/`online` 供工具栏「同步」按钮按需拉取。 */
export function EnvPanel({ relay, online }: { relay: Relay; online: boolean }) {
  const list = useSelector((s) => s.inspect);
  const snaps = useMemo(() => list.filter((e): e is Snap => e.kind === 'snapshot'), [list]);
  return <EnvView snaps={snaps} relay={relay} online={online} />;
}
