# 远程联调（remote-debug）技术方案

> 线上特殊情况的临时排障工具：让你在**自己屏幕**实时看到某个真实用户落地页的
> console / network / 报错 / 行为，反向在其页面执行 JS、抓环境快照，
> 乃至**实时镜像**其画面（rrweb 矢量流回放）并就地**检视 DOM**（盒模型/样式/诊断/结构树）。
> 定位是 **weinre 思路的现代最小实现**——无断点/单步，但日志、网络、DOM、eval 都齐。
>
> 本文是**架构与实现说明**；具体操作步骤见同目录 [`README.md`](./README.md)。

---

## 1. 设计目标与约束

| 目标                                      | 落地方式                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| 排查只在**真实用户设备/网络**才复现的问题 | 反连式 agent，无需用户安装任何东西，只多一个 URL 参数                        |
| 正常用户**零成本**                        | agent 仅在 `?debug=` 出现时由 bootstrap 懒加载，独立 chunk，首屏不含         |
| **绝不泄密**                              | agent 不读任何密钥；快照剥离 `appKey/signKey`；密钥本就不进生产 bundle       |
| **零基础设施**                            | 中继零依赖（自带最小 WS 实现）、单文件 viewer、Cloudflare quick tunnel 暴露  |
| **不进生产**                              | 中继 / viewer 都在 `tools/`，仅 dev 存在；生产侧只有那一个懒加载 agent chunk |
| 协议**不漂移**                            | agent 与 viewer 共用一份纯类型协议包，改一处对齐两端                         |

安全模型刻意极简（「方案 B」）：**不设房间码、不做鉴权**。门禁 = 隧道随机公网地址不可猜
\+ 中继进程只在联调那几分钟存活，用完 `Ctrl-C` 地址当场失效。eval 也只能作用于加载它的
那个用户自己的页面（自残级别），无法横向影响他人。

---

## 2. 拓扑

```
┌─────────────────────────┐        wss (隧道)        ┌──────────────────────────┐
│  用户落地页 (生产 https)  │ ───────────────────────▶ │  Cloudflare quick tunnel  │
│  agent (懒加载 chunk)    │ ◀─────────────────────── │  *.trycloudflare.com      │
└─────────────────────────┘                          └────────────┬─────────────┘
        ▲  劫持 console/fetch/XHR/error/事件                       │  转发到本地
        │  反连 wss://<隧道>/?role=agent                            ▼
        │                                          ┌──────────────────────────────┐
        │                                          │  relay.mjs  (本地 :9229)        │
        │                                          │  零依赖 WS 中继 + 伺服 viewer    │
        │                                          └───────┬──────────────▲────────┘
        │                                     广播 agent 消息│              │ viewer 命令
        │                                                  ▼              │
        │                                          ┌──────────────────────────────┐
        └───────── eval/snapshot/mirror/ping ───── │  viewer (本地浏览器 :9229)      │
                   命令经 relay 透传回 agent          │  React 迷你 DevTools (单文件)    │
                                                   └──────────────────────────────┘
```

数据流：

- **agent → relay → viewer(s)**：日志 / 网络 / 报错 / 事件 / 快照 / 镜像帧(rrweb) / pong。
- **viewer → relay → agent**：`eval` / `snapshot` / `mirror`(开关镜像) / `ping`(延迟探针) 四种命令。
  （DOM 检视不再走命令——viewer 直接读镜像回放出的 iframe，零回程；截图功能已移除。）
- relay **不解析业务消息**，只做配对 / 广播 / 历史补发；唯一由它自行注入的是 `sys`（agent
  上下线提示）。

---

## 3. 组成模块

四个仓内单元，职责单一、边界清晰：

