#!/usr/bin/env node
// @ts-check
/**
 * Farsight 中继（dev-only，绝不进生产）。
 *
 * 不设房间码：同一隧道下**多个 agent**（多设备/多标签的宿主页面）与**多个 viewer**
 * （你本地的迷你 DevTools）共存。门禁 = 隧道随机公网地址本身不可猜 + 进程只在联调
 * 那几分钟存活。用完 Ctrl-C，地址当场失效。
 *
 * 多路复用：每条 agent 连接分配一个短 id，relay 为其单独维护日志历史 + 镜像检查点缓冲。
 * 每个 viewer 一次只「收看」(watch) 一个 agent——relay 只把被看 agent 的帧转发给它；
 * 切换时先发 `reset` 清屏、再补发该 agent 的历史与镜像。agent 上下线/握手即广播 `agents`
 * 名册给所有 viewer。**关键：新 agent 不再踢掉旧 agent**（旧设计单槽位 + 双方自动重连
 * 会形成抢占战，viewer 镜像在多份 DOM 间反复重建而抽搐）。
 *
 * 用法：
 *   npx @farsight/cli                    # 默认 :9229，并自动起 Cloudflare 隧道
 *   PORT=9300 npx @farsight/cli
 *   FARSIGHT_NO_TUNNEL=1 npx @farsight/cli   # 跳过自动隧道，自行 cloudflared
 *   （仓库内开发：node packages/cli/bin.mjs 或 pnpm start）
 *
 * 中继启动后会**自动**拉起 `cloudflared tunnel --url http://localhost:PORT`（quick tunnel，
 * 无需登录），解析出随机子域名并醒目打印——直接拷给用户拼 `?debug=<子域名>`。Ctrl-C 一并
 * 关掉隧道，公网地址当场失效。
 *
 * 零依赖：内置最小 WebSocket 服务端（仅文本帧 + ping/close），不引 `ws`。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 9229);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// viewer 是 React 应用，构建为单个自包含 HTML（vite-plugin-singlefile），随本包发布、直接伺服。
// 缺失时给出提示（仓库内开发场景：先跑 pnpm build）。
const VIEWER_PATH = new URL('./viewer.html', import.meta.url);

/**
 * @typedef {Object} Agent
 * @property {Conn} conn      该 agent 的连接
 * @property {string} id      relay 分配的短 id
 * @property {string} ua      握手回传的 UA（未握手前空串）
 * @property {string} url     握手回传的页面 URL（未握手前空串）
 * @property {string[]} history  该 agent 的日志历史（viewer 切入时补发；HISTORY_MAX 上限）
 * @property {string[]} mirror   该 agent 的镜像检查点缓冲（按 meta 重置，viewer 切入时补发重建画面）
 */
/** @type {Map<string, Agent>} 在线 agent，按分配的 id 索引 */ const agents = new Map();
let nextAgentId = 1;
/** @type {Set<Conn>} 多个 viewer 同时在线；每个 conn 带 `.watch`（当前收看的 agent id|null） */
const viewers = new Set();
const HISTORY_MAX = 200;

/** 构建在线名册（仅暴露 id/ua/url，不含任何连接内部状态）。 */
const roster = () =>
  JSON.stringify({
    t: 'agents',
    list: [...agents.values()].map((a) => ({ id: a.id, ua: a.ua, url: a.url })),
  });
/** 名册变化（agent 上/下线、握手补全 ua/url）即广播给所有 viewer。 */
const broadcastRoster = () => {
  const r = roster();
  for (const v of viewers) v.send(r);
};

/** 已解析出的隧道地址消息（供 viewer 自动回填「生成调试链接」）；未就绪时为 null。 */
const tunnelMsg = () =>
  tunnelSub ? JSON.stringify({ t: 'tunnel', sub: tunnelSub, url: tunnelUrl }) : null;

/**
 * 仅解析消息**信封**判断是否镜像帧及其检查点角色（不碰业务内容，守住「relay 不解析业务」）。
 * 先按首字符 + 子串快速否决,避免给每条日志都跑 JSON.parse。
 * @param {string} text @returns {'meta' | 'frame' | null}
 */
const mirrorKind = (text) => {
  if (text.charCodeAt(0) !== 123 /* { */ || text.indexOf('"t":"rr"') === -1) return null;
  try {
    const m = JSON.parse(text);
    return m && m.t === 'rr' ? (m.kind === 'meta' ? 'meta' : 'frame') : null;
  } catch {
    return null;
  }
};

