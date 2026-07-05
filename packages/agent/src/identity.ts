import { state } from './state';

/** 每页签的稳定身份码持久化键（sessionStorage：每标签独立、刷新不变）。 */
const CODE_KEY = 'rd-agent-code';

/**
 * 取（或首次生成）本页签的身份码。存 sessionStorage——它**每标签独立、且刷新后保留**，恰好
 * 表达「这一个页签」：同标签重连/刷新码不变（relay 据此 resume），新开标签则得新码。
 * 4 位、去掉易混字符（0/O/1/I/L），够区分一台机器上的几个调试页签。
 */
export function ensureCode(): string {
  if (state.agentCode) return state.agentCode;
  try {
    const saved = sessionStorage.getItem(CODE_KEY);
    if (saved) return (state.agentCode = saved);
  } catch {
    /* 隐私模式：退化为内存内一次性码 */
  }
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = '';
  try {
    const r = new Uint8Array(4);
    crypto.getRandomValues(r);
    for (const n of r) c += ALPHABET[n % ALPHABET.length];
  } catch {
    for (let i = 0; i < 4; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  state.agentCode = c;
  try {
    sessionStorage.setItem(CODE_KEY, c);
  } catch {
    /* ignore */
  }
  return c;
}
