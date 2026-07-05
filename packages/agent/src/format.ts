/** 透传字段的截断与安全序列化。 */

const MAX_FIELD = 2048; // 单字段最大透传字节，超出截断（控制流量 + 保持 viewer 可读）

/** 截断超长字符串，标注被截掉的长度，控制隧道流量并保持 viewer 可读。 */
export function clip(s: string, max = MAX_FIELD): string {
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max})` : s;
}

/** 安全序列化任意 console 参数（处理 Error / 循环引用 / 不可序列化值）。 */
export function fmt(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(a, (_k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      if (typeof v === 'bigint') return `${v}n`;
      if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
      return v;
    });
  } catch {
    return String(a);
  }
}