// ─────────────────────────── 终端输出（带色，可关） ───────────────────────────
// 仅 TTY 且未设 NO_COLOR 时上色（管道/重定向自动退化为纯文本，不写控制符）。
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
/** @param {string} c @param {string} s */
const paint = (c, s) => (useColor ? `${c}${s}\x1b[0m` : s);
/** @param {string} s */ const dim = (s) => paint('\x1b[2m', s);
/** @param {string} s */ const bold = (s) => paint('\x1b[1m', s);
/** @param {string} s */ const cyan = (s) => paint('\x1b[36m', s);
/** @param {string} s */ const green = (s) => paint('\x1b[32m', s);
/** @param {string} s */ const yellow = (s) => paint('\x1b[33m', s);
/** @param {string} s */ const red = (s) => paint('\x1b[31m', s);

const ts = () => new Date().toISOString().slice(11, 19);
/** @param {...unknown} a */
const log = (...a) => console.log(dim(`[${ts()}]`), ...a);

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  const host = req.headers.host || '';
  // 仅对本地 Host 伺服 viewer（经隧道的公网访问只返回健康文本，不把 UI 暴露出去）。
  const isLocal =
    host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('[::1]');
  if (isLocal && (path === '/' || path === '/viewer' || path === '/viewer.html')) {
    try {
      // no-store：viewer 是单文件大 HTML，浏览器易缓存；联调中频繁重建 dist，必须每次取最新，
      // 否则改了代码刷新仍是旧版（曾因此误判"没修复"）。
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store, must-revalidate',
      });
      res.end(fs.readFileSync(VIEWER_PATH));
    } catch {
      // 多半是仓库内开发还没构建：给出可直接照做的提示（发布包内 viewer.html 随包携带，不会缺）。
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('viewer 尚未构建。仓库根目录运行：pnpm build\n');
    }
    return;
  }
  // 其余（含隧道侧）：健康检查；真正的连接走 WS upgrade。
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('farsight relay up. connect via WebSocket (?role=agent|viewer).\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const url = new URL(req.url || '/', 'http://localhost');
  const role = url.searchParams.get('role') === 'viewer' ? 'viewer' : 'agent';
  const conn = new Conn(socket, role);

  if (role === 'viewer') {
    conn.watch = null; // 当前收看的 agent id；初始不看任何 agent，待 viewer 发 watch
    viewers.add(conn);
    log(green('viewer 已连接'), dim(`（共 ${viewers.size}）`));
    conn.send(roster()); // 立即下发名册，viewer 据此选看
    const tm = tunnelMsg();
    if (tm) conn.send(tm); // 隧道已就绪 → 下发地址供「生成调试链接」自动回填
  } else {
    // agent 自报的页签身份码（?code=）作 id；无码/不合法的旧 agent 回退分配 aN。
    const code = url.searchParams.get('code');
    const id = code && /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : `a${nextAgentId++}`;
    // 同 code = 同一页签重连：替换掉那条陈旧连接（不跨页签抢占，故不会重演抢占战）。
    // 先装上新连接再关旧的——旧连接的 onClose 会看到 id 已指向新 conn 而跳过删除，避免误删与多余名册。
    const stale = agents.get(id);
    conn.agentId = id;
    agents.set(id, { conn, id, ua: '', url: '', history: [], mirror: [] });
    if (stale) stale.conn.close();
    log(
      green('agent 已连接'),
      bold(cyan(id)),
      dim(req.socket.remoteAddress || ''),
      dim(`（共 ${agents.size}）`),
    );
    broadcastRoster(); // 新 agent 上线 → 刷新所有 viewer 的名册
  }

  conn.onMessage = (text) => {
    if (role === 'agent') handleAgentMessage(conn, text);
    else handleViewerMessage(conn, text);
  };
  conn.onClose = () => {
    if (role === 'viewer') {
      viewers.delete(conn);
      log(yellow('viewer 断开'), dim(`（剩 ${viewers.size}）`));
    } else if (conn.agentId && agents.get(conn.agentId)?.conn === conn) {
      agents.delete(conn.agentId);
      log(yellow('agent 断开'), bold(cyan(conn.agentId)), dim(`（剩 ${agents.size}）`));
      // 名册更新即可：收看它的 viewer 会发现它消失并自动改看其它 agent。
      broadcastRoster();
    }
  };
});

/**
 * agent → relay：分流进该 agent 的历史/镜像缓冲，并转发给**正在收看它**的 viewer。
 * @param {Conn} conn @param {string} text
 */
function handleAgentMessage(conn, text) {
  const a = conn.agentId && agents.get(conn.agentId);
  if (!a) return;
  // 镜像帧走独立检查点缓冲（不进 history），pong 是瞬时探针（只转发不留存），其余进日志历史。
  const kind = mirrorKind(text);
  if (kind) {
    if (kind === 'meta') a.mirror = [text];
    else a.mirror.push(text);
  } else if (text.indexOf('"t":"pong"') === -1) {
    a.history.push(text);
    if (a.history.length > HISTORY_MAX) a.history.shift();
    // 握手回传 ua/url：补进名册并广播，让切换下拉显示得出该 agent 是哪个页面。
    if (!a.url && text.indexOf('"t":"hello"') !== -1) {
      try {
        const h = JSON.parse(text);
        if (h && h.t === 'hello') {
          a.ua = String(h.ua || '');
          a.url = String(h.url || '');
          broadcastRoster();
        }
      } catch {
        /* 忽略损坏帧 */
      }
    }
  }
  // 只发给正在收看本 agent 的 viewer。
  for (const v of viewers) if (v.watch === a.id) v.send(text);
}

