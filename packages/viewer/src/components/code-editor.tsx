/**
 * 带 JS 语法高亮的多行代码编辑器：透明 textarea 叠在高亮 <pre> 之上，滚动同步。
 * 自身不处理快捷键/历史，按键交给 onKeyDown 由调用方决定（运行 / 翻历史等）。
 */
import { useRef, type KeyboardEvent } from 'react';
import { cn } from '../ui';
import { highlightJs } from '../lib/js-highlight';

export function CodeEditor({
  value,
  onChange,
  onKeyDown,
  autoFocus,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const sync = () => {
    if (preRef.current && taRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded border border-input bg-muted/30 font-[family-name:var(--rd-mono)] text-xs leading-relaxed',
        className,
      )}
    >
      <pre
        ref={preRef}
        aria-hidden
        className="rd-scroll pointer-events-none absolute inset-0 m-0 overflow-auto p-3 font-[family-name:var(--rd-mono)] break-words whitespace-pre-wrap text-foreground"
      >
        {highlightJs(value)}
        {'\n'}
      </pre>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={sync}
        onKeyDown={onKeyDown}
        autoFocus={autoFocus}
        placeholder={placeholder}
        spellCheck={false}
        className="rd-scroll absolute inset-0 resize-none overflow-auto bg-transparent p-3 font-[family-name:var(--rd-mono)] break-words whitespace-pre-wrap text-transparent caret-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
