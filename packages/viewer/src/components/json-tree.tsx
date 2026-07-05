/**
 * 极简可折叠 JSON 树：用于 Console 里 eval 返回的对象/数组（远程联调常要看 window.__TENANT__ 这类结构）。
 * 零依赖、递归渲染；对象/数组默认展开首层、深层折叠。叶子按类型着色（类 DevTools）。
 */
import { useState, type ReactNode } from 'react';
import { cn } from '../ui';

/** 尝试把字符串解析成 JSON；仅当结果是对象/数组（值得树展开）时返回，否则 null。 */
export function tryParseStructured(value: string): unknown | null {
  const s = value.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function Leaf({ value }: { value: unknown }) {
  if (value === null) return <span className="text-muted-foreground">null</span>;
  switch (typeof value) {
    case 'number':
    case 'bigint':
      return <span className="text-sky-400">{String(value)}</span>;
    case 'boolean':
      return <span className="text-violet-400">{String(value)}</span>;
    case 'string':
      return <span className="text-emerald-400 break-all">"{value}"</span>;
    default:
      return <span className="break-all">{String(value)}</span>;
  }
}

function Node({ k, value, depth }: { k: string | null; value: unknown; depth: number }) {
  const isObj = value !== null && typeof value === 'object';
  const [open, setOpen] = useState(depth < 1);

  const keyLabel =
    k === null ? null : <span className="text-muted-foreground">{k}</span>;

  if (!isObj) {
    return (
      <div className="flex gap-1.5 pl-[var(--indent)]" style={{ ['--indent' as string]: `${depth * 12}px` }}>
        {keyLabel}
        {keyLabel && <span className="text-muted-foreground/50">:</span>}
        <Leaf value={value} />
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const brace = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  const summary = Array.isArray(value) ? `${entries.length} 项` : `${entries.length} 键`;

  return (
    <div style={{ ['--indent' as string]: `${depth * 12}px` }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 pl-[var(--indent)] text-left hover:bg-accent/30"
      >
        <span className="w-3 shrink-0 text-muted-foreground/60">{open ? '▾' : '▸'}</span>
        {keyLabel}
        {keyLabel && <span className="text-muted-foreground/50">:</span>}
        <span className="text-muted-foreground/60">
          {brace[0]}
          {!open && ` ${summary} `}
          {!open && brace[1]}
        </span>
      </button>
      {open && (
        <div>
          {entries.map(([ek, ev]) => (
            <Node key={ek} k={ek} value={ev} depth={depth + 1} />
          ))}
          <div className="pl-[var(--indent)] text-muted-foreground/60" style={{ ['--indent' as string]: `${depth * 12}px` }}>
            {brace[1]}
          </div>
        </div>
      )}
    </div>
  );
}

/** 渲染一棵 JSON 树。`value` 是已解析的对象/数组。 */
export function JsonTree({ value, className }: { value: unknown; className?: string }): ReactNode {
  return (
    <div className={cn('font-[family-name:var(--rd-mono)] text-xs leading-relaxed', className)}>
      <Node k={null} value={value} depth={0} />
    </div>
  );
}
