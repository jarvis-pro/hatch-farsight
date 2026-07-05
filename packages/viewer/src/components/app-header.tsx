/**
 * 顶部栏（极简）：左侧连接状态指示（点+文案+agent 域名），点击弹出连接控制（地址/连接/断开/重连）；
 * 右侧命令搜索框（点击或 ⌘K 打开命令面板）。全局动作不再常驻顶部，均收进命令面板。
 */
import { useEffect, useState } from 'react';
import {
  Check,
  ChevronsUpDown,
  Monitor,
  Moon,
  Plug,
  PlugZap,
  RotateCw,
  Search,
  Sun,
  Users,
} from 'lucide-react';
import { Button, Input, Popover, PopoverContent, PopoverTrigger, cn } from '../ui';
import { useSelector, type ConnStatus } from '../relay-store';
import type { Relay } from '../use-relay';
import type { Theme } from '../use-theme';
import { CopyButton } from './ui-bits';

const THEME_ICON = { light: Sun, dark: Moon, system: Monitor } as const;
const THEME_LABEL = { light: '浅色', dark: '深色', system: '跟随系统' } as const;
const THEME_ORDER: Theme[] = ['light', 'dark', 'system'];

/** 主题图标按钮：点击展开下拉，选择 浅色 / 深色 / 跟随系统。 */
function ThemeMenu({ theme, onSetTheme }: { theme: Theme; onSetTheme: (t: Theme) => void }) {
  const [open, setOpen] = useState(false);
  const Icon = THEME_ICON[theme];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          title={`主题：${THEME_LABEL[theme]}`}
          aria-label="切换主题"
        >
          <Icon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-36 p-1">
        {THEME_ORDER.map((t) => {
          const I = THEME_ICON[t];
          return (
            <button
              key={t}
              onClick={() => {
                onSetTheme(t);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
            >
              <I className="size-4 text-muted-foreground" />
              <span className="flex-1 text-left">{THEME_LABEL[t]}</span>
              {theme === t && <Check className="size-3.5 text-primary" />}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

/** 从 URL 取主机名（解析失败则原样返回）；用作 agent 的简短标签。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * agent 切换器：列出 relay 名册里的全部在线 agent（多设备/多标签），点选切换当前收看目标。
 * 仅在有 agent 时出现；多于一个时把数量做成角标，提示存在多路可切换。各 app/面板始终只反映被看 agent。
 */
function AgentPicker({ relay }: { relay: Relay }) {
  const [open, setOpen] = useState(false);
  const agents = useSelector((s) => s.agents);
  const watchedId = useSelector((s) => s.watchedId);
  if (agents.length === 0) return null;

  const watched = agents.find((a) => a.id === watchedId);

  /** 身份码徽标：等宽小标签，与 agent 端页面角落的 🛰 徽标一致，用来对应「手里这个页签」。 */
  const codeTag = (id: string, on?: boolean) => (
    <span
      className={cn(
        'shrink-0 rounded px-1 font-(family-name:--rd-mono) text-[10px] tracking-wide',
        on ? 'bg-(--primary)/15 text-primary' : 'bg-muted-foreground/15 text-muted-foreground',
      )}
    >
      {id}
    </span>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex min-w-0 max-w-[45%] items-center gap-1.5 rounded px-2 py-1 text-sm hover:bg-accent"
          title="切换收看的 agent（多设备/多标签；徽标码对应页面角落的 🛰 标记）"
        >
          <Users className="size-3.5 shrink-0 text-muted-foreground" />
          {watched ? codeTag(watched.id, true) : null}
          <span className="min-w-0 truncate">
            {watched ? hostOf(watched.url) || '握手中…' : '选择 agent'}
          </span>
          {agents.length > 1 && (
            <span className="shrink-0 rounded bg-muted-foreground/20 px-1 text-[10px] tabular-nums">
              {agents.length}
            </span>
          )}
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1">
        <div className="px-2 py-1 text-[10px] tracking-wide text-muted-foreground uppercase">
          在线 agent · {agents.length}（码对应页面角落 🛰）
        </div>
        {agents.map((a) => {
          const sel = a.id === watchedId;
          return (
            <button
              key={a.id}
              onClick={() => {
                if (!sel) relay.watch(a.id, false); // 切换 → relay 清屏并补发该 agent 历史/镜像
                setOpen(false);
              }}
              className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
            >
              <Check
                className={cn('mt-0.5 size-3.5 shrink-0', sel ? 'text-primary' : 'opacity-0')}
              />
              {codeTag(a.id, sel)}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{hostOf(a.url) || '握手中…'}</span>
                {a.url && (
                  <span className="block truncate text-xs text-muted-foreground">{a.url}</span>
                )}
                {a.ua && (
                  <span className="block truncate text-[11px] text-muted-foreground/70">
                    {a.ua}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

const STATUS: Record<ConnStatus, { dot: string; text: string }> = {
  idle: { dot: 'bg-muted-foreground', text: '未连接' },
  connecting: { dot: 'bg-amber-400 animate-pulse', text: '连接中…' },
  open: { dot: 'bg-sky-400', text: '已连接，等待 agent' },
  closed: { dot: 'bg-muted-foreground', text: '已断开' },
  error: { dot: 'bg-destructive', text: '连接错误' },
};

/** 掉线后的重连倒计时秒数（reconnectAt 由 useRelay 设），每 250ms 刷新；未排队重连则 null。 */
function useReconnectLeft(): number | null {
  const reconnectAt = useSelector((s) => s.reconnectAt);
  const [, tick] = useState(0);
  useEffect(() => {
    if (reconnectAt === null) return;
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [reconnectAt]);
  if (reconnectAt === null) return null;
  return Math.max(0, Math.ceil((reconnectAt - Date.now()) / 1000));
}

function ConnectionStatus({ relay }: { relay: Relay }) {
  const status = useSelector((s) => s.status);
  const agentOnline = useSelector((s) => s.agentOnline);
  const hello = useSelector((s) => s.hello);
  const relayUrl = useSelector((s) => s.relayUrl);
  const [draft, setDraft] = useState(relayUrl);
  const left = useReconnectLeft();

  const online = status === 'open' && agentOnline;
  const live = status === 'open' || status === 'connecting';
  const meta = online ? { dot: 'bg-emerald-400', text: 'agent 在线' } : STATUS[status];
  const agentHost = hello
    ? (() => {
        try {
          return new URL(hello.url).host;
        } catch {
          return hello.url;
        }
      })()
    : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex min-w-0 items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent">
          <span className={cn('size-2 shrink-0 rounded-full', meta.dot)} />
          <span className="shrink-0 font-medium">{meta.text}</span>
          {status === 'closed' && left !== null && (
            <span className="shrink-0 text-xs text-muted-foreground">
              · {left > 0 ? `${left}s 后重连` : '重连中'}
            </span>
          )}
          {online && agentHost && (
            <span className="min-w-0 truncate text-xs text-muted-foreground">· {agentHost}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3">
        <div>
          <div className="mb-1 text-[10px] tracking-wide text-muted-foreground uppercase">
            中继地址
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && relay.connect(draft)}
              spellCheck={false}
              className="h-8 flex-1 font-(family-name:--rd-mono) text-xs"
              aria-label="中继地址"
            />
            {live ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => relay.disconnect()}
              >
                <PlugZap className="size-4" /> 断开
              </Button>
            ) : (
              <Button size="sm" className="h-8" onClick={() => relay.connect(draft)}>
                <Plug className="size-4" /> 连接
              </Button>
            )}
          </div>
        </div>

        {status === 'closed' && left !== null && (
          <Button
            variant="secondary"
            size="sm"
            className="h-8 w-full"
            onClick={() => relay.connect()}
          >
            <RotateCw className="size-4" /> 立即重连
          </Button>
        )}

        {hello && (
          <div className="space-y-1 border-t border-border pt-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 break-all text-foreground">{hello.url}</span>
              <CopyButton value={`${hello.url}\n${hello.ua}`} label="复制 URL / UA" />
            </div>
            <div className="break-all text-muted-foreground">{hello.ua}</div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function AppHeader({
  relay,
  theme,
  onSetTheme,
  onOpenPalette,
}: {
  relay: Relay;
  theme: Theme;
  onSetTheme: (t: Theme) => void;
  onOpenPalette: () => void;
}) {
  return (
    <header className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-3 py-2">
      <ConnectionStatus relay={relay} />
      <AgentPicker relay={relay} />
      <button
        onClick={onOpenPalette}
        className="ml-auto flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Search className="size-3.5" />
        <span>搜索命令</span>
        <kbd className="rounded bg-muted px-1 font-sans text-[10px] text-muted-foreground">⌘K</kbd>
      </button>
      <ThemeMenu theme={theme} onSetTheme={onSetTheme} />
    </header>
  );
}
