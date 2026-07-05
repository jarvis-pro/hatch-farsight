/**
 * remote-debug viewer 根组件：极简顶部栏（连接状态 + 命令搜索 + 主题）+ 五个一级面板
 * （Console / Network / Events / 环境 / 镜像）。DOM 检视已并入「镜像」（直接读回放 iframe），
 * 截图已移除。全局动作收进命令面板（⌘K）；脚本运行走弹窗。
 * 快捷键：⌘/Ctrl+K 命令面板、1-5 切面板。新错误在非当前面板亮红标，并经 aria-live 播报。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Link2, Terminal } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger, cn } from './ui';
import { useRelay } from './use-relay';
import { store, useSelector } from './relay-store';
import { useTheme } from './use-theme';
import { AppHeader } from './components/app-header';
import { ConsolePanel } from './components/console-panel';
import { NetworkPanel } from './components/network-panel';
import { EventsPanel } from './components/events-panel';
import { EnvPanel } from './components/env-panel';
import { MirrorPanel } from './components/mirror-panel';
import { CommandPalette, type Command } from './components/command-palette';
import { EvalDialog } from './components/eval-dialog';
import { DebugLinkDialog } from './components/debug-link-dialog';

function TabCount({ n, alert }: { n: number; alert?: boolean }) {
  if (n === 0) return null;
  return (
    <span
      className={cn(
        'ml-1 rounded px-1 text-[10px] tabular-nums',
        alert ? 'bg-rose-500/25 text-rose-400' : 'bg-muted-foreground/20',
      )}
    >
      {n > 999 ? '999+' : n}
    </span>
  );
}

const TABS = ['console', 'network', 'events', 'env', 'mirror'] as const;

/** 导出本次会话四通道为 JSON 文件。 */
function exportSession() {
  const s = store.getState();
  const blob = new Blob(
    [
      JSON.stringify(
        { console: s.console, network: s.network, events: s.events, inspect: s.inspect },
        null,
        2,
      ),
    ],
    { type: 'application/json' },
  );
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `remote-debug-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function App() {
  const relay = useRelay();
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState('console');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [evalOpen, setEvalOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  const consoleLen = useSelector((s) => s.console.length);
  const networkLen = useSelector((s) => s.network.length);
  const eventsLen = useSelector((s) => s.events.length);
  const envCount = useSelector((s) => s.inspect.length);

  const status = useSelector((s) => s.status);
  const agentOnline = useSelector((s) => s.agentOnline);
  const mirrorActive = useSelector((s) => s.mirrorActive);
  const agents = useSelector((s) => s.agents);
  const watchedId = useSelector((s) => s.watchedId);
  const online = status === 'open' && agentOnline;

  // 自动选看：连上拿到名册后，须主动向 relay 发 watch（否则 relay 默认不转发任何 agent 的帧）。
  //  · 持久化的 watchedId 仍在名册 → resume（保留本地通道，只补发镜像重建画面）；
  //  · 否则（首次/旧目标已离线）→ 选第一个 agent 并 switch（清屏 + 补发其历史）。
  // resolvedRef 保证每次连接只主动解析一次；被看 agent 中途掉线则自动改看名册首位。
  const resolvedRef = useRef(false);
  useEffect(() => {
    if (status !== 'open') {
      resolvedRef.current = false;
      return;
    }
    if (!agents.length) return;
    const valid = !!watchedId && agents.some((a) => a.id === watchedId);
    if (resolvedRef.current) {
      if (!valid) relay.watch(agents[0].id, false); // 被看 agent 掉线：改看首位
      return;
    }
    resolvedRef.current = true;
    if (valid)
      relay.watch(watchedId, true); // 恢复上次收看的 agent
    else relay.watch(agents[0].id, false); // 首次/旧目标已不在：选首位
  }, [status, agents, watchedId, relay]);

  // agent 连上即自动同步一次环境快照（每次 online 由 false→true 触发，与「环境」面板是否在前台无关）。
  const wasOnline = useRef(false);
  useEffect(() => {
    if (online && !wasOnline.current) relay.send({ t: 'snapshot' });
    wasOnline.current = online;
  }, [online, relay]);

  // 跨 tab 未读错误：累计错误数 - 上次查看该 tab 时的基线。
  const consoleErrors = useSelector((s) => s.consoleErrors);
  const networkErrors = useSelector((s) => s.networkErrors);
  const [seen, setSeen] = useState({ console: 0, network: 0 });
  useEffect(() => {
    if (tab === 'console') setSeen((p) => ({ ...p, console: consoleErrors }));
    if (tab === 'network') setSeen((p) => ({ ...p, network: networkErrors }));
  }, [tab, consoleErrors, networkErrors]);
  const unreadConsole = tab === 'console' ? 0 : Math.max(0, consoleErrors - seen.console);
  const unreadNetwork = tab === 'network' ? 0 : Math.max(0, networkErrors - seen.network);

  // 错误 aria-live 播报。
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    if (consoleErrors === 0) return;
    const c = store.getState().console;
    for (let i = c.length - 1; i >= 0; i--) {
      const e = c[i];
      if (e.kind === 'err') return setAnnounce(`错误：${e.message}`);
      if (e.kind === 'eval-out' && !e.ok) return setAnnounce(`eval 失败：${e.value}`);
    }
  }, [consoleErrors]);

  // 命令面板的命令清单（带图标）。
  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'eval',
        label: '运行脚本…',
        icon: Terminal,
        hint: 'JS',
        keywords: 'eval 执行 console',
        disabled: !online,
        run: () => setEvalOpen(true),
      },
      {
        id: 'debug-link',
        label: '生成调试链接…',
        icon: Link2,
        hint: '二维码',
        keywords: 'qr 二维码 链接 url debug 调试 联调',
        run: () => setLinkOpen(true),
      },
      {
        id: 'export',
        label: '导出会话 JSON',
        icon: Download,
        keywords: 'export 下载',
        run: exportSession,
      },
    ],
    [online],
  );

  // 快捷键：⌘/Ctrl+K 命令面板；1-6 切面板（输入控件内除 ⌘K 外不响应）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      const el = e.target as HTMLElement | null;
      const typing =
        el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const i = ['1', '2', '3', '4', '5'].indexOf(e.key);
      if (i !== -1) {
        e.preventDefault();
        setTab(TABS[i]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <AppHeader
        relay={relay}
        theme={theme}
        onSetTheme={setTheme}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="shrink-0 px-3 py-2">
          <TabsList>
            <TabsTrigger value="console">
              Console <TabCount n={unreadConsole || consoleLen} alert={unreadConsole > 0} />
            </TabsTrigger>
            <TabsTrigger value="network">
              Network <TabCount n={unreadNetwork || networkLen} alert={unreadNetwork > 0} />
            </TabsTrigger>
            <TabsTrigger value="events">
              Events <TabCount n={eventsLen} />
            </TabsTrigger>
            <TabsTrigger value="env">
              环境 <TabCount n={envCount} />
            </TabsTrigger>
            <TabsTrigger value="mirror">
              镜像
              {mirrorActive && (
                <span className="ml-1 inline-block size-2 animate-pulse rounded-full bg-emerald-500" />
              )}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="console" className="min-h-0 flex-1">
          <ConsolePanel />
        </TabsContent>
        <TabsContent value="network" className="min-h-0 flex-1">
          <NetworkPanel />
        </TabsContent>
        <TabsContent value="events" className="min-h-0 flex-1">
          <EventsPanel />
        </TabsContent>
        <TabsContent value="env" className="min-h-0 flex-1">
          <EnvPanel relay={relay} online={online} />
        </TabsContent>
        <TabsContent value="mirror" className="min-h-0 flex-1">
          <MirrorPanel relay={relay} />
        </TabsContent>
      </Tabs>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
      <EvalDialog
        open={evalOpen}
        onOpenChange={setEvalOpen}
        relay={relay}
        online={online}
        onRan={() => setTab('console')}
      />
      <DebugLinkDialog open={linkOpen} onOpenChange={setLinkOpen} />

      <div aria-live="assertive" className="sr-only">
        {announce}
      </div>
    </div>
  );
}