| 模块       | 路径                                     | 进生产?                | 职责                             |
| ---------- | ---------------------------------------- | ---------------------- | -------------------------------- |
| **协议**   | `packages/remote-debug-protocol`         | 否（纯类型，编译擦除） | 线协议单一真相源                 |
| **agent**  | `packages/app-shell/src/remote-debug.ts` | 是（独立懒加载 chunk） | 在用户页采集 + 执行命令          |
| **relay**  | `tools/remote-debug/relay.mjs`           | 否（dev-only）         | WS 中继 + 伺服 viewer + 历史补发 |
| **viewer** | `tools/remote-debug/` (React app)        | 否（dev-only）         | 迷你 DevTools UI                 |

### 3.1 协议包 `@landing/remote-debug-protocol`

- 纯 TypeScript 类型、**零运行时**（`exports` 直指 `src/index.ts`，编译后被擦除）。
- 历史上协议形状在 agent 的 `Outbound` 类型与 viewer 临时拼的 JS 两处各写一遍、易漂移；
  收敛到此处后，**改一处即对齐两端**。
- 三组类型：
  - `AgentMessage`（agent 发出）：`hello` / `log` / `net` / `err` / `eval-result` /
    `snapshot` / `event` / `rr`(镜像帧) / `pong`。
  - `SysMessage`（relay 注入）：`sys`，不经 agent。`IncomingMessage = AgentMessage | SysMessage`
    才是 viewer 实际会收到的全集。
  - `ViewerCommand`（viewer 下发）：`eval` / `snapshot` / `mirror` / `ping`。
- 业务码字段：`NetMessage` 带可选 `code`/`codeName`——后端响应是 JSON `{code,message}`，
  「HTTP 200 但 code≠0」即业务失败，这里把它一等公民化。

### 3.2 agent（生产侧懒加载模块）

入口 `startRemoteDebug(token)`，由 bootstrap 在 `getUrlStringParam('debug')` 命中时
`import('./remote-debug')` 拉起（[`bootstrap.tsx:42`](../../packages/app-shell/src/bootstrap.tsx)）：

```ts
const debugToken = getUrlStringParam('debug');
if (debugToken) {
  void import('./remote-debug').then((m) => m.startRemoteDebug(debugToken));
}
```

**token 解析**：`?debug=` 的值不含 `.` 时视为 Cloudflare quick tunnel 子域名，自动补
`.trycloudflare.com`；含 `.` 则当完整主机名原样使用（命名隧道 / 自定义域名）。最终连
`wss://<host>/?role=agent`。

**采集钩子**（全部包在 try/catch，任何异常都不得影响宿主落地页）：

| 钩子                 | 实现要点                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `installConsoleHook` | 包裹 `log/info/warn/error/debug`，转发后调用原函数（不吞日志）                                        |
| `installErrorHook`   | `window.error` + `unhandledrejection`，回传 message + stack                                           |
| `installNetworkHook` | 同时劫持 `fetch` 与 `XHR`；记录方法/URL/状态/耗时/响应片段                                            |
| `installEventHook`   | 用户行为时间线：click(选择器) / input(**只记字段+长度**) / hash / route / visibility / online-offline |

**响应业务码解码** `decodeCode`：在**截断前**对响应原文 `JSON.parse`，取 `code`，查
`@landing/errors` 的 `getErrorMessage` 映射为可读名（`code===0` → 「成功」）。fetch 走
`res.clone().text()` 避免消费正文；XHR 在 `loadend` 读 `responseText`。

**按命令触发的能力**（`handleCommand` 路由）：

- `eval`：间接 eval `(0, eval)(code)` 在全局作用域执行，结果经 `fmt` 安全序列化回传。
- `snapshot`：`buildSnapshot()` 汇总租户（**解构剥离 `appKey/signKey`**）、`:root` 计算出
  的全部 CSS 变量、location、device(UA/平台/语言/在线/视口/屏幕/DPR/可见性)、
  localStorage / sessionStorage / cookie。
- `mirror`：开/关 rrweb 录制（详见 §3.5）。
- `ping`：即时回 `pong{id}`，供 viewer 测往返延迟（不依赖两端时钟同步）。

