/**
 * 实时镜像 + DOM 检视（合一面板）。把 agent 用 rrweb 录制的 DOM 流在本地用 `Replayer`（live 模式）
 * 实时重建,看到用户页面**当下**的画面与交互（矢量重建,非截图）；并就地从**重建出的回放 iframe**
 * 做元素检视（盒模型/计算样式/诊断/结构树），零回程、不触碰用户真实页面。
 *
 * 数据通路刻意绕开带持久化的 store 环形缓冲（镜像帧高频且大）：
 *   · 挂载时 `store.getMirrorBuffer()` 取「当前检查点」事件序列播种 Replayer；
 *   · 之后 `store.subscribeMirror()` 把每一帧直接喂进去,不触发 React 重渲染。
 * agent 每 ~10s 重拍一次全量快照（rrweb checkout）,故中途打开本面板也能立即重建当前画面。
 *
 * 检视选中态用 **rrweb 节点 id** 表达（而非 Element 引用）——镜像每次 DOM 变更都会双缓冲重建、
 * 换掉整个 iframe,Element 引用随之失效；rrweb id 由录制端分配、跨重建稳定,故用 id 永远解析得回节点。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import 'rrweb/dist/style.css';
import { Replayer } from 'rrweb';
import { MonitorPlay, MousePointerClick, Square } from 'lucide-react';
import { cn } from '../ui';
import { store, useSelector, type RrwebEvent } from '../relay-store';
import type { Relay } from '../use-relay';
import { DomInspector, labelOf, type InspectApi } from './dom-inspector';

/**
 * 回放保真补丁：往回放 iframe 注入少量覆盖样式,纠正 rrweb 还原不到位的运行时注入样式。
 *  ① 禁用一切 CSS 过渡/动画：本镜像按时间轴**快进重建**,而 transition/animation 按**真实时间**跑,
 *     两者打架会让关抽屉等出现「滑走后又闪现一下」。直接定格到最终态,状态准确、无闪烁。
 *  ② vaul/shadcn 抽屉「打开态」transform 修正（rrweb 还原不到其运行时注入的打开态规则）。
 * 每次重建后调用（iframe 是新建的,样式不会跨重建残留）。
 */
function injectReplayFixups(replayer: Replayer): void {
  try {
    const doc = replayer.iframe.contentDocument;
    if (!doc || doc.getElementById('rd-mirror-fixups')) return;
    const st = doc.createElement('style');
    st.id = 'rd-mirror-fixups';
    st.textContent =
      '*,*::before,*::after{transition:none!important;animation:none!important}' +
      '[data-vaul-drawer][data-state="open"]{transform:translate3d(0,0,0)!important}';
    (doc.head || doc.documentElement).appendChild(st);
  } catch {
    /* ignore */
  }
}

/** 右侧检查器面板宽度（拖拽调整,持久化）。 */
const ASIDE_KEY = 'rd-mirror-aside-w';
// 工具栏（两个操作按钮 + 延迟/帧率/状态）随此列收窄,故下限取够单行不换行的宽度。
const ASIDE_MIN = 384;
const STAGE_MIN = 200;

