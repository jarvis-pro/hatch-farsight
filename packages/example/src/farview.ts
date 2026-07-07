// agent 引导：仅当 URL 带 ?debug= 时懒加载并启动。
//
// 关键：这里用 `import type`（编译期擦除，不进产物），运行时才 `await import()`
// 拉真正的 agent。这样保留 README 的真实语义——正常用户（无 ?debug=）永不下载
// agent chunk，同时又能拿到完整 TS 类型。
import type { FarviewOptions } from '@farview/agent';

/** 演示用业务码表：HTTP 200 但 code≠0 时，viewer 的 Network 面板据此标红。 */
const BUSINESS_CODES: Record<number, string> = {
  1001: '未登录',
  1002: '无权限',
};

const options: FarviewOptions = {
  decodeBusinessCode: (code) => (code === 0 ? '成功' : (BUSINESS_CODES[code] ?? `业务码 ${code}`)),
  // 环境快照的业务补充（真实项目里密钥须自行剥离后再返回）
  buildSnapshot: () => ({ tenant: 'e2e-tenant', theme: 'light' }),
};

/**
 * 若 URL 带 ?debug=<隧道子域名> 则懒加载启动 agent。
 * @returns 供页面显示的状态文案。
 */
export async function bootstrapFarview(): Promise<string> {
  const token = new URLSearchParams(location.search).get('debug');
  if (!token) {
    return '未加载（安全：无 ?debug= 时 agent 完全不下载、不连接）';
  }
  const { startFarview } = await import('@farview/agent'); // 独立 chunk
  startFarview(token, options);
  return `已加载并连接：${token}`;
}
