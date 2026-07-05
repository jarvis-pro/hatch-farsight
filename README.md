# Farsight

> **Debug where they are.**

现代最小化远程联调工具（weinre 思路的现代实现）：在你自己屏幕上实时看见远端用户
此刻所见的 **console / network / 报错 / 环境快照 / 画面镜像**，并能在其页面执行 JS。
没有断点/单步，但线上临时排障需要的都有。

```
用户页面 (agent)  ──wss──▶  Cloudflare 隧道  ──▶  你本地 relay  ◀──ws──  viewer (你的浏览器)
   ?debug=xxx          随机地址、用完即失效        Ctrl-C 即死        localhost:9229
```

<!-- TODO: 镜像演示 GIF -->

## 快速开始

**前置（一次性）**：`brew install cloudflared`（未装也能跑，只是要自己想办法暴露中继）。

### 联调工程师侧：起中继

```bash
npx @farsight/cli        # 发布到 npm 后
# 仓库内（未发布前）：
pnpm start               # 或 node packages/cli/bin.mjs
```

自动完成：本地 relay（默认 `:9229`）+ 伺服 viewer + 拉起 Cloudflare quick tunnel，
醒目打印隧道**子域名**。然后：

1. 浏览器开 **`http://localhost:9229/`**（viewer，始终走本地、不经隧道）；
2. 给用户发链接：`https://<用户页面域名>/?debug=<子域名>`；
3. 用户打开后，viewer 顶部下拉出现该页签（4 位身份码），选中即实时收看。

环境开关：`PORT=9300` 换端口；`FARSIGHT_NO_TUNNEL=1` 跳过自动隧道（自行
`cloudflared tunnel --url http://localhost:9229`）。

### 被联调的项目侧：接入 agent

```bash
pnpm add @farsight/agent
```

```ts
// 仅当 URL 带 ?debug= 时懒加载（独立 chunk，正常用户永不下载、不含密钥）
const debugToken = new URLSearchParams(location.search).get('debug');
if (debugToken) {
  void import('@farsight/agent').then((m) => m.startFarsight(debugToken));
}
```

**业务适配（可选注入，agent 本体零业务依赖）**：

```ts
import { startFarsight } from '@farsight/agent';

startFarsight(token, {
  // 后端响应 JSON {code,message} 时，把「HTTP 200 但 code≠0」映射成可读错误名标红；
  // 不传则只显示 HTTP status。code===0 也会经过本函数（自行返回如「成功」）。
  decodeBusinessCode: (code) => (code === 0 ? '成功' : (myErrorTable[code] ?? `码 ${code}`)),
  // 环境快照的业务补充（如解析后的租户/主题）；密钥必须自行剥离后再返回。
  buildSnapshot: () => ({ tenant: safeTenantInfo() }),
});
```

## viewer 能看什么

全局动作收进命令面板 ⌘K，快捷键 `1–5` 切面板：

- **Console / Network / Events**：实时日志、网络（含业务码解码标红）、用户行为时间线
  （点击选择器 / 输入**只记字段+长度** / hash/路由 / 可见性 / 在线离线）。
- **环境**：环境快照 + 基线 diff——业务注入（租户/主题）、`:root` 计算出的 CSS 变量、
  local/sessionStorage、cookie、设备(UA/视口/DPR/在线)与 URL，逐键高亮变化。
  专治「配置解析错 / 设备分支走错 / 换肤失败」。
- **镜像**：rrweb 矢量流实时重建用户**当下画面**（非截图）；开「检视」后悬停高亮、点击选中,
  右侧就地看盒模型/计算样式/诊断(可见/可点/被谁遮挡)/结构树——全本地读回放 iframe,
  零回程、不触碰用户页面。顶部显示往返延迟与帧率。
- **eval**：在用户页面全局作用域执行 JS（只作用于加载 agent 的那个用户自己的页面）。

## 安全与隐私模型

- **零托管 server**：没有任何 24h 常驻服务。relay 跑在联调工程师本地，用完 `Ctrl-C`
  即死，隧道地址当场失效。**临时性即门禁**——绝不做常驻托管 relay。
- **门禁** = Cloudflare 随机隧道地址不可猜 + relay 只在联调期间存活。
- **agent 不含密钥**、仅 `?debug=` 时懒加载；页面会出现**可见的脉冲红点悬浮球**
  （显示身份码），用户可拖动避让、**点击即主动退出联调**。
- **输入默认打码**：行为时间线只记字段与长度；镜像 `maskAllInputs`，敏感区可加
  `.rd-block`（整块屏蔽）/ `.rd-mask`（文本打码）。
- viewer 只对本地 Host 伺服；经隧道的公网访问只返回健康文本，不暴露 UI。

## 仓库结构

```
packages/
  protocol/   @farsight/protocol —— 线协议单一真相源（纯类型、零运行时）
  agent/      @farsight/agent    —— 可发布 agent，零业务依赖（业务靠 FarsightOptions 注入）
  viewer/     @farsight/viewer   —— React 迷你 DevTools，构建为单个自包含 HTML（不单独发布）
  cli/        @farsight/cli      —— relay + 内嵌 viewer 单文件 + 自动隧道；bin 命令 `farsight`
docs/
  migration-plan.md   从 prod-landing-web 独立出来的迁移方案与架构决策
  viewer-design.md    viewer 的交互/架构设计
```

```bash
pnpm install && pnpm build   # protocol → agent → viewer → cli（内嵌 viewer.html）
pnpm typecheck
pnpm start                   # 起 relay（含隧道）
pnpm dev:viewer              # 迭代 viewer 本身：HMR，连本地 relay
```

> `packages/cli/viewer.html` 是**有意提交**的构建产物：让
> `npx github:<org>/hatch-farsight` 与 fresh clone 免构建即可跑。改动 viewer 后
> 记得 `pnpm build` 刷新它。

## 发布（待办）

- npm 上 `farsight` 包名已被占用 → CLI 走 scope：`@farsight/cli`（bin 命令仍是 `farsight`）。
- 需在 npmjs.com 建 org `farsight`（公开包免费）后：`pnpm -r publish --access public`。
- 发布 `@farsight/protocol`、`@farsight/agent`、`@farsight/cli`；viewer 不发布（已内嵌）。
- 发布后把消费方的 `file:` 依赖换成版本号（如 prod-landing-web 的 `@farsight/agent`）。
