/**
 * 极简 JS 语法高亮（零依赖）：把代码切成注释/字符串/数字/关键字/字面量/普通文本，
 * 各上色。用于脚本弹窗里「透明 textarea 叠高亮层」的底层渲染。只为可读，不做完整解析。
 */
import { type ReactNode } from 'react';

const KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'new',
  'typeof',
  'instanceof',
  'in',
  'of',
  'await',
  'async',
  'class',
  'extends',
  'super',
  'this',
  'void',
  'delete',
  'yield',
  'try',
  'catch',
  'finally',
  'throw',
  'import',
  'export',
  'default',
  'from',
  'as',
]);
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

// 注释 | 字符串(含模板) | 数字 | 标识符
const RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b0[xX][\da-fA-F]+\b|\b\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)/g;

/** 把 JS 源码渲染成带高亮的 ReactNode 序列（保留所有空白，供 <pre> 呈现）。 */
export function highlightJs(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  RE.lastIndex = 0;
  while ((m = RE.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const [full, comment, str, num, ident] = m;
    if (comment) {
      out.push(
        <span key={key++} className="text-muted-foreground/60 italic">
          {comment}
        </span>,
      );
    } else if (str) {
      out.push(
        <span key={key++} className="text-emerald-400">
          {str}
        </span>,
      );
    } else if (num) {
      out.push(
        <span key={key++} className="text-sky-400">
          {num}
        </span>,
      );
    } else if (ident) {
      if (KEYWORDS.has(ident))
        out.push(
          <span key={key++} className="text-violet-400">
            {ident}
          </span>,
        );
      else if (LITERALS.has(ident))
        out.push(
          <span key={key++} className="text-amber-400">
            {ident}
          </span>,
        );
      else out.push(ident);
    }
    last = m.index + full.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}
