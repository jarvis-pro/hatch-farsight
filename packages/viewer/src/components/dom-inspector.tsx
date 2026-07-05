/**
 * 本地 DOM 检视器：**直接读镜像回放 iframe** 重建出的实时 DOM,不回程到 agent——故零延迟、
 * 悬停即高亮、且绝不触碰用户真实页面（旧方案每次 inspect-at 会把用户页面滚到目标元素居中,很扰民）。
 *
 * 与 rrweb 协作的关键：选中态用 **rrweb 节点 id**（而非 Element 引用）表达。镜像每次 DOM 变更都会
 * 双缓冲重建、换掉整个 iframe,Element 引用随之失效；但 rrweb 的 id 由录制端分配、跨重建/检查点稳定,
 * 故用 id + `getMirror().getNode(id)` 永远能在「当前」回放里解析回对应节点。
 *
 * 数据全部在 render 期从 live DOM 现读（盒模型/计算样式/诊断/结构树）；父组件用一个周期性自增的
 * `tick` 触发重读,使画面随页面变更保持新鲜（不必每帧重渲染）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../ui';
import { CopyButton } from './ui-bits';

/** 父组件（镜像面板）提供的「当前回放」访问口：每次取都是最新一帧的 iframe / mirror。 */
export interface InspectApi {
  /** 当前回放 iframe 的 document（每次重建会换,故按需取）。 */
  getDoc(): Document | null;
  /** 当前回放 iframe 的 window（用于 getComputedStyle）。 */
  getWin(): Window | null;
  /** rrweb 镜像：id → 节点（跨重建/检查点稳定）。 */
  getNode(id: number): Node | null;
  /** rrweb 镜像：节点 → id（未被 rrweb 跟踪的节点返回 -1）。 */
  getId(node: Node): number;
}

/** 关键计算样式集合（盒模型四边取长手——简写在 getComputedStyle 下常为空）。 */
const INSPECT_PROPS = [
  'display',
  'position',
  'box-sizing',
  'width',
  'height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'color',
  'background-color',
  'font-size',
  'z-index',
  'opacity',
  'visibility',
  'transform',
  'overflow',
];

/** 元素的紧凑可读标签：`button#id.cls`（与 agent selectorOf 同口径）。 */
export function labelOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  const name = el.getAttribute('name');
  if (name) return `${tag}[name=${name}]`;
  // 过滤 rrweb 回放注入的伪类模拟类（如 `:hover`）,只取真实业务类名。
  const classes =
    typeof el.className === 'string'
      ? el.className
          .trim()
          .split(/\s+/)
          .filter((c) => c && !c.startsWith(':'))
      : [];
  const cls = classes.length ? '.' + classes.slice(0, 2).join('.') : '';
  return tag + cls;
}

/** 元素的直接文本摘要（仅 textNode 子,截断）；无则空串。 */
function directText(el: Element): string {
  let t = '';
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) t += n.textContent ?? '';
  t = t.trim();
  return t.length > 60 ? t.slice(0, 60) + '…' : t;
}

function readStyles(win: Window, el: Element): Record<string, string> {
  const cs = win.getComputedStyle(el);
  const s: Record<string, string> = {};
  for (const p of INSPECT_PROPS) s[p] = cs.getPropertyValue(p);
  return s;
}

export interface Diag {
  visible: boolean;
  clickable: boolean;
  coveredBy: string | null;
  notes: string[];
}

/** 诊断：可见 / 可点 / 被谁遮挡——全在回放 iframe 里测,反映镜像所见的真实布局。 */
function diagnose(win: Window, doc: Document, el: Element): Diag {
  const cs = win.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const notes: string[] = [];
  const sized = r.width > 0 && r.height > 0;
  if (!sized) notes.push('尺寸为 0');
  if (cs.display === 'none') notes.push('display:none');
  if (cs.visibility === 'hidden') notes.push('visibility:hidden');
  if (parseFloat(cs.opacity) === 0) notes.push('opacity:0');
  const visible =
    sized && cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) !== 0;

  let coveredBy: string | null = null;
  if (visible) {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const vw = win.innerWidth || doc.documentElement.clientWidth;
    const vh = win.innerHeight || doc.documentElement.clientHeight;
    if (cx >= 0 && cy >= 0 && cx <= vw && cy <= vh) {
      const top = doc.elementFromPoint(cx, cy);
      if (top && top !== el && !el.contains(top) && !top.contains(el)) {
        coveredBy = labelOf(top);
        notes.push(`被 ${coveredBy} 遮挡`);
      }
    } else {
      notes.push('中心在视口外');
    }
  }
  if (cs.pointerEvents === 'none') notes.push('pointer-events:none');
  const clickable = visible && cs.pointerEvents !== 'none' && !coveredBy;
  return { visible, clickable, coveredBy, notes };
}