> DOM 检视**不再是 agent 命令**：viewer 直接读镜像回放出的 iframe（盒模型/样式/诊断/结构树
> 全本地现算），零回程、且不触碰用户真实页面（旧 `inspect-at` 会把用户页滚到目标元素居中，扰民）。
> 截图能力（`screenshot`/`modern-screenshot`）已整体移除——镜像的连续矢量画面已覆盖其场景。

**流量与可读性控制**：单字段截断到 `MAX_FIELD = 2048`（URL 512）；`clip()` 标注被截掉的长度；
`fmt()` 处理 Error / 循环引用（`WeakSet`）/ bigint / function 等不可序列化值。

**连接管理**：`onopen` 发 `hello`（UA + URL）并清零重试；`onclose` 退避重连，最多
`MAX_RETRY = 5` 次、间隔 `1000 * retries` ms。`installed` 标志保证只装一次。

### 3.3 relay（零依赖本地中继）

`relay.mjs`，Node 原生模块（`http`/`crypto`/`fs`），**内置最小 WebSocket 服务端**，不引 `ws`：

- **HTTP 面**：仅对**本地 Host**（`localhost`/`127.0.0.1`/`[::1]`）在 `/`、`/viewer`、
  `/viewer.html` 伺服 viewer 构建产物 `dist/index.html`；经隧道的公网访问只返回健康文本，
  **不把 UI 暴露出去**。未构建时返回 503 + 可照做的构建提示。
- **WS 升级**：手算 `Sec-WebSocket-Accept`（SHA1(key + GUID) base64）完成握手；
  `Conn` 类自行解析客户端掩码帧、发送未掩码文本帧，处理分片、ping→pong、close。
- **配对（方案 B）**：按 `?role=` 区分。
  - **唯一 agent**：新 agent 连上替换旧的（页面只有一个），并清空历史（新会话）。
  - **多 viewer 共存**：`viewers` 是 `Set`，互不挤占。
- **历史补发**：当前 agent 会话的消息存进环形 `history`（上限 `HISTORY_MAX = 200`），
  viewer 后连上时逐条补发——解决「先开页面后开 viewer 就看不到」。
- **sys 注入**：agent 上下线时向所有 viewer 广播 `{t:'sys', message}`，是 relay 唯一自产的消息。

端口 `PORT`（默认 9229）。启动后提示下一步：`cloudflared tunnel --url http://localhost:9229`。

### 3.4 viewer（React 迷你 DevTools）

`@tools/remote-debug`，React 19 + `@landing/ui`（shadcn 风格） + Tailwind 4 + lucide 图标 +
`@tanstack/react-virtual`（长列表虚拟化）。

**构建为单文件**：`vite-plugin-singlefile` 把 JS/CSS 全部内联进自包含 `dist/index.html`，
relay 直接伺服它（无散落资源、无需静态服务器，沿用「开 localhost:9229」零依赖工作流）。
迭代 viewer 本身用 `pnpm --filter @tools/remote-debug dev` 走 HMR（端口 8307）连本地 relay。

**状态管理 `relay-store.ts`**——故意不用 `useState`：日志是高频流，每条触发整树重渲染会卡。

- 外部状态仓 + `useSyncExternalStore`；每次仅替换**受影响的那个数组引用**，其余切片保持同引用。
- 各面板用 `useSelector` 只订阅自己的切片，未变切片不重渲染。
- 各通道是**带上限的环形缓冲**（`CAP = 5000`），防长时间联调内存无限涨。
- 协议消息本身不带时间戳，由 viewer 收到时打 `id`/`time`（`stamp`）。
- `sys` 文案（在线/已连接/断开）反推 `agentOnline` 状态。

**连接 `use-relay.ts`**：封装 WS 生命周期（连接 / 断线自动重连 1.5s / 手动重连 / 下发命令）。
关键细节——被替换/卸载的旧 socket 先**摘掉自己的 `onclose`**，自动重连只认「当前活跃 socket」
（`wsRef.current === ws`）；否则 StrictMode 的挂载→卸载→挂载或任一次重连产生的「陈旧 socket」
迟到 `onclose` 会误触发重连，连环关掉好连接，形成每隔几秒断连的死循环。

