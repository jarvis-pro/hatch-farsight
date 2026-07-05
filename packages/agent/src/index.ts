/**
 * Farview agent（按需懒加载，独立 chunk）。
 *
 * 仅当 URL 带 `?debug=<隧道子域名>` 时由宿主 bootstrap 动态 import，平时不进首屏、
 * 正常用户永不下载。劫持 console / fetch / XHR / 全局报错，反连到你本地经 Cloudflare
 * 隧道暴露的中继（见 @farview/cli 的 bin.mjs），你在 viewer 里实时看其控制台。
 *
 * 安全：本模块**不读取任何密钥**，只转发日志；eval 仅作用于加载它的那个用户自己的
 * 页面。门禁 = 隧道随机地址不可猜 + 中继只在联调期间存活。
 *
 * 零业务依赖：业务码解码 / 环境快照的业务补充均由宿主经 {@link FarviewOptions} 注入，
 * agent 本体不 import 任何具体项目的模块。
 *
 * 模块划分（本文件仅编排；各职责见对应文件）：
 *  · state    共享可变状态单例 + emit 出站原语
 *  · format   透传字段截断 / 安全序列化
 *  · identity 页签身份码
 *  · selector 元素可读选择器（行为时间线用）
 *  · snapshot 环境快照
 *  · hooks    console / network / error / event 探针
 *  · mirror   rrweb 实时镜像（懒加载子 chunk）
 *  · badge    角落悬浮球（身份码 + 退出联调）
 *  · transport 反连中继 + 命令处理
 */

import { installBadge } from './badge';
import {
  installConsoleHook,
  installErrorHook,
  installEventHook,
  installNetworkHook,
} from './hooks';
import { ensureCode } from './identity';
import { state } from './state';
import { connect } from './transport';
import type { FarviewOptions } from './types';

export type { FarviewOptions } from './types';

const TUNNEL_SUFFIX = '.trycloudflare.com';

/**
 * 启动 Farview agent。
 * @param token URL `?debug=` 的值：Cloudflare 隧道子域名（如 `able-modern-foo-bar`，
 *   自动补 `.trycloudflare.com`），或含点的完整主机名（如命名隧道 / 自定义域名）则原样使用。
 * @param opts 宿主项目的可选业务适配注入（见 {@link FarviewOptions}）；不传全走通用路径。
 */
export function startFarview(token: string, opts?: FarviewOptions): void {
  if (state.installed || !token) return;
  state.installed = true;
  state.options = opts ?? {};
  // 在装 console hook 前抓一份原生 warn：即便安装过程中途失败、
  // 或异常正出在 console hook 上，诊断信息也不会被 agent 自己劫持 / 吞掉。
  const warn = console.warn.bind(console);
  const host = token.includes('.') ? token : `${token}${TUNNEL_SUFFIX}`;
  try {
    installConsoleHook();
    installErrorHook();
    installNetworkHook();
    installEventHook();
    installBadge(ensureCode()); // 角落码徽标，对应 viewer 下拉里的本页签
    connect(host);
  } catch (err) {
    // agent 任何异常都不得影响宿主页面，但要留一条警告，别让联调静默失灵。
    warn('[farview] agent 启动失败，已停用（不影响页面）：', err);
  }
}