// ───────────────────────────── 盒模型 ─────────────────────────────

function lenVal(styles: Record<string, string>, key: string): string {
  const raw = styles[key];
  if (raw == null || raw === '') return '–';
  const n = parseFloat(raw);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : raw;
}
function box4(styles: Record<string, string>, keys: string[]): [string, string, string, string] {
  return keys.map((k) => lenVal(styles, k)) as [string, string, string, string];
}

function Ring({
  label,
  v,
  cls,
  children,
}: {
  label: string;
  v: [string, string, string, string];
  cls: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('relative rounded px-8 pt-6 pb-6 text-center', cls)}>
      <span className="absolute top-0.5 left-1.5 text-[9px] tracking-wide uppercase opacity-70">
        {label}
      </span>
      <span className="absolute top-1 left-1/2 -translate-x-1/2 text-[10px] tabular-nums">
        {v[0]}
      </span>
      <span className="absolute top-1/2 right-1.5 -translate-y-1/2 text-[10px] tabular-nums">
        {v[1]}
      </span>
      <span className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[10px] tabular-nums">
        {v[2]}
      </span>
      <span className="absolute top-1/2 left-1.5 -translate-y-1/2 text-[10px] tabular-nums">
        {v[3]}
      </span>
      {children}
    </div>
  );
}

function BoxModel({ styles }: { styles: Record<string, string> }) {
  const margin = box4(styles, ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']);
  const border = box4(styles, [
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
  ]);
  const padding = box4(styles, ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']);
  const w = lenVal(styles, 'width');
  const h = lenVal(styles, 'height');
  return (
    <div className="font-[family-name:var(--rd-mono)] text-foreground">
      <Ring label="margin" v={margin} cls="bg-amber-400/15">
        <Ring label="border" v={border} cls="bg-violet-400/15">
          <Ring label="padding" v={padding} cls="bg-emerald-400/15">
            <div className="rounded bg-sky-400/20 px-4 py-3 text-[11px] tabular-nums">
              {w} × {h}
            </div>
          </Ring>
        </Ring>
      </Ring>
    </div>
  );
}

const BOX_KEYS = new Set([
  'width',
  'height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
]);

function DiagBadges({ diag }: { diag: Diag }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]">
      <span className="flex items-center gap-1.5">
        <span
          className={cn('size-1.5 rounded-full', diag.visible ? 'bg-emerald-500' : 'bg-rose-500')}
        />
        <span className={diag.visible ? 'text-foreground' : 'text-rose-400'}>
          {diag.visible ? '可见' : '不可见'}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            'size-1.5 rounded-full',
            diag.clickable ? 'bg-emerald-500' : 'bg-amber-500',
          )}
        />
        <span className={diag.clickable ? 'text-foreground' : 'text-amber-400'}>
          {diag.clickable ? '可点' : '不可点'}
        </span>
      </span>
      {diag.notes.length > 0 && (
        <>
          <span className="h-3 w-px bg-border" />
          {diag.notes.map((n, i) => (
            <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
              {n}
            </span>
          ))}
        </>
      )}
    </div>
  );
}

// ───────────────────────────── 结构树（实时,懒展开） ─────────────────────────────

/** 标签着色：`button#id.cls` → tag 蓝、其余（#id/.cls）淡。 */
function TagLabel({ label }: { label: string }) {
  const m = label.match(/^([\w-]+)(.*)$/);
  if (!m) return <span className="text-sky-400">{label}</span>;
  return (
    <>
      <span className="text-sky-400">{m[1]}</span>
      <span className="text-muted-foreground">{m[2]}</span>
    </>
  );
}