**UI 结构**（`app.tsx`）：顶部栏 + 五个一级面板，全局动作收进命令面板（⌘K），脚本运行走弹窗。

- **顶部栏**：连接状态点 + agent 的 URL/UA + 中继地址输入框 + 命令面板入口 + 主题切换。
- **五个面板**：**Console / Network / Events**（高频流式，虚拟列表，可暂停自动滚动；Network
  对业务码 `code≠0` 标红）+ **环境**（快照 diff，结构化卡片 + 折叠分区）+ **镜像**（实时画面
  - DOM 检视，详见 §3.5）。快捷键 `1–5` 切面板、`⌘/Ctrl+K` 命令面板。
- **命令面板（⌘K）**：运行脚本（`eval`，弹窗）/ 环境快照 / 开关镜像 / 暂停自动滚动 /
  导出会话 JSON / 分通道清空 / 重连 / 断开。agent 不在线时相关项禁用。

### 3.5 实时镜像（rrweb）+ DOM 检视

「镜像」面板把用户页面 DOM 的**矢量流**实时重建在你屏幕上，并在同一面板内做 DOM 检视——
画面与检视合一，取代了旧的「截图 + DOM 审查」两个独立面板。

- **按需录制、独立子 chunk**：agent **默认不录**，仅当 viewer 显式下发 `{t:'mirror',on:true}`
  才懒加载 `@rrweb/record`（在 `?debug=` 的 10KB agent chunk 之外再分出 ~24KB(gz) 的 `record`
  chunk）。常规联调完全不下载 rrweb，守住「不影响宿主页面」。
- **隐私默认收紧**：`maskAllInputs`（绝不外发真实输入，与行为时间线「只记长度」同一克制）、
  密码类天然打码；敏感区可在页面元素加 `.rd-block`（整块屏蔽）/`.rd-mask`（文本打码）。
- **检查点协议**：镜像帧用 `MirrorMessage{t:'rr',kind,seq,ev}`，`kind` 仅供划检查点
  （`meta`=新全量快照起点 / `snap`=全量快照 / `incr`=增量），`ev` 是 rrweb 事件（协议包不引
  rrweb 类型、存为 `unknown` 以保零依赖）。agent 用 `checkoutEveryNms`（10s）周期性重拍全量快照。
- **relay 独立缓冲**：镜像帧高频且大，**不进** `history`（会被 200 上限挤掉、撑爆补发），改走
  独立 `mirror` 缓冲，按检查点维护（收 `meta` 即重置、其后追加）；viewer 后连入补发整段即可
  立即重建当前画面。relay 仅解析**信封** `t`/`kind`（先按子串快否决,不碰业务内容）。
- **viewer 回放**：镜像帧同样绕开持久化环形缓冲——`relay-store` 维护一份「当前检查点」事件序列
  供面板挂载时播种 `Replayer`，**不触发 React 重渲染**。三类事件分三条通道各取所长、互不抖动：
  鼠标(source 1/2)→自绘光标覆盖层直接定位；滚动(source 3)→直接滚对应元素/窗口；其余 DOM 变更→
  **双缓冲重建**（隐藏 root 里以极高 speed 一帧播完全部增量、渲染好再换上，无白闪/无可见快进）。
  回放 iframe 注入修正样式：禁用一切 CSS 过渡/动画（快进时间轴 vs 真实时间动画会打架闪现）、
  纠正 vaul 抽屉「打开态」transform。画面 contain 等比缩放贴合容器、整页始终完整可见（不滚动）。
- **DOM 检视（全本地读回放 iframe）**：开「检视」后,悬停镜像即高亮元素 + 标签、点击选中,
  右侧检查器现算盒模型/计算样式/诊断(可见/可点/被谁遮挡)/结构树——全部 `getComputedStyle` +
  `elementFromPoint` 读**重建出的回放 iframe**,零回程、不触碰用户页面。选中态用 **rrweb 节点 id**
  表达(非 Element 引用)：双缓冲每次换掉整个 iframe,Element 引用会失效,而 rrweb id 由录制端分配、
  跨重建稳定,故用 `getMirror().getNode(id)` 永远解析得回当前节点。
