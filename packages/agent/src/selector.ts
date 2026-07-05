import { clip } from './format';

/** 单个元素的简短 token：tag + id / [name] / 首两类 + 同类兄弟序号（撞脸时才补序号）。 */
function tokenOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`; // id 已足够唯一，直接返回
  const name = el.getAttribute('name');
  if (name) return `${tag}[name=${name}]`;
  const cls =
    typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
  let token = tag + cls;
  // 同一父级下「相同 tag + 相同 class」的兄弟超过一个时,补 :nth 以区分撞脸节点。
  const parent = el.parentElement;
  if (parent) {
    const twins = Array.from(parent.children).filter(
      (c) => c.tagName === el.tagName && c.className === el.className,
    );
    if (twins.length > 1) token += `:nth(${twins.indexOf(el) + 1})`;
  }
  return token;
}

/** 交互元素的可读标签：aria-label / 按钮·链接文本 / input 的 placeholder（绝不取 value）。 */
function labelOf(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return aria.trim();
  const tag = el.tagName.toLowerCase();
  if (tag === 'input')
    return el.getAttribute('placeholder')?.trim() || `[${el.getAttribute('type') || 'text'}]`;
  if (/^(button|a|summary|label|option)$/.test(tag) || el.getAttribute('role') === 'button') {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

/**
 * 为元素生成可读且尽量唯一的选择器（用于行为时间线 / DOM 审查标注）。
 * 光一个 tag/class 很容易撞脸,故附上祖先路径（向上至多取到带 id 的锚点、最多 3 级）
 * 与交互文本标签——基本能一眼定位是哪个节点。文本仅取 UI 标签,非用户输入内容。
 */
export function selectorOf(el: EventTarget | null): string {
  if (!(el instanceof Element)) return '';
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && depth < 3; depth++) {
    parts.unshift(tokenOf(node));
    if (node.id) break; // 命中 id 锚点即停,上层路径无意义
    node = node.parentElement;
  }
  let sel = parts.join(' > ');
  const label = labelOf(el);
  if (label) sel += ` 「${clip(label, 40)}」`;
  return sel;
}