function TreeRow({
  el,
  depth,
  api,
  selectedId,
  expanded,
  onToggle,
  onSelect,
  onHover,
}: {
  el: Element;
  depth: number;
  api: InspectApi;
  selectedId: number | null;
  expanded: Set<number>;
  onToggle: (id: number) => void;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
}) {
  const id = api.getId(el);
  // 跳过未被 rrweb 跟踪的节点（如本地注入的修正样式）：它们解析不回节点,展示无意义。
  const kids = Array.from(el.children).filter((c) => api.getId(c) >= 1);
  const open = expanded.has(id);
  const text = directText(el);
  const isSelf = id === selectedId;
  return (
    <>
      <div
        onClick={() => onSelect(id)}
        onMouseEnter={() => onHover(id)}
        onMouseLeave={() => onHover(null)}
        className={cn(
          'flex cursor-default items-center gap-1 rounded-sm py-0.5 pr-1.5 font-[family-name:var(--rd-mono)] text-xs',
          isSelf ? 'bg-secondary text-secondary-foreground' : 'hover:bg-accent',
        )}
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        {kids.length ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle(id);
            }}
            className="grid size-3.5 shrink-0 place-items-center rounded text-muted-foreground/50 hover:text-foreground"
            title="展开/折叠"
          >
            <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="inline-block size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">
          <TagLabel label={labelOf(el)} />
          {text && <span className="ml-1 text-emerald-400/80">{text}</span>}
          {kids.length > 0 && !open && (
            <span className="ml-1 text-muted-foreground/40">…{kids.length}</span>
          )}
        </span>
      </div>
      {open &&
        kids.map((c) => (
          <TreeRow
            key={api.getId(c)}
            el={c}
            depth={depth + 1}
            api={api}
            selectedId={selectedId}
            expanded={expanded}
            onToggle={onToggle}
            onSelect={onSelect}
            onHover={onHover}
          />
        ))}
    </>
  );
}

// ───────────────────────────── 面包屑 ─────────────────────────────

/** 节点路径条（仿 Chrome DOM 面包屑）：单行不换行,溢出时两端出 ‹ › 箭头横向滚动。 */
function NodePath({
  crumbs,
  selfLabel,
  onGo,
  onHover,
}: {
  crumbs: { id: number; label: string }[];
  selfLabel: string;
  onGo: (id: number) => void;
  onHover: (id: number | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [canL, setCanL] = useState(false);
  const [canR, setCanR] = useState(false);
  const update = () => {
    const el = ref.current;
    if (!el) return;
    setCanL(el.scrollLeft > 1);
    setCanR(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth; // 切换节点后滚到末端,让当前节点（最右）可见
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [crumbs, selfLabel]);
  const nudge = (dir: number) =>
    ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.7, behavior: 'smooth' });
  const overflow = canL || canR;
  const arrowCls =
    'shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30';
  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      {overflow && (
        <button onClick={() => nudge(-1)} disabled={!canL} className={arrowCls} aria-label="左移">
          <ChevronLeft className="size-3.5" />
        </button>
      )}
      <div
        ref={ref}
        onScroll={update}
        className="no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto font-[family-name:var(--rd-mono)] text-xs whitespace-nowrap"
      >
        {crumbs.map((a) => (
          <span key={a.id} className="flex shrink-0 items-center">
            <button
              onClick={() => onGo(a.id)}
              onMouseEnter={() => onHover(a.id)}
              onMouseLeave={() => onHover(null)}
              className="shrink-0 rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {a.label}
            </button>
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/40" />
          </span>
        ))}
        <span className="shrink-0 rounded bg-secondary px-1 text-secondary-foreground">
          {selfLabel}
        </span>
      </div>
      {overflow && (
        <button onClick={() => nudge(1)} disabled={!canR} className={arrowCls} aria-label="右移">
          <ChevronRight className="size-3.5" />
        </button>
      )}
    </div>
  );
}

// ───────────────────────────── 主组件 ─────────────────────────────

/** 详情区高度（拖拽调整,持久化）；其下结构树占满剩余。 */
const DETAIL_KEY = 'rd-inspector-detail-h';
const DETAIL_MIN = 120;