- **延迟/帧率**：viewer 每 1.5s `ping`、agent 即时 `pong`,据收发时差显示**往返延迟**(整条链路口径)；
  另显示每秒收到的镜像帧数(吞吐/活跃度)。
- **重连重播种**：agent 重连后 relay 已清空旧会话缓冲，agent 若在镜像会立即 `takeFullSnapshot`
  重拍一帧；agent 离线时 relay 丢弃镜像缓冲、viewer 熄灭画面，避免看到僵死画面。

---

## 4. 隧道选型

用 **Cloudflare quick tunnel（TryCloudflare）**：

- 无需登录账号；无 2 小时会话限制；无月流量上限；无拦截/警告页。
- 一次性安装：`brew install cloudflared`。
- `cloudflared tunnel --url http://localhost:9229` → 随机 `https://<子域名>.trycloudflare.com`。
- 自带 TLS：落地页是 https，agent 连 `wss://` 无 mixed-content 问题；viewer 本地连
  `ws://localhost` 也合法。

---

## 5. 安全与隐私

- **不读密钥**：agent 全程只转发日志；快照解构剥离 `appKey/signKey` 再外发。密钥本就只在
  dev 由虚拟模块注入，生产 bundle 不含——agent 即使想读也没有。
- **输入不外发内容**：行为时间线的 input 事件**只记字段选择器 + 值长度**，绝不回传用户实际输入。
- **eval 自残级别**：只作用于加载它的那个用户自己的页面，无法横向影响他人。
- **viewer 不公网暴露**：relay 只对本地 Host 伺服 UI，隧道侧只返回健康文本。
- **门禁靠不可猜 + 短命**：无房间码/鉴权，安全性来自隧道随机地址 + 进程只在联调期间存活；
  **别公开转发联调链接**。
- **栈可读性**：生产 `sourcemap: false`，转发的报错栈是压缩后的；要可读需另行开启 hidden
  sourcemap（不入 bundle）再做映射，超出本工具范围。

---

## 6. 典型工作流（速查）

```bash
# 1) 构建 viewer 单文件 + 起中继（默认 :9229）
pnpm remote-debug
#   = pnpm --filter @tools/remote-debug build && node tools/remote-debug/relay.mjs

# 2) 暴露到公网
cloudflared tunnel --url http://localhost:9229     # → https://<子域名>.trycloudflare.com

# 3) 本地打开 viewer
open http://localhost:9229/                         # 中继地址自动取同源

# 4) 拼用户链接（值=子域名，不含 .trycloudflare.com），转二维码 / Telegram 可点链接
#    https://<落地页域名>/?debug=<子域名>

# 5) 用户扫码/点击 → agent 自动懒加载反连 → viewer 实时显示
# 6) 排障完毕 Ctrl-C 关 relay 与 cloudflared → 公网地址失效，链接作废
```

---

## 7. 关键设计取舍小结

| 取舍         | 选择                                         | 理由                                                     |
| ------------ | -------------------------------------------- | -------------------------------------------------------- |
| 房间码 vs 无 | **无（方案 B）**                             | 一次只调一个用户，自动配对最省事；安全靠隧道随机地址兜底 |
| 协议在哪     | **独立纯类型包**                             | 双端共用，杜绝形状漂移                                   |
| viewer 形态  | **单文件 HTML**                              | relay 直接伺服，零静态服务器、零散落资源                 |
| WS 库        | **手写最小实现**                             | relay 零依赖，`node relay.mjs` 即可跑                    |
| 画面/检视    | **rrweb 矢量镜像 + 本地读回放 iframe**       | 连续画面取代单张截图；DOM 检视零回程、不触碰用户页面     |
| 状态管理     | **外部仓 + useSyncExternalStore + 环形缓冲** | 高频日志流不卡、内存有界                                 |
| 历史         | **relay 缓存当前会话补发**                   | 解决「先开页面后开 viewer」时序问题                      |
