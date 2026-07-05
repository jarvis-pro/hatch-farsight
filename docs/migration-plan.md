# Farsight 迁移与架构计划

> **Debug where they are.**
>
> 现代最小化远程联调工具（weinre 思路的现代实现）：在你自己屏幕上实时看见远端用户
> 此刻所见的 console / network / 报错 / 环境 / **画面镜像**，并能在其页面执行 JS。

本文件描述如何把远程联调工具从 `prod-landing-web` 独立成 `hatch-farsight`，供所有内部
项目共用。它既是**架构说明**，也是**分步迁移方案**。

**源实现位置**（`prod-landing-web`，本地路径 `/Users/hash/Documents/Work/Github/prod-landing-web`）：

| 模块     | 源路径                                   | 目标包               |
| -------- | ---------------------------------------- | -------------------- |
| agent    | `packages/app-shell/src/remote-debug.ts` | `@farsight/agent`    |
| viewer   | `tools/remote-debug/src/`                | `@farsight/viewer`   |
| protocol | `packages/remote-debug-protocol/`        | `@farsight/protocol` |
| relay    | `tools/remote-debug/relay.mjs`           | `farsight` (CLI)     |

---

## 目录

1. [核心设计原则](#1-核心设计原则不可动摇)
2. [两种消费方式](#2-两种消费方式)
3. [仓库结构](#3-仓库结构)
4. [关键改造：agent 解耦](#4-关键改造agent-解耦唯一硬阻塞)
5. [viewer 解耦](#5-viewer-解耦)
6. [CLI 化](#6-cli-化relaymjs--farsight-bin)
7. [发布](#7-发布)
8. [迁移步骤清单](#8-迁移步骤清单)
9. [附：命名决策](#附命名决策)

---

## 1. 核心设计原则（不可动摇）

1. **零托管 server**。没有任何 24h 常驻服务。relay 跑在联调工程师本地，用完 `Ctrl-C` 即死。
2. **临时性即门禁**。安全模型 = Cloudflare 随机隧道地址不可猜 + relay 只在联调期间存活。
   **绝不**做常驻托管 relay——那会引入持续攻击面、逼你补鉴权、并摧毁唯一门禁。
3. **agent 零业务依赖**。可发布的 agent 不得硬编码任何具体项目的模块（errors / tenant 等），
   一切业务适配靠**可选注入**。
4. **agent 绝不含密钥**。仅当 URL 带 `?debug=` 时懒加载、独立 chunk，正常用户永不下载。
5. **不做 landing 页、不做部署**。内部工具靠 README + 演示 GIF 即可；landing 页仅在未来
   开源为通用工具时才有 ROI。

---

## 2. 两种消费方式

替代「clone 整个仓库」的两条路径，职责清晰、代码永不过期：

| 角色             | 用法                       | 说明                                                                                                                                                                            |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **联调工程师**   | `npx farsight`             | 起本地 relay + 单文件 viewer + 自动 Cloudflare 隧道，打印 `?debug=` 链接。零 clone、零安装、永远最新，跑完不留垃圾。也可 `npx github:<org>/hatch-farsight`，连 npm 都不发就跑。 |
| **被联调的项目** | `pnpm add @farsight/agent` | `?debug=` 触发时懒加载、独立 chunk，正常用户不下载。                                                                                                                            |

---

## 3. 仓库结构

pnpm + workspace monorepo。仓库目录名用 `hatch-` 前缀（内部工具孵化系列）：**hatch-farsight**；
npm 命名空间为 `@farsight/*`，CLI 命令为 `farsight`。

```
hatch-farsight/
  package.json                 私有根，workspaces + 脚本
  pnpm-workspace.yaml
  README.md                    面向使用者的文档（含镜像演示 GIF）
  docs/
    migration-plan.md          本文件
  packages/
    protocol/                  @farsight/protocol —— 纯类型、零运行时线协议（单一真相源）
      package.json
      src/index.ts
    agent/                     @farsight/agent —— 可发布 agent，零业务依赖
      package.json
      src/index.ts             startFarsight(token, options?)
    viewer/                    @farsight/viewer —— React 迷你 DevTools，vite-plugin-singlefile 打单文件
      package.json
      vite.config.ts
      src/...
    cli/                       farsight —— relay + 内嵌 viewer 单文件 + 自动隧道，npx 入口
      package.json             "bin": { "farsight": "./bin.mjs" }
      bin.mjs                  = 现 relay.mjs 演进版
```

**发布到 npm 的包**：`@farsight/protocol`、`@farsight/agent`、`farsight`(CLI)。
`@farsight/viewer` 不单独发布——其单文件产物在构建时内嵌进 CLI 包。

---

## 4. 关键改造：agent 解耦（唯一硬阻塞）

现 agent（`prod-landing-web` 的 `remote-debug.ts:12-13`）硬编码依赖本项目模块：

```ts
import { getErrorMessage } from '@landing/errors'; // 业务错误码映射
import { resolveTenant } from '@landing/tenant'; // 租户/主题解析
```

> 现导出的函数名为 `startRemoteDebug`，独立后重命名为 `startFarsight`。

独立后必须改为**可选注入**，让 agent 保持零业务依赖：

```ts
export interface FarsightOptions {
  /** 业务码 → 可读名。响应 JSON `{code,message}` 时用于把「200 但 code≠0」标红。
   *  不传 → 只显示 HTTP status，不做业务码解码。 */
  decodeBusinessCode?: (code: number) => string;
  /** 环境快照的业务补充（如解析后的租户/主题，密钥须自行剥离）。
   *  不传 → 快照只含通用部分：storage / device / URL / CSS 变量。 */
  buildSnapshot?: () => Record<string, unknown>;
}

export function startFarsight(token: string, options?: FarsightOptions): void;
```

改造要点：

- **通用能力直接搬**：console / network / error / event hook、rrweb 镜像、悬浮角标、身份码、
  CSS 变量采集、storage / device 快照——全部与业务无关。
- `decodeCode()` 改为调用 `options.decodeBusinessCode`，缺省则跳过业务码解码。
- `buildSnapshot()` 拆成「通用快照」+ `options.buildSnapshot?.()` 合并。

**消费方（如 prod-landing-web）** 再写一层薄适配把业务模块挂回去：

```ts
// prod-landing-web 侧
import { startFarsight } from '@farsight/agent';
import { getErrorMessage } from '@landing/errors';
import { resolveTenant } from '@landing/tenant';

startFarsight(token, {
  decodeBusinessCode: (code) => (code === 0 ? '成功' : getErrorMessage(code)),
  buildSnapshot: () => {
    const { appKey, signKey, ...safe } = resolveTenant(); // 剥离密钥
    return { tenant: safe };
  },
});
```

---

## 5. viewer 解耦

viewer 现依赖 `@landing/ui` + `@landing/errors`（协议已经由 `@landing/remote-debug-protocol`
共用，独立后换成 `@farsight/protocol`）。独立后：

- **`@landing/ui`**：内联一份最小 shadcn 风格组件（Farsight 自持一套 tokens.css），
  不把落地页 UI 包拖出来。
- **`@landing/errors`**：viewer 里的业务码映射改为「viewer 端可配置的码表」，或由 agent 快照
  回传已解析的 `codeName`（agent 侧已有 `decodeBusinessCode`，viewer 直接显示即可），
  避免 viewer 依赖具体项目错误码表。

---

## 6. CLI 化（relay.mjs → farsight bin）

现 `relay.mjs` 已做到：零依赖 WS 中继 + 伺服 viewer 单文件 + 自动拉起 cloudflared +
打印 `?debug=` 片段 + agent↔viewer 自动配对。独立后基本沿用，改动点：

- 作为 npm 包的 `bin`，`npx farsight` 直接跑。
- viewer 单文件在 CLI 包发布前构建并内嵌（`packages/cli` 依赖 `@farsight/viewer` 的构建产物）。
- 保留环境开关，`RD_NO_TUNNEL=1` 更名为 `FARSIGHT_NO_TUNNEL`。
- 未装 cloudflared 时提示 `brew install cloudflared`，relay 仍照常运行。

**前置依赖**（一次性）：`brew install cloudflared`。

---

## 7. 发布

- `@farsight/protocol`、`@farsight/agent`：**公开** npm 包（零密钥，公开无风险）。
- `farsight`(CLI)：公开 npm 包；或 `npx github:<org>/hatch-farsight` 免发布直接跑。
- scope `@farsight` 需在 npm 建同名 org（发公开包免费）。
- 公开包免费、无数量限制；私有包才收费（约 $7/人/月），本工具无需私有。

---

## 8. 迁移步骤清单

- [ ] 初始化 monorepo 骨架（pnpm-workspace、根 package.json、tsconfig）
- [ ] 搬 `protocol` → `@farsight/protocol`（纯类型，几乎原样）
- [ ] 搬 + 解耦 agent → `@farsight/agent`（引入 `FarsightOptions`，去掉 errors / tenant 硬依赖，`startRemoteDebug` → `startFarsight`）
- [ ] 搬 + 解耦 viewer → `@farsight/viewer`（内联 UI，去掉 `@landing/*` 依赖）
- [ ] 搬 relay → `packages/cli`，改为 `bin`，重命名环境变量
- [ ] 写 README（使用文档 + 镜像演示 GIF + 安全模型说明）
- [ ] 发布 `@farsight/protocol` + `@farsight/agent` + `farsight` 到公开 npm
- [ ] **回接 prod-landing-web**：删除 `tools/remote-debug` 与 `packages/remote-debug-protocol`，
      `packages/app-shell` 改依赖 `@farsight/agent` 并写业务适配层（`decodeBusinessCode` / `buildSnapshot`）
- [ ] 验证：`npx farsight` 起隧道 → 落地页带 `?debug=` → viewer 实时显示

---

## 附：命名决策

**Farsight** — slogan _Debug where they are._
一语双关（远程 + 用户真实环境）。清晰压倒聪明，团队秒懂；Logo 走望远镜 / 同心圆雷达意象。