export function DomInspector({
  api,
  selectedId,
  onSelect,
  onHover,
  tick,
}: {
  api: InspectApi;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onHover: (id: number | null) => void;
  /** 父组件周期性自增,触发从 live DOM 重读（盒模型/样式/树随页面变更刷新）。 */
  tick: number;
}) {
  const doc = api.getDoc();
  const win = api.getWin();
  const rootEl = doc?.documentElement ?? null;
  const sel = selectedId != null ? (api.getNode(selectedId) as Element | null) : null;

  // 详情|结构树 的拖拽分隔（详情区高度,持久化）。
  const rootRef = useRef<HTMLDivElement>(null);
  const [detailH, setDetailH] = useState(() => {
    const v = Number(localStorage.getItem(DETAIL_KEY));
    return v >= DETAIL_MIN ? v : 240;
  });
  useEffect(() => {
    try {
      localStorage.setItem(DETAIL_KEY, String(detailH));
    } catch {
      /* 忽略写盘失败 */
    }
  }, [detailH]);
  const startDragDetail = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      setDetailH(Math.max(DETAIL_MIN, Math.min(ev.clientY - rect.top, rect.height - DETAIL_MIN)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // 结构树展开集（按 rrweb id）。选中变化时自动展开到选中节点的整条路径。
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  // 首次拿到画面时默认展开根路径（html→body→其首个元素子）,让常驻结构树一上来就有内容可点。
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !rootEl) return;
    const ids: number[] = [];
    let n: Element | null = rootEl;
    for (let d = 0; n && d < 3; d++) {
      const id = api.getId(n);
      if (id >= 1) ids.push(id);
      n = (Array.from(n.children).find((c) => api.getId(c) >= 1) as Element) || null;
    }
    if (ids.length) {
      seededRef.current = true;
      setExpanded((prev) => {
        const next = new Set(prev);
        ids.forEach((i) => next.add(i));
        return next;
      });
    }
  }, [rootEl, api, tick]);
  useEffect(() => {
    if (selectedId == null) return;
    const node = api.getNode(selectedId) as Element | null;
    if (!node) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (let p = node.parentElement; p; p = p.parentElement) {
        const id = api.getId(p);
        if (id >= 1 && !next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedId, api, tick]);

  const onToggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // 选中节点的详情（render 期现读 live DOM；tick 变化触发刷新）。
  const detail = useMemo(() => {
    if (!sel || !win || !doc) return null;
    const styles = readStyles(win, sel);
    const diag = diagnose(win, doc, sel);
    const crumbs: { id: number; label: string }[] = [];
    for (let p = sel.parentElement; p; p = p.parentElement) {
      const id = api.getId(p);
      if (id >= 1) crumbs.unshift({ id, label: labelOf(p) });
    }
    const rest = Object.fromEntries(Object.entries(styles).filter(([k]) => !BOX_KEYS.has(k)));
    return { styles, diag, crumbs, rest, selfLabel: labelOf(sel) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, win, doc, api, tick]);

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      {/* 上：选中节点详情（高度可拖拽）。仅纵向滚动,横向溢出交给节点路径自身的左右箭头处理。 */}
      <div
        style={{ height: detailH }}
        className="rd-scroll shrink-0 overflow-x-hidden overflow-y-auto p-3"
      >
        {!sel || !detail ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
            {selectedId == null
              ? '在右下结构树里点选节点,或开「画面点选」后在镜像上点选元素 → 这里显示盒模型/样式/诊断。'
              : '该节点已不在当前画面（可能已被移除或随重建更替）。'}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <NodePath
                crumbs={detail.crumbs}
                selfLabel={detail.selfLabel}
                onGo={onSelect}
                onHover={onHover}
              />
              <CopyButton
                value={JSON.stringify(detail.styles, null, 2)}
                label="复制全部计算样式"
                className="shrink-0"
              />
            </div>

            <DiagBadges diag={detail.diag} />

            {/* 盒模型 + 其它计算样式：均居中、无子标题;空间足够时并排,不够则换行各自居中。 */}
            <div className="flex flex-wrap items-start justify-center gap-x-8 gap-y-4">
              <BoxModel styles={detail.styles} />
              <div className="grid grid-cols-[minmax(5rem,auto)_auto] gap-x-3 gap-y-1 font-[family-name:var(--rd-mono)] text-xs">
                {Object.entries(detail.rest).map(([k, v]) => (
                  <div key={k} className="contents">
                    <span className="break-all text-muted-foreground">{k}</span>
                    <span className="break-all text-foreground">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 拖拽分隔条：调整详情|结构树 高度。常态细线,悬停柔和淡入圆角高亮轴（命中区更高,易抓）。 */}
      <div
        onPointerDown={startDragDetail}
        title="拖动调整高度"
        className="group relative z-20 h-px shrink-0 cursor-row-resize bg-border"
      >
        <span className="absolute inset-x-0 -top-1 -bottom-1" />
        <span className="pointer-events-none absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-[var(--primary)] opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100" />
      </div>

      {/* 下：实时结构树（从 html 根渗透,懒展开）——去掉标题,整块空间交给节点树。 */}
      <div className="rd-scroll min-h-0 flex-1 overflow-auto p-1.5">
        {rootEl ? (
          <TreeRow
            el={rootEl}
            depth={0}
            api={api}
            selectedId={selectedId}
            expanded={expanded}
            onToggle={onToggle}
            onSelect={onSelect}
            onHover={onHover}
          />
        ) : (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">等待镜像画面…</div>
        )}
      </div>
    </div>
  );
}