export function MirrorPanel({ relay }: { relay: Relay }) {
  const online = useSelector((s) => s.status === 'open' && s.agentOnline);
  const active = useSelector((s) => s.mirrorActive);
  const [requested, setRequested] = useState(false);
  const [pickMode, setPickMode] = useState(false); // 是否在画面上点选元素（检查器始终常驻,与此无关）
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [tick, setTick] = useState(0); // 周期性自增 → 驱动检视器从 live DOM 重读
  const [rtt, setRtt] = useState<number | null>(null); // 往返延迟 ms（ping/pong）
  const [fps, setFps] = useState(0); // 每秒收到的镜像帧数（吞吐/活跃度）
  const [asideW, setAsideW] = useState(() => {
    const v = Number(localStorage.getItem(ASIDE_KEY));
    return v >= ASIDE_MIN ? v : 400;
  });

  const stageRef = useRef<HTMLDivElement>(null); // 居中容器,用于测可用区域
  const boxRef = useRef<HTMLDivElement>(null);
  const replayerRef = useRef<Replayer | null>(null);
  const evCount = useRef(0); // 1s 窗口内的帧计数,用于算 fps
  const cursorRef = useRef<HTMLDivElement>(null); // 自绘光标（鼠标移动直接定位,不重建）
  const scaleRef = useRef(1); // 当前 contain 缩放比,把录制端坐标映射到镜像像素

  // 检视覆盖层 + 交互层 + 横向分隔条容器。
  const interactionRef = useRef<HTMLDivElement>(null);
  const hoverBoxRef = useRef<HTMLDivElement>(null);
  const selBoxRef = useRef<HTMLDivElement>(null);
  const hoverLabelRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null); // 舞台|检查器 的拖拽容器
  // 供 fit()/positionOverlays() 等稳定回调内读取最新状态。
  const pickModeRef = useRef(false);
  const hoverIdRef = useRef<number | null>(null);
  const selectedIdRef = useRef<number | null>(null);
  const moveRaf = useRef(0);

  // 「当前回放」访问口（读 .current,故双缓冲换 iframe 后自动指向新的）。
  const apiRef = useRef<InspectApi>({
    getDoc: () => replayerRef.current?.iframe.contentDocument ?? null,
    getWin: () => replayerRef.current?.iframe.contentWindow ?? null,
    getNode: (id) => {
      try {
        const m = (
          replayerRef.current as unknown as {
            getMirror?: () => { getNode: (id: number) => Node | null };
          } | null
        )?.getMirror?.();
        return m ? m.getNode(id) : null;
      } catch {
        return null;
      }
    },
    getId: (node) => {
      try {
        const m = (
          replayerRef.current as unknown as {
            getMirror?: () => { getId: (n: Node) => number };
          } | null
        )?.getMirror?.();
        return m ? m.getId(node) : -1;
      } catch {
        return -1;
      }
    },
  });

  /** 重定位悬停/选中高亮框 + 悬停标签（按 rrweb id 现解析节点 → getBoundingClientRect × 缩放）。 */
  const positionOverlays = useCallback(() => {
    const s = scaleRef.current || 1;
    const place = (node: Element | null, box: HTMLDivElement | null): DOMRect | null => {
      if (!box) return null;
      // 高亮跟随 hover/选中 id 即可——不再绑定「点选」开关:树里点选/悬停也要能在画面回显高亮。
      if (!node) {
        box.style.display = 'none';
        return null;
      }
      const r = node.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        box.style.display = 'none';
        return null;
      }
      box.style.display = 'block';
      box.style.transform = `translate(${r.left * s}px, ${r.top * s}px)`;
      box.style.width = `${Math.max(0, r.width * s)}px`;
      box.style.height = `${Math.max(0, r.height * s)}px`;
      return r;
    };
    const api = apiRef.current;
    const hoverNode =
      hoverIdRef.current != null ? (api.getNode(hoverIdRef.current) as Element | null) : null;
    const selNode =
      selectedIdRef.current != null ? (api.getNode(selectedIdRef.current) as Element | null) : null;
    const hr = place(hoverNode, hoverBoxRef.current);
    place(selNode, selBoxRef.current);
    const lbl = hoverLabelRef.current;
    if (lbl) {
      if (hoverNode && hr) {
        lbl.style.display = 'block';
        lbl.textContent = labelOf(hoverNode);
        lbl.style.transform = `translate(${hr.left * s}px, ${Math.max(0, hr.top * s - 18)}px)`;
      } else {
        lbl.style.display = 'none';
      }
    }
  }, []);

  /**
   * contain 缩放定尺：宽高都吃满容器、取较小比、整页**始终完整可见**（不滚动、上下/左右自动留边）。
   * rrweb 的 iframe 尺寸 = 录制端视口,故缩放后即「按窗口 contain」展示当前视口画面。
   */
  const fit = useCallback(() => {
    const r = replayerRef.current;
    const box = boxRef.current;
    const stage = stageRef.current;
    if (!r || !box || !stage) return;
    const iframe = r.iframe;
    const pageW = parseFloat(iframe.getAttribute('width') || '') || iframe.offsetWidth;
    const pageH = parseFloat(iframe.getAttribute('height') || '') || iframe.offsetHeight;
    if (!pageW || !pageH) return;
    const cs = getComputedStyle(stage);
    const availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (availW <= 0 || availH <= 0) return;
    const scale = Math.min(availW / pageW, availH / pageH, 1); // contain：取较小比
    scaleRef.current = scale;
    const wrapper = iframe.parentElement as HTMLElement | null;
    if (wrapper) {
      wrapper.style.transform = `scale(${scale})`;
      wrapper.style.transformOrigin = 'top left';
    }
    box.style.width = `${pageW * scale}px`;
    box.style.height = `${pageH * scale}px`;
    positionOverlays(); // 缩放变化后重定位高亮框
  }, [positionOverlays]);

  // 镜像激活时驱动 Replayer；失活/卸载时拆除。三类事件分三条通道,各取所长、互不抖动：
  //  · 鼠标移动/交互(source 1/2) → 自绘光标覆盖层直接定位（高频,不重建）;
  //  · 滚动(source 3) → 直接滚对应元素/窗口（不重建,重建会打断滚动）;
  //  · 其余 DOM 变更（开/关抽屉等）→ 双缓冲重建。
  // 为何 DOM 变更必须「重建+play」而非增量：rrweb 在直播上每条增量路都有坑——持续 liveMode+addEvent
  // 空闲后会丢增量;pause(seek) / liveMode-burst 都只还原快照、不应用增量。唯一可靠的是普通 Replayer
  // 构造灌全量 + **play() 真正播放**。但朴素重建会「清空旧 iframe 再播」→ 白闪 + 可见快进抖动,故用
  //  ① 极高 speed（一帧播完,无可见快进）② 双缓冲（新画面隐藏渲染好再换上,无白闪、切窗口不残留半截）。
  // 另：Replayer 会就地改写事件对象 → 喂深拷贝;rrweb 还原不到 vaul 抽屉「打开态」transform → 注入覆盖样式。
  useEffect(() => {
    if (!active) return;
    const box = boxRef.current;
    if (!box) return;

    if (!store.getMirrorBuffer().some((e) => e.type === 2)) return; // 还没拿到全量快照,等下一帧

    const clone = (e: RrwebEvent): RrwebEvent => {
      try {
        return structuredClone(e);
      } catch {
        return JSON.parse(JSON.stringify(e));
      }
    };

    let ro: ResizeObserver | null = null;
    let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
    let gen = 0;

    const rebuild = () => {
      rebuildTimer = null;
      const buf = store.getMirrorBuffer().map(clone); // 深拷贝,避免 rrweb 就地改写污染共享缓冲
      if (!buf.some((e) => e.type === 2)) return;
      const myGen = ++gen;
      const root = document.createElement('div');
      root.style.cssText = 'position:absolute;inset:0;visibility:hidden';
      box.appendChild(root);
      let nr: Replayer;
      try {
        nr = new Replayer(buf as unknown as ConstructorParameters<typeof Replayer>[0], {
          root,
          liveMode: false,
          mouseTail: false,
          showWarning: false,
          // speed 不能过高：太快会在 rrweb 异步建好快照 DOM **之前**就把增量播完 → 增量落空（只剩基础页）。
          speed: 64,
        });
        nr.play(0); // 真正播放（非 seek）才会应用增量
      } catch {
        root.remove();
        return;
      }
      const swap = () => {
        if (myGen !== gen) {
          root.remove();
          try {
            (nr as unknown as { destroy?: () => void }).destroy?.();
          } catch {
            /* ignore */
          }
          return;
        }
        const old = replayerRef.current as unknown as { destroy?: () => void } | null;
        replayerRef.current = nr;
        fit(); // 先按当前 replayer(=nr) 缩放好（此时仍隐藏）
        injectReplayFixups(nr);
        root.style.visibility = 'visible'; // 换上新画面
        for (const c of Array.from(box.children)) if (c !== root) c.remove(); // 移除旧 root
        try {
          old?.destroy?.();
        } catch {
          /* ignore */
        }
        if (ro) ro.disconnect();
        ro = new ResizeObserver(() => fit());
        if (stageRef.current) ro.observe(stageRef.current);
        ro.observe(nr.iframe);
        positionOverlays(); // 新 iframe 上重定位检视高亮
      };
      setTimeout(swap, 120);
    };
    const scheduleRebuild = () => {
      if (!rebuildTimer) rebuildTimer = setTimeout(rebuild, 40); // 防抖：合并突发 DOM 事件
    };
    rebuild(); // 初始

    // 鼠标移动(source 1)/交互(source 2)：直接移自绘光标覆盖层,不重建（高频,重建会抖）。
    const moveCursor = (ev: RrwebEvent) => {
      const data = (
        ev as {
          data?: {
            source?: number;
            positions?: { x: number; y: number }[];
            x?: number;
            y?: number;
          };
        }
      ).data;
      if (!data) return;
      let x: number | undefined;
      let y: number | undefined;
      if (data.source === 1 && data.positions && data.positions.length) {
        const p = data.positions[data.positions.length - 1];
        x = p.x;
        y = p.y;
      } else if (data.source === 2 && typeof data.x === 'number' && typeof data.y === 'number') {
        x = data.x;
        y = data.y;
      } else {
        return;
      }
      const cur = cursorRef.current;
      if (cur && x != null && y != null) {
        const s = scaleRef.current;
        cur.style.transform = `translate(${x * s}px, ${y * s}px)`;
        cur.style.opacity = '1';
      }
    };
    // 滚动(source 3)：直接滚对应元素/窗口,不重建。
    const applyScroll = (ev: RrwebEvent) => {
      const data = (ev as { data?: { id?: number; x?: number; y?: number } }).data;
      if (!data || typeof data.id !== 'number') return;
      const r = replayerRef.current;
      if (!r) return;
      try {
        const mirror = (
          r as unknown as { getMirror?: () => { getNode: (id: number) => Node | null } }
        ).getMirror?.();
        const node = mirror?.getNode(data.id) as
          | (Element & { scrollTo?: typeof window.scrollTo })
          | null;
        if (!node) return;
        const doc = r.iframe.contentDocument;
        const x = data.x ?? 0;
        const y = data.y ?? 0;
        if (node === (doc as unknown) || node === doc?.documentElement || node === doc?.body) {
          r.iframe.contentWindow?.scrollTo(x, y);
        } else if (typeof node.scrollTo === 'function') {
          node.scrollTo(x, y);
        } else {
          node.scrollLeft = x;
          node.scrollTop = y;
        }
        positionOverlays(); // 滚动后高亮框跟随
      } catch {
        /* ignore */
      }
    };

    const unsub = store.subscribeMirror((ev: RrwebEvent) => {
      evCount.current++;
      if (ev.type === 3) {
        const src = (ev as { data?: { source?: number } }).data?.source;
        if (src === 1 || src === 2) return void moveCursor(ev); // 鼠标：移光标
        if (src === 3) return void applyScroll(ev); // 滚动：直接应用
      }
      scheduleRebuild(); // 其余 DOM 变更：双缓冲重建
    });

    return () => {
      unsub();
      if (ro) ro.disconnect();
      if (rebuildTimer) clearTimeout(rebuildTimer);
      const r = replayerRef.current as unknown as { destroy?: () => void } | null;
      try {
        r?.destroy?.();
      } catch {
        /* ignore */
      }
      replayerRef.current = null;
      box.innerHTML = '';
    };
  }, [active, fit, positionOverlays]);

  // 同步状态到 ref + 重定位高亮（供稳定回调读取）。
  useEffect(() => {
    pickModeRef.current = pickMode;
    if (!pickMode) setHoverId(null); // 关闭画面点选只清悬停;选中态保留（检查器常驻）
    positionOverlays();
  }, [pickMode, positionOverlays]);
  useEffect(() => {
    hoverIdRef.current = hoverId;
    positionOverlays();
  }, [hoverId, positionOverlays]);
  useEffect(() => {
    selectedIdRef.current = selectedId;
    positionOverlays();
  }, [selectedId, positionOverlays]);

  // 镜像激活即周期性自增 tick：检查器常驻,需持续从 live DOM 重读、高亮框随页面变更保持对齐。
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      setTick((v) => v + 1);
      positionOverlays();
    }, 250);
    return () => clearInterval(t);
  }, [active, positionOverlays]);

  // 持久化检查器宽度。
  useEffect(() => {
    try {
      localStorage.setItem(ASIDE_KEY, String(asideW));
    } catch {
      /* 忽略写盘失败 */
    }
  }, [asideW]);

  // 延迟探针 + 帧率统计（仅镜像激活时跑）：每 1.5s ping 一次量往返延迟,每 1s 结算一次 fps。
  useEffect(() => {
    if (!active) {
      setRtt(null);
      setFps(0);
      return;
    }
    const pending = new Map<number, number>(); // id → 发出时刻
    let pid = 0;
    const unsub = store.subscribePong((id) => {
      const sent = pending.get(id);
      if (sent != null) {
        setRtt(Math.round(performance.now() - sent));
        pending.delete(id);
      }
    });
    const pingTimer = setInterval(() => {
      if (pending.size > 5) {
        pending.clear();
        setRtt(null);
      }
      const id = ++pid;
      pending.set(id, performance.now());
      relay.send({ t: 'ping', id });
    }, 1500);
    const fpsTimer = setInterval(() => {
      setFps(evCount.current);
      evCount.current = 0;
    }, 1000);
    return () => {
      unsub();
      clearInterval(pingTimer);
      clearInterval(fpsTimer);
    };
  }, [active, relay]);

  const start = () => {
    setRequested(true);
    relay.send({ t: 'mirror', on: true });
  };
  const stop = () => {
    setRequested(false);
    setPickMode(false);
    setSelectedId(null);
    setHoverId(null);
    relay.send({ t: 'mirror', on: false });
    store.clearMirror(); // 本地立即熄灭画面（不等 agent 回包）
  };

  // 拖拽舞台|检查器分隔条：检查器宽度 = 容器右沿到指针的距离,夹在 [ASIDE_MIN, 容器宽-STAGE_MIN]。
  const startDragAside = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const rect = splitRef.current?.getBoundingClientRect();
      if (!rect) return;
      setAsideW(Math.max(ASIDE_MIN, Math.min(rect.right - ev.clientX, rect.width - STAGE_MIN)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** 镜像画面坐标 → rrweb 节点 id（经回放 iframe elementFromPoint）。 */
  const hitTest = (clientX: number, clientY: number): number | null => {
    const doc = apiRef.current.getDoc();
    const overlay = interactionRef.current;
    if (!doc || !overlay) return null;
    const rect = overlay.getBoundingClientRect();
    const s = scaleRef.current || 1;
    const node = doc.elementFromPoint((clientX - rect.left) / s, (clientY - rect.top) / s);
    if (!node) return null;
    const id = apiRef.current.getId(node);
    return id >= 1 ? id : null;
  };

  const onStageMove = (e: React.PointerEvent) => {
    if (!pickMode) return;
    const x = e.clientX;
    const y = e.clientY;
    if (moveRaf.current) return;
    moveRaf.current = requestAnimationFrame(() => {
      moveRaf.current = 0;
      setHoverId(hitTest(x, y));
    });
  };
  const onStageClick = (e: React.MouseEvent) => {
    if (!pickMode) return;
    const id = hitTest(e.clientX, e.clientY);
    if (id != null) {
      setSelectedId(id);
      setPickMode(false); // 一次性：选好即关闭,避免误触继续改选（再选可重新点开）
    }
  };

  // 工具栏：激活时随右侧检查器列收窄（跟随其宽度,把横向空间让给左边镜像）,故内容允许换行。
  const toolbar = (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      {active ? (
        <button
          onClick={stop}
          className="flex items-center gap-1 rounded bg-rose-500/90 px-2 py-1 text-[11px] font-medium text-white hover:bg-rose-500"
        >
          <Square className="size-3.5" /> 停止
        </button>
      ) : (
        <button
          onClick={start}
          disabled={!online}
          className="flex items-center gap-1 rounded bg-[var(--primary)] px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50"
        >
          <MonitorPlay className="size-3.5" /> 开始
        </button>
      )}
      {active && (
        <button
          onClick={() => setPickMode((v) => !v)}
          className={cn(
            'flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
            pickMode
              ? 'bg-secondary text-secondary-foreground'
              : 'text-muted-foreground/70 hover:text-foreground',
          )}
          title="开启后,在镜像画面上悬停高亮、点击即选中该处元素（也可直接在右侧结构树里点选）。检查器始终常驻。"
        >
          <MousePointerClick className="size-3.5" /> 点选
        </button>
      )}
      <div className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
        {active && (
          <>
            <span
              className={cn(
                'tabular-nums',
                rtt == null
                  ? 'text-muted-foreground'
                  : rtt < 150
                    ? 'text-emerald-400'
                    : rtt < 400
                      ? 'text-amber-400'
                      : 'text-rose-400',
              )}
              title="到 agent 的往返延迟（经 relay + 隧道 + agent 整条链路,不依赖时钟同步）"
            >
              延迟 {rtt == null ? '—' : `${rtt}ms`}
            </span>
            <span
              className="tabular-nums"
              title="每秒收到的镜像帧数（页面静止时为 0 属正常,交互时反映链路吞吐）"
            >
              {fps} 帧/秒
            </span>
          </>
        )}
        <span className="flex items-center gap-1.5">
          {active ? (
            <>
              <span className="inline-block size-2 animate-pulse rounded-full bg-emerald-500" />
              实时镜像中
            </>
          ) : requested && online ? (
            '等待画面…'
          ) : (
            '未开启'
          )}
        </span>
      </div>
    </div>
  );

  const stage = (
    <div
      ref={stageRef}
      className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/40 p-3"
    >
      {active ? (
        <div className="relative">
          {/* box 设 relative：双缓冲的两层 root 用 absolute inset-0 叠放其内。 */}
          <div ref={boxRef} className="relative overflow-hidden rounded bg-white shadow-lg" />
          {/* 选中高亮框（实线）。 */}
          <div
            ref={selBoxRef}
            className="pointer-events-none absolute top-0 left-0 z-10 hidden border-2 border-sky-400 bg-sky-400/15"
          />
          {/* 悬停高亮框（虚线）+ 标签。 */}
          <div
            ref={hoverBoxRef}
            className="pointer-events-none absolute top-0 left-0 z-10 hidden border border-dashed border-sky-300/80 bg-sky-300/10"
          />
          <div
            ref={hoverLabelRef}
            className="pointer-events-none absolute top-0 left-0 z-20 hidden rounded bg-sky-500 px-1 py-px font-[family-name:var(--rd-mono)] text-[10px] whitespace-nowrap text-white"
          />
          {/* 自绘光标：跟踪录制端鼠标（tip 在 0,0,经 translate 定位）。 */}
          <div
            ref={cursorRef}
            className="pointer-events-none absolute top-0 left-0 z-20 opacity-0 transition-[transform] duration-[32ms] ease-linear"
            style={{ willChange: 'transform' }}
          >
            <svg width="15" height="22" viewBox="0 0 15 22" aria-hidden>
              <path
                d="M1 1 L1 16 L4.5 12.5 L7.2 18.5 L9.4 17.6 L6.7 11.7 L11.5 11.5 Z"
                fill="#1118"
                stroke="#fff"
                strokeWidth="1.3"
              />
            </svg>
          </div>
          {/* 交互层：「画面点选」开启时接管悬停/点击命中测试（关闭时不挡事件）。 */}
          <div
            ref={interactionRef}
            onPointerMove={onStageMove}
            onPointerLeave={() => setHoverId(null)}
            onClick={onStageClick}
            className={cn(
              'absolute inset-0 z-30',
              pickMode ? 'cursor-crosshair' : 'pointer-events-none',
            )}
          />
        </div>
      ) : (
        <div className="m-auto flex max-w-sm flex-col items-center gap-3 px-6 text-center text-muted-foreground">
          <MonitorPlay className="size-9 opacity-30" />
          <p className="text-sm">
            {online
              ? '点「开始」实时重建用户页面画面（rrweb 矢量流,非截图）。'
              : 'agent 未在线,无法开启镜像。'}
          </p>
          {online && (
            <p className="text-xs text-muted-foreground/70">
              所有输入值默认打码;敏感区可在页面元素上加 <code>.rd-block</code>/<code>.rd-mask</code>{' '}
              类屏蔽。
            </p>
          )}
        </div>
      )}
    </div>
  );

  // UI 结构恒定为两列：左镜像舞台 + 右检查器列（工具栏常驻其顶,宽度随列变化）。
  // 未激活时不破坏结构——舞台与检查器各自就地显示 Empty,工具栏退化为只剩「开始」。
  return (
    <div ref={splitRef} className="flex h-full min-h-0">
      {stage}
      {/* 拖拽分隔条：常态仅一条细线;鼠标移上去时柔和淡入一条圆角高亮轴示意可拖拽（命中区比可见线宽,易抓）。 */}
      <div
        onPointerDown={active ? startDragAside : undefined}
        title="拖动调整宽度"
        className={cn('group relative z-20 w-px shrink-0 bg-border', active && 'cursor-col-resize')}
      >
        {active && (
          <>
            <span className="absolute inset-y-0 -left-1 -right-1" />
            <span className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-[var(--primary)] opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100" />
          </>
        )}
      </div>
      <aside style={{ width: asideW }} className="flex shrink-0 flex-col overflow-hidden">
        {toolbar}
        <div className="min-h-0 flex-1 overflow-hidden">
          {active ? (
            <DomInspector
              api={apiRef.current}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onHover={setHoverId}
              tick={tick}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
              开启镜像后,这里常驻显示页面结构树,选中元素可看盒模型/样式/诊断。
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