/**
 * viewer → relay：`watch` 由 relay 消费（切换收看），其余指令转发给被看 agent。
 * @param {Conn} conn @param {string} text
 */
function handleViewerMessage(conn, text) {
  let cmd;
  try {
    cmd = JSON.parse(text);
  } catch {
    return; // 损坏帧忽略
  }
  if (cmd && cmd.t === 'watch') {
    conn.watch = typeof cmd.id === 'string' ? cmd.id : null;
    const a = conn.watch && agents.get(conn.watch);
    if (!a) return; // 看的 agent 不在（已断开/尚未连入）：仅记录意向，待其上线后由 viewer 重发
    if (!cmd.resume) {
      conn.send(JSON.stringify({ t: 'reset', id: a.id })); // 切换：令 viewer 清屏
      for (const m of a.history) conn.send(m); // 补发该 agent 的日志历史
    }
    for (const m of a.mirror) conn.send(m); // 补发镜像检查点 → 立即重建画面（resume 也要）
    return;
  }
  // eval / snapshot / mirror / ping：转发给当前被看 agent。
  const a = conn.watch && agents.get(conn.watch);
  if (a) a.conn.send(text);
}

server.listen(PORT, () => {
  console.log();
  log(green('●'), bold('Farsight 中继已启动'), dim('→'), cyan(`http://localhost:${PORT}`));
  log(dim('  viewer（本地迷你 DevTools）：'), cyan(`http://localhost:${PORT}/`));
  startTunnel();
});

// ─────────────────────────── Cloudflare 隧道（自动） ───────────────────────────
/** @type {import('node:child_process').ChildProcess | null} */ let tunnel = null;
let tunnelUrl = ''; // 已解析出的完整隧道 URL（解析一次即锁定，后续输出不再重复匹配）
let tunnelSub = ''; // 隧道子域名（= ?debug= 的值）；与 tunnelUrl 同时解析得到
let shuttingDown = false;

/**
 * 自动起 Cloudflare quick tunnel（TryCloudflare），把本地中继暴露成随机公网子域名。
 * 解析其输出里的 `https://<子域名>.trycloudflare.com` 并醒目打印——直接拷给用户拼 `?debug=`。
 * 未装 cloudflared / 想自行起隧道：设 `FARSIGHT_NO_TUNNEL=1` 跳过（中继照常运行）。
 */
function startTunnel() {
  if (process.env.FARSIGHT_NO_TUNNEL) {
    log(
      dim('已设 FARSIGHT_NO_TUNNEL：跳过自动隧道。自行执行：'),
      cyan(`cloudflared tunnel --url http://localhost:${PORT}`),
    );
    return;
  }
  log(dim('正在建立 Cloudflare 隧道…'));
  /** @type {import('node:child_process').ChildProcess} */
  const cp = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tunnel = cp;
  // ChildProcess 继承自 EventEmitter 的 .on 在某些编辑器内置 TS 版本下解析不到（CLI tsc 正常）；
  // 仅事件注册走 any 别名绕开，cp 仍保留 ChildProcess 类型供 .stdout/.stderr/.kill 用。
  const ev = /** @type {any} */ (cp);
  ev.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
    tunnel = null;
    if (err.code === 'ENOENT') {
      log(red('✗ 未找到 cloudflared。'), '安装：', cyan('brew install cloudflared'));
      log(dim('  或设 FARSIGHT_NO_TUNNEL=1 自行起隧道。中继仍在运行。'));
    } else {
      log(red('✗ cloudflared 启动失败：'), String(err));
    }
  });
  // cloudflared 把隧道 URL 与日志都写 stderr；两路都扫，谁先出现 URL 谁触发。
  const onData = (/** @type {Buffer} */ buf) => {
    const text = buf.toString();
    if (!tunnelUrl) {
      const m = text.match(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/i);
      if (m) {
        tunnelUrl = m[0];
        tunnelSub = m[1];
        const tm = tunnelMsg();
        if (tm) for (const v of viewers) v.send(tm); // 已在线的 viewer：补发隧道地址
        announceTunnel(m[1]);
        return;
      }
    }
    // URL 之外只把明显的报错行透传出来（剥掉 cloudflared 的时间戳/级别前缀），其余降噪不刷屏。
    // 关闭过程中的连接断开报错是预期噪音，跳过。
    if (!shuttingDown && /\b(ERR|error|failed)\b/i.test(text)) {
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t && /\b(ERR|error|failed)\b/i.test(t))
          log(dim('[cloudflared]'), t.replace(/^\S+T\S+\s+\w+\s+/, ''));
      }
    }
  };
  cp.stdout?.on('data', onData);
  cp.stderr?.on('data', onData);
  ev.on('exit', (/** @type {number | null} */ code) => {
    tunnel = null;
    if (!shuttingDown && code)
      log(yellow(`cloudflared 已退出（code ${code}）。`), dim('隧道地址已失效。'));
  });
}

