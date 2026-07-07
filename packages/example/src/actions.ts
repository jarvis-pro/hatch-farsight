// 各类可观测行为触发器，按 index.html 里按钮的 data-act 键索引。
// 点一下就在 viewer 对应面板（Console / Network / 镜像）产生一条记录。

type Action = () => void;

export const actions: Record<string, Action> = {
  // --- Console / 报错 ---
  log: () => console.log('[e2e] 普通日志', { ts: Date.now(), items: [1, 2, 3] }),
  warn: () => console.warn('[e2e] 警告一下'),
  error: () => console.error('[e2e] 错误日志', new Error('demo error')),
  throw: () => {
    // 未捕获异常，验证 error hook
    setTimeout(() => {
      throw new Error('[e2e] 未捕获的运行时异常');
    }, 0);
  },

  // --- Network ---
  'fetch-ok': () => {
    void fetch('https://jsonplaceholder.typicode.com/todos/1')
      .then((r) => r.json())
      .then((d) => console.log('[e2e] fetch ok', d));
  },
  'fetch-404': () => {
    void fetch('https://jsonplaceholder.typicode.com/nope-404').then((r) =>
      console.log('[e2e] fetch status', r.status),
    );
  },
  'fetch-fail': () => {
    // 指向一个连不上的地址，验证网络失败上报
    void fetch('https://127.0.0.1:1/nope').catch((err: unknown) =>
      console.log('[e2e] fetch failed', err instanceof Error ? err.message : err),
    );
  },

  // --- 镜像实时性 ---
  mutate: () => {
    const tag = document.createElement('div');
    tag.textContent = `镜像测试块 @ ${new Date().toLocaleTimeString()}`;
    tag.style.cssText = 'margin:8px 0;padding:8px;background:#e0f2fe;border-radius:8px;';
    document.body.appendChild(tag);
  },
};
