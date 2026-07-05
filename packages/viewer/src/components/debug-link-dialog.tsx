/**
 * 生成调试链接弹窗：把「要调试的落地页 URL」+「隧道地址（?debug= 的值）」拼成用户可点的
 * 联调链接 `https://<落地页>/?debug=<token>`，并出二维码方便扫码。
 *
 * **隧道地址自动回填并锁定**：relay 启动时自建 Cloudflare 隧道并把子域名下发给 viewer（{@link store}
 * 的 `tunnelSub`），打开弹窗即填好且**禁止更改**（输入禁用）——隧道地址由本机中继唯一决定，手改只会
 * 拼出连不上的死链。仅当未启用自动隧道（`RD_NO_TUNNEL`，relay 不下发 `tunnelSub`）时才回退到手填
 * （沿用上次输入 / 公网型中继地址）。token 规则与 agent 端解析一致：值不含 `.` 视为子域名
 * （agent 自动补 `.trycloudflare.com`），含 `.` 当完整主机名；粘贴整段隧道 URL 时取其主机名。
 * 页面 URL 与手填的隧道地址仅存 sessionStorage（本标签页会话内回填，关闭即清，不跨会话留存）。
 */
import { useEffect, useRef, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { Dialog, DialogContent, DialogTitle, Input } from '../ui';
import { useSelector } from '../relay-store';
import { CopyButton } from './ui-bits';

const PAGE_KEY = 'remote-debug-link-page';
const TOKEN_KEY = 'remote-debug-link-token';

// 页面 URL / 隧道地址只在本标签页会话内留存（sessionStorage，非 localStorage）：关闭标签页即清，
// 不跨会话长期记录调试目标。
function read(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function write(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* 忽略写盘失败 */
  }
}

/** 从用户输入提炼 `?debug=` 的值：URL/带协议/带斜杠取主机名，否则原样（裸子域名）。 */
function normalizeToken(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  if (/:\/\//.test(t) || t.includes('/')) {
    try {
      return new URL(/:\/\//.test(t) ? t : `https://${t}`).host;
    } catch {
      return t.replace(/^[a-z]+:\/\//i, '').split('/')[0];
    }
  }
  return t;
}

/** 拼出最终联调链接；任一项缺失或页面 URL 非法则返回 null。 */
function buildLink(pageUrl: string, token: string): string | null {
  const page = pageUrl.trim();
  const tok = normalizeToken(token);
  if (!page || !tok) return null;
  try {
    const u = new URL(/:\/\//.test(page) ? page : `https://${page}`);
    u.searchParams.set('debug', tok);
    return u.toString();
  } catch {
    return null;
  }
}

/** 本地中继地址若是公网隧道（非 localhost），取其主机名作 token 默认值。 */
function tokenFromRelay(relayUrl: string): string {
  try {
    const host = new URL(relayUrl).host;
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return '';
    return host;
  } catch {
    return '';
  }
}

export function DebugLinkDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const relayUrl = useSelector((s) => s.relayUrl);
  const tunnelSub = useSelector((s) => s.tunnelSub);
  const [page, setPage] = useState('');
  const [token, setToken] = useState('');
  // 本次打开内用户是否手改过隧道地址：改过则不再被自动回填覆盖。
  const tokenTouched = useRef(false);

  // 打开时回填页面 URL（上次输入），并重置「手改」标记。
  useEffect(() => {
    if (!open) return;
    setPage(read(PAGE_KEY));
    tokenTouched.current = false;
  }, [open]);

  // 隧道地址：有 relay 自动下发的子域名时**锁定**为该值（下方输入禁用、不可改）；tunnelSub 可能在
  // 弹窗打开后才到达，故依赖它即时锁定。未启用自动隧道（RD_NO_TUNNEL）才回退手填（上次输入 /
  // 公网型中继地址），且用户改过则不覆盖。
  useEffect(() => {
    if (!open) return;
    if (tunnelSub) {
      setToken(tunnelSub);
      return;
    }
    if (!tokenTouched.current) setToken(read(TOKEN_KEY) || tokenFromRelay(relayUrl));
  }, [open, tunnelSub, relayUrl]);

  // 自动隧道在线即锁死隧道地址：输入禁用。无自动隧道时才允许手填。
  const locked = !!tunnelSub;
  // 锁定时一律以 tunnelSub 为准（不信任 token 状态），确保隧道地址无论如何都改不动。
  const effectiveToken = locked ? tunnelSub : token;
  const link = buildLink(page, effectiveToken);

  // 二维码下载：把 canvas 导出为 PNG 触发下载（文件名带隧道子域名便于区分）。
  const qrRef = useRef<HTMLCanvasElement>(null);
  const downloadQr = () => {
    const canvas = qrRef.current;
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `debug-qr-${tunnelSub || 'link'}.png`;
    a.click();
  };

  const onPage = (v: string) => {
    setPage(v);
    write(PAGE_KEY, v);
  };
  const onToken = (v: string) => {
    tokenTouched.current = true;
    setToken(v);
    write(TOKEN_KEY, v);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle className="text-sm">生成调试链接</DialogTitle>

        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">要调试的页面 URL</span>
            <Input
              autoFocus
              value={page}
              onChange={(e) => onPage(e.target.value)}
              spellCheck={false}
              placeholder="https://落地页域名/iOSHome.html"
              className="h-9 font-(family-name:--rd-mono) text-xs"
            />
          </label>

          <label className="block space-y-1">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              隧道地址（?debug= 的值）
              {locked && (
                <span className="rounded bg-emerald-500/15 px-1 text-[10px] text-emerald-500">
                  已自动取本机隧道 · 锁定
                </span>
              )}
            </span>
            <Input
              value={effectiveToken}
              onChange={(e) => !locked && onToken(e.target.value)}
              disabled={locked}
              readOnly={locked}
              spellCheck={false}
              placeholder="如 happy-cat-1234（自动补 .trycloudflare.com）"
              title={locked ? '隧道地址由本机中继自动提供，不可更改' : undefined}
              className="h-9 font-(family-name:--rd-mono) text-xs"
            />
          </label>
        </div>

        {link ? (
          <div className="flex items-start gap-3 border-t border-border pt-3">
            <button
              type="button"
              onClick={downloadQr}
              title="点击下载二维码"
              aria-label="点击下载二维码"
              className="group relative shrink-0 rounded bg-white p-2"
            >
              <QRCodeCanvas ref={qrRef} value={link} size={104} level="M" />
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded bg-black/55 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
                点击下载二维码
              </span>
            </button>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="text-[10px] tracking-wide text-muted-foreground uppercase">
                调试链接
              </div>
              <div className="flex items-start gap-2">
                <a
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 break-all font-(family-name:--rd-mono) text-xs text-primary hover:underline"
                >
                  {link}
                </a>
                <CopyButton value={link} label="复制调试链接" className="mt-0.5" />
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                把链接发给用户扫码/点击，其页面将懒加载 agent 反连本中继。注意：隧道地址不可猜 +
                进程短命即为门禁，别公开转发。
              </p>
            </div>
          </div>
        ) : (
          <div className="border-t border-border pt-3 text-xs text-muted-foreground">
            填入页面 URL 与隧道地址后生成链接与二维码。
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