/**
 * 醒目打印隧道子域名 + 可直接拷贝的 `?debug=` 片段（拼到用户页面域名后即成可点链接）。
 * @param {string} sub 隧道子域名（不含 `.trycloudflare.com`）
 */
function announceTunnel(sub) {
  const url = `https://${sub}.trycloudflare.com`;
  const bar = '━'.repeat(
    Math.max(url.length, ('用户链接：https://<页面域名>/?debug=' + sub).length) + 4,
  );
  console.log();
  console.log('  ' + green(bar));
  console.log('  ' + bold(green('  隧道就绪')) + dim('  —  拷贝下面任一项发给用户'));
  console.log('');
  console.log('    ' + dim('子域名  ') + bold(cyan(sub)));
  console.log('    ' + dim('参 数  ') + bold('?debug=' + sub));
  console.log('    ' + dim('链 接  ') + bold('https://<页面域名>/?debug=' + sub));
  console.log('');
  console.log('  ' + dim('（完整隧道：' + url + '）'));
  console.log('  ' + green(bar));
  console.log();
}

/** Ctrl-C / 终止：先关 cloudflared（地址即刻失效）再退出。 */
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log();
  log(dim('正在关闭…隧道地址即刻失效。'));
  if (tunnel) {
    try {
      tunnel.kill('SIGINT');
    } catch {
      /* ignore */
    }
  }
  // 留一点时间让 cloudflared 收尾，随后强制退出。
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/** 最小 WebSocket 连接封装：解析客户端掩码帧、发送未掩码文本帧。 */
class Conn {
  /** @param {import('node:stream').Duplex} socket @param {string} role */
  constructor(socket, role) {
    this.socket = socket;
    this.role = role;
    /** @type {string | null} viewer 专用：当前收看的 agent id（null=未收看） */ this.watch = null;
    /** @type {string} agent 专用：relay 为本连接分配的 id */ this.agentId = '';
    /** @type {Buffer} */ this.buf = Buffer.alloc(0);
    /** @type {Buffer[]} */ this.frags = [];
    this.fragOp = 0;
    /** @type {(text: string) => void} */ this.onMessage = () => {};
    /** @type {() => void} */ this.onClose = () => {};
    this._closed = false;

    socket.on('data', (chunk) => this._onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on('close', () => this._fireClose());
    socket.on('error', () => this._fireClose());
  }

  /** @param {Buffer} chunk */
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    // 循环解析缓冲里所有完整帧。
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < offset + 2) return;
        len = this.buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buf.length < offset + 8) return;
        // 我们的消息很小，高 32 位忽略。
        len = this.buf.readUInt32BE(offset + 4);
        offset += 8;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < offset + maskLen + len) return; // 半个帧，等更多数据
      const mask = masked ? this.buf.subarray(offset, offset + 4) : null;
      offset += maskLen;
      const payload = Buffer.from(this.buf.subarray(offset, offset + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(offset + len);

      if (opcode === 0x8) {
        // close
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this._sendFrame(0xa, payload); // pong
        continue;
      }
      if (opcode === 0xa) continue; // pong，忽略

      // 文本(0x1)/二进制(0x2)/续帧(0x0) → 处理分片
      if (opcode === 0x1 || opcode === 0x2) {
        this.frags = [payload];
        this.fragOp = opcode;
      } else {
        this.frags.push(payload);
      }
      if (fin) {
        const full = Buffer.concat(this.frags);
        this.frags = [];
        if (this.fragOp === 0x1) {
          try {
            this.onMessage(full.toString('utf8'));
          } catch {
            /* 单条消息异常不影响连接 */
          }
        }
      }
    }
  }

  /** @param {string} text */
  send(text) {
    if (this._closed) return;
    this._sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  /** @param {number} opcode @param {Buffer} payload */
  _sendFrame(opcode, payload) {
    if (this._closed) return;
    const len = payload.length;
    /** @type {Buffer} */ let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this._fireClose();
    }
  }

  close() {
    if (this._closed) return;
    try {
      this._sendFrame(0x8, Buffer.alloc(0));
      this.socket.end();
    } catch {
      /* ignore */
    }
    this._fireClose();
  }

  _fireClose() {
    if (this._closed) return;
    this._closed = true;
    this.onClose();
  }
}
