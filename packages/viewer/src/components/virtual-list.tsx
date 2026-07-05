/**
 * 通用虚拟化列表：只渲染视口内的行，扛得住上千条日志。行高动态测量（支持展开/换行）。
 *
 * 不自动滚动：新行只追加、绝不拽动视口。离底期间累计新行数，浮出「N 条新 ↓」按钮供**手动**回底；
 * 滚回底部即清零隐藏。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';

/** 距底多少像素以内算「贴底」。 */
const STICK_THRESHOLD = 40;

interface VirtualListProps<T> {
  items: T[];
  estimateSize?: number;
  renderItem: (item: T) => ReactNode;
  empty?: ReactNode;
}

export function VirtualList<T extends { id: number }>({
  items,
  estimateSize = 26,
  renderItem,
  empty,
}: VirtualListProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan: 12,
    getItemKey: (i) => items[i].id,
  });

  // 用户是否贴在底部（决定是否自动跟随）。初始视为贴底。
  const stuckRef = useRef(true);
  const [stuck, setStuck] = useState(true);
  // 离底期间累积的新行数，用于回底按钮上的计数。
  const [behind, setBehind] = useState(0);

  const scrollToBottom = useCallback(() => {
    if (items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
  }, [items.length, virtualizer]);

  const onScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
    stuckRef.current = atBottom;
    setStuck(atBottom);
    if (atBottom) setBehind(0);
  }, []);

  // 新行到达：不自动滚动，只累计「落后」计数（贴底时按钮本就隐藏，计数不显示）。
  const lastLen = useRef(0);
  useEffect(() => {
    const grew = items.length - lastLen.current;
    if (grew > 0) setBehind((n) => n + grew);
    // 列表被清空/过滤变短时重置计数
    if (items.length < lastLen.current) setBehind(0);
    lastLen.current = items.length;
  }, [items.length]);

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {empty ?? '暂无数据'}
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <div ref={parentRef} onScroll={onScroll} className="rd-scroll h-full overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map((vi) => (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {renderItem(items[vi.index])}
            </div>
          ))}
        </div>
      </div>

      {!stuck && (
        <button
          onClick={() => {
            scrollToBottom();
            stuckRef.current = true;
            setStuck(true);
            setBehind(0);
          }}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card/95 px-3 py-1 text-xs font-medium shadow-md backdrop-blur transition-colors hover:bg-accent"
        >
          <ArrowDown className="size-3.5" />
          {behind > 0 ? `${behind > 999 ? '999+' : behind} 条新` : '回到底部'}
        </button>
      )}
    </div>
  );
}
