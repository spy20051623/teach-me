import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
} from 'electron';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { actionSchema, defaults, settingsSchema } from '../shared/protocol.ts';
import { resolveScheme, themes } from '../shared/appearance.ts';
import type { Action, Guide, Settings, Shot, Snapshot } from '../shared/protocol.ts';
import { Session } from '../core/session.ts';
import { InputController } from '../core/input.ts';
import { mapGuides, parseScene } from '../core/scene.ts';
import { validateHtmlArea, validateHtmlSource } from '../core/html.ts';
import { WindowsAdapter } from './windows.ts';
import { HtmlHost } from './html.ts';
import { zoomFiles, zoomShot } from './zoom.ts';
import { VoiceController } from '../core/voice.ts';
import { SystemSpeech, transcribe } from './speech.ts';
import { pruneSessions } from './storage.ts';
import { IMAGE_EDGE } from '../shared/limits.ts';
import { setWindowInput } from './window-policy.ts';
import { failureMetadata, writeRuntimeEvent } from './runtime-log.ts';
import { panelBounds } from '../core/panel-layout.ts';
import {
  canCompact,
  transitionPanel,
  type PanelActivity,
  type PanelEvent,
  type PanelState,
} from '../core/panel-mode.ts';
import { PanelMotion } from './panel-motion.ts';

app.setName('Teach me, Agent');
app.commandLine.appendSwitch('enable-features', 'AllowWindowCaptureExclusionInRemoteSessions');
app.setPath(
  'userData',
  process.env.TEACH_ME_AGENT_HOME || path.join(app.getPath('appData'), 'teach-me-agent-v2'),
);
if (!app.requestSingleInstanceLock()) {
  console.log('应用已在运行，本次启动退出；不会创建第二个窗口。');
  app.exit(0);
}
const home = app.getPath('userData');
const endpointFile = path.join(home, 'endpoint.json');
function runtimeEvent(event: string, detail: Record<string, string | number | boolean> = {}) {
  writeRuntimeEvent(home, event, detail);
}
process.on('uncaughtExceptionMonitor', (error, origin) => {
  runtimeEvent('main-exception', { origin, ...failureMetadata(error) });
});
app.on('second-instance', () => runtimeEvent('second-instance'));
const auth = randomBytes(24).toString('hex');
let launchSecret = process.env.TMA_LAUNCH_SECRET || '';
let session: Session | null = null;
let panel: BrowserWindow;
let overlay: BrowserWindow;
let settingsWindow: BrowserWindow;
let settings: Settings = { ...defaults };
let displayId: number | null = null;
let hover = false,
  guidesHidden = false,
  editing = false;
let panelState: PanelState = { mode: 'mini', unread: false };
const panelHeights = { mini: 48, compose: 76, conversation: 420 };
let panelAnimating = false;
let panelMotion: PanelMotion | null = null;
let hasDraft = false,
  toolsOpen = false,
  settingsOpen = false,
  reducedMotion = true;
const panelPositionSchema = z.object({
  version: z.literal(1),
  displayId: z.number().int(),
  right: z.number().finite(),
  bottom: z.number().finite(),
});
let panelPosition: z.infer<typeof panelPositionSchema> | null = null;
let movingPanel = false;
let panelLayoutVersion = 0;
let pointerDrag: {
  id: string;
  bounds: Electron.Rectangle;
  size: { width: number; height: number };
} | null = null;
let settingsDrag: { id: string; bounds: Electron.Rectangle; content: Electron.Rectangle } | null =
  null;
let settingsClientSize: { width: number; height: number } | null = null;
let guides: Guide[] = [];
let userBoard = { epoch: 0, count: 0 };
function clearUserBoard() {
  userBoard = { epoch: userBoard.epoch + 1, count: 0 };
}
let error: string | null = null;
let revision = 0,
  shotSequence = 0;
let lastExternal: string | null = null;
let lastForeground: string | null = null;
let lastShot: Shot | null = null;
const shots = new Map<string, Shot>();
const originals = new Map<string, string>();
const htmlHost = new HtmlHost((reason) => {
  guides = guides.filter((g) => g.type !== 'html');
  if (reason) error = reason;
  broadcast();
});
const windows = new WindowsAdapter(runtimeEvent);
const systemSpeech = new SystemSpeech();
let pendingAudio: {
  resolve: (value: { data: Uint8Array; mime: string }) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
} | null = null;
let collapseTimer: ReturnType<typeof setTimeout> | null = null;
let fgTimer: ReturnType<typeof setInterval> | null = null;
let captureState: Snapshot['capture'] = null;
let captureRequest: {
  resolve: (allow: boolean) => void;
  timer: ReturnType<typeof setTimeout> | null;
} | null = null;
let connection: Snapshot['connection'] = null;
let connectionRequest: ((allow: boolean) => void) | null = null;
let quitting = false;
let readyToQuit = false;
let shutdownTask: Promise<void> | null = null;
let runtimeReady = false;
let panelRecovering = false;
let panelRecoveryAt = 0;
let panelRecoveryReady: (() => void) | null = null;
let talkBusy = false;
let startInProgress = false;
let displayRequest: {
  resolve: (allow: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
} | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const teachingDisplay = () => screen.getAllDisplays().find((d) => d.id === displayId);
// Window placement may fall back; capture and guides require an explicitly selected display.
const target = () => teachingDisplay() || screen.getPrimaryDisplay();
function requireTeachingDisplay() {
  const display = teachingDisplay();
  if (!display) throw new Error('教学屏幕已断开或尚未选择，请重新选屏');
  return display;
}
const panelDisplay = () =>
  screen.getAllDisplays().find((d) => d.id === panelPosition?.displayId) || target();

function observeDisplays() {
  screen.on('display-removed', () => {
    captureDisplayEpoch++;
    if (displayId !== null && !teachingDisplay()) {
      displayId = null;
      guides = [];
      clearUserBoard();
      lastShot = null;
      settleCapture(false);
      voice.cancel().catch(fail);
      fail(new Error('教学屏幕断开，请重新选屏'));
    }
    place();
    broadcast();
  });
  screen.on('display-metrics-changed', () => {
    captureDisplayEpoch++;
    guides = [];
    clearUserBoard();
    lastShot = null;
    place();
    broadcast();
  });
}

function snapshot(): Snapshot {
  const active = session && session.phase !== 'ended';
  const selected = teachingDisplay();
  const zoom = panel && !panel.isDestroyed() ? panel.webContents.getZoomFactor() : 1;
  const transition = panelMotion?.transition;
  const cssBounds = (b: { x: number; y: number; width: number; height: number }) => ({
    x: b.x / zoom,
    y: b.y / zoom,
    width: b.width / zoom,
    height: b.height / zoom,
  });
  return {
    panelLayoutVersion,
    panelHeightLimit: panelBounds(560, panelState.mode, panelDisplay().workArea).height / zoom,
    colorScheme: resolveScheme(settings.appearance.mode, nativeTheme.shouldUseDarkColors),
    panelTransition: transition
      ? {
          ...transition,
          width: transition.width / zoom,
          height: transition.height / zoom,
          from: cssBounds(transition.from),
          to: cssBounds(transition.to),
        }
      : null,
    selectingDisplay: !!displayRequest || !!(active && !selected),
    voice: voice.state,
    revision,
    session: session ? { id: session.id, topic: session.topic, phase: session.phase } : null,
    messages: session?.messages || [],
    input: input.state,
    guides,
    guidesHidden,
    userBoard,
    editing,
    collapsed: panelState.mode !== 'conversation',
    panelMode: panelState.mode,
    panelAnimating,
    settingsOpen,
    unreadReply: panelState.unread,
    settings,
    capture: captureState,
    connection,
    displays: screen.getAllDisplays().map((d) => ({
      id: d.id,
      label: d.label || `屏幕 ${d.id}`,
      width: d.size.width,
      height: d.size.height,
      scaleFactor: d.scaleFactor,
    })),
    displayId: active ? (selected?.id ?? null) : target().id,
    error,
  };
}
function broadcast() {
  revision++;
  if (!app.isReady()) return;
  const state = snapshot();
  if (!guides.some((g) => g.type === 'html')) htmlHost.clear();
  else htmlHost.visible(!guidesHidden);
  for (const w of [panel, overlay, settingsWindow])
    if (w && !w.isDestroyed() && !w.webContents.isCrashed())
      w.webContents.send('companion:state', state);
}
function fail(e: unknown) {
  error = e instanceof Error ? e.message : String(e);
  if (panelState.mode === 'mini') changePanel('compose');
  broadcast();
}
function ours(handle: string) {
  return BrowserWindow.getAllWindows().some((w) => {
    const b = w.getNativeWindowHandle();
    return (b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0))).toString() === handle;
  });
}
async function foreground() {
  const current = await windows.foreground();
  if (current && current !== '0' && !ours(current)) {
    lastExternal = current;
    if (current !== lastForeground && !quitting) {
      if (overlay && !overlay.isDestroyed() && overlay.isVisible() && !overlay.isMinimized())
        overlay.moveTop();
      if (panel && !panel.isDestroyed() && panel.isVisible() && !panel.isMinimized())
        panel.moveTop();
      if (settingsWindow?.isVisible()) settingsWindow.moveTop();
    }
  }
  lastForeground = current;
  return lastExternal;
}
function setBounds(height = panelHeights[panelState.mode], animate = false) {
  if (movingPanel) return;
  const display = panelDisplay();
  const bounds = panelBounds(height, panelState.mode, display.workArea, panelPosition);
  panelMotion?.move(bounds, animate && !reducedMotion);
}
function place() {
  const d = target();
  overlay.setBounds(d.bounds);
  setBounds();
}
function finishPanelMove() {
  movingPanel = false;
  panelLayoutVersion++;
  const bounds = panel.getBounds();
  const display = screen.getDisplayMatching(bounds);
  panelPosition = {
    version: 1,
    displayId: display.id,
    right: bounds.x + bounds.width,
    bottom: bounds.y + bounds.height,
  };
  setBounds();
  const clamped = panel.getBounds();
  panelPosition.right = clamped.x + clamped.width;
  panelPosition.bottom = clamped.y + clamped.height;
  fs.writeFile(path.join(home, 'panel-position.json'), JSON.stringify(panelPosition)).catch((e) =>
    runtimeEvent('panel-position-save-failed', failureMetadata(e)),
  );
  autoCollapse();
}
function panelActivity(): PanelActivity {
  return {
    input: input.state.phase,
    voice: voice.state.phase,
    draft: hasDraft,
    hover,
    focused: !!panel && panel.isFocused(),
    moving: movingPanel,
    tools: toolsOpen,
    settings: settingsOpen,
    board: editing,
    request: !!captureState || !!connection || !!displayRequest,
    error: !!error || !!input.state.error || !!voice.state.error,
  };
}
function changePanel(event: PanelEvent) {
  const next = transitionPanel(panelState, event, panelActivity());
  const changed = next.mode !== panelState.mode;
  if (changed && movingPanel) {
    pointerDrag = null;
    finishPanelMove();
  }
  panelState = next;
  if (changed) {
    panelLayoutVersion++;
    setBounds(undefined, true);
  }
}
function expand(event: 'reply' | 'attention' = 'attention') {
  changePanel(event);
  broadcast();
  autoCollapse();
}
function autoCollapse() {
  if (collapseTimer) clearTimeout(collapseTimer);
  if (quitting || panelRecovering) return;
  if (panelState.mode !== 'mini' && canCompact(panelActivity()) && settings.autoCollapseSec > 0) {
    const last = session?.messages.findLast((m) => m.role === 'agent')?.text || '';
    const readingSeconds =
      panelState.mode === 'conversation' ? Math.min(30, Math.ceil(last.length / 18)) : 0;
    collapseTimer = setTimeout(
      () => {
        changePanel('idle');
        broadcast();
      },
      Math.max(settings.autoCollapseSec, readingSeconds) * 1000,
    );
  }
}
function requireSession() {
  if (!session || session.phase === 'ended') throw new Error('请先让 Agent start 开始一次教学');
  return session;
}
async function readSettings() {
  try {
    settings = settingsSchema.parse(
      JSON.parse(await fs.readFile(path.join(home, 'settings.json'), 'utf8')),
    );
  } catch {
    settings = { ...defaults };
  }
}
async function saveSettings(next: Settings) {
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify(next, null, 2));
}
function applyCaptureVisibility() {
  for (const window of [panel, overlay, settingsWindow])
    if (window && !window.isDestroyed())
      window.setContentProtection(captureProtected || !settings.showInScreenCapture);
  htmlHost.setCaptureVisible(!captureProtected && settings.showInScreenCapture);
}

let captureProtected = false;
let captureTail: Promise<unknown> = Promise.resolve();
let captureDisplayEpoch = 0;
function imageSessionScope(active: Session, connected = () => {}) {
  const recovery = panelRecoveryAt;
  return () => {
    connected();
    if (
      quitting ||
      panelRecovering ||
      recovery !== panelRecoveryAt ||
      session !== active ||
      active.phase === 'ended'
    )
      throw new Error('教学已变更，截图已作废');
  };
}
function captureScope(active = requireSession(), connected = () => {}) {
  const current = requireTeachingDisplay();
  const display = { ...current, bounds: { ...current.bounds }, size: { ...current.size } };
  const epoch = captureDisplayEpoch;
  const assertSession = imageSessionScope(active, connected);
  const assertCurrent = () => {
    assertSession();
    const now = requireTeachingDisplay();
    if (
      epoch !== captureDisplayEpoch ||
      display.id !== now.id ||
      display.scaleFactor !== now.scaleFactor ||
      JSON.stringify(display.bounds) !== JSON.stringify(now.bounds)
    )
      throw new Error('教学屏幕已变更，请重新请求截图');
  };
  assertCurrent();
  return { active, display, assertCurrent };
}
async function captureScreen(scope = captureScope()): Promise<Shot> {
  scope.assertCurrent();
  const capturingSession = scope.active;
  const task = captureTail
    .catch(() => {})
    .then(async () => {
      scope.assertCurrent();
      const d = scope.display;
      captureProtected = true;
      applyCaptureVisibility();
      let sources;
      try {
        await wait(35);
        scope.assertCurrent();
        sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: {
            width: Math.round(d.size.width * d.scaleFactor),
            height: Math.round(d.size.height * d.scaleFactor),
          },
        });
      } finally {
        captureProtected = false;
        applyCaptureVisibility();
      }
      scope.assertCurrent();
      const source = sources.find((s) => s.display_id === String(d.id));
      if (!source || source.thumbnail.isEmpty()) throw new Error('该屏幕无法截取，请更换屏幕');
      const raw = source.thumbnail;
      const rawSize = raw.getSize();
      const ratio = Math.min(1, IMAGE_EDGE / Math.max(rawSize.width, rawSize.height));
      const image =
        ratio < 1
          ? raw.resize({
              width: Math.round(rawSize.width * ratio),
              height: Math.round(rawSize.height * ratio),
            })
          : raw;
      const size = image.getSize();
      const id = `s${++shotSequence}`;
      const dir = path.join(home, 'sessions', capturingSession.id, 'shots');
      const file = path.join(dir, `${id}.png`);
      const originalFile = path.join(dir, `${id}-original.png`);
      try {
        await fs.mkdir(dir, { recursive: true });
        scope.assertCurrent();
        await fs.writeFile(file, image.toPNG());
        scope.assertCurrent();
        await fs.writeFile(originalFile, raw.toPNG());
        scope.assertCurrent();
      } catch (e) {
        for (const stale of [file, originalFile]) {
          try {
            await fs.rm(stale, { force: true });
          } catch (cleanupError) {
            runtimeEvent('capture-cleanup-failed', failureMetadata(cleanupError));
          }
        }
        throw e;
      }
      originals.set(id, originalFile);
      const shot: Shot = {
        id,
        path: file,
        width: size.width,
        height: size.height,
        displayId: d.id,
        bounds: { ...d.bounds },
        scaleFactor: d.scaleFactor,
        at: Date.now(),
      };
      shots.set(id, shot);
      return shot;
    });
  captureTail = task;
  return task;
}
const input = new InputController({
  remember: foreground,
  capture: () => (settings.attachScreenshot ? captureScreen() : Promise.resolve(null)),
  focus: async () => {
    if (quitting || panelRecovering) return;
    const turn = input.state.turnId;
    await setWindowInput(panel, true, true, windows);
    if (
      quitting ||
      panelRecovering ||
      settingsOpen ||
      input.state.turnId !== turn ||
      !['preparing', 'editing'].includes(input.state.phase)
    )
      return;
    if (panel.isMinimized()) panel.restore();
    if (!panel.isVisible()) panel.show();
    if (!panel.isFocused()) panel.focus();
    if (!panel.isFocused()) {
      const handle = panel.getNativeWindowHandle();
      await windows.activate(
        (handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString(),
      );
    }
    if (input.state.turnId === turn && panel.isFocused()) panel.webContents.focus();
  },
  restore: async (handle) => {
    // Quitting must not depend on another native focus/style round trip.
    if (quitting || panelRecovering) return;
    await setWindowInput(panel, false, true, windows);
    if (input.state.phase !== 'idle') return;
    await windows.activate(handle);
    if (input.state.phase === 'idle' && panel.isFocused()) panel.blur();
    autoCollapse();
  },
  deliver: async (text, frames, id, attach) => {
    const s = requireSession();
    const epoch = userBoard.epoch;
    const assertCurrent = () => {
      if (
        input.state.turnId !== id ||
        input.state.phase !== 'submitting' ||
        session !== s ||
        s.phase === 'ended'
      )
        throw new Error('输入已取消，附件已作废');
      if (attach && userBoard.epoch !== epoch) throw new Error('画板已变更，请重新发送');
    };
    let all = frames;
    let boardFile: string | null = null;
    try {
      assertCurrent();
      if (attach && (userBoard.count || guides.some((g) => g.type === 'stroke'))) {
        const dataUrl = await overlay.webContents.executeJavaScript(
          `window.companionBoard?.export(${epoch})`,
        );
        assertCurrent();
        if (
          typeof dataUrl !== 'string' ||
          !dataUrl.startsWith('data:image/png;base64,') ||
          dataUrl.length > 32 * 1024 * 1024
        )
          throw new Error('画板导出失败');
        const png = nativeImage.createFromDataURL(dataUrl);
        if (png.isEmpty()) throw new Error('画板导出失败');
        const d = target();
        const shotId = `s${++shotSequence}`;
        boardFile = path.join(home, 'sessions', s.id, 'shots', `${shotId}-board.png`);
        await fs.mkdir(path.dirname(boardFile), { recursive: true });
        assertCurrent();
        await fs.writeFile(boardFile, png.toPNG());
        assertCurrent();
        all = [
          ...all,
          {
            id: shotId,
            path: boardFile,
            ...png.getSize(),
            displayId: d.id,
            bounds: { ...d.bounds },
            scaleFactor: d.scaleFactor,
            at: Date.now(),
          },
        ];
      }
      assertCurrent();
    } catch (e) {
      if (boardFile) {
        try {
          await fs.rm(boardFile, { force: true });
        } catch (cleanupError) {
          runtimeEvent('board-attachment-cleanup-failed', failureMetadata(cleanupError));
        }
      }
      throw e;
    }
    // Once queued, the message owns the attachment even if a later notification fails.
    s.push(text, all, id);
    if (frames[0]) lastShot = frames[0];
  },
  changed: () => {
    broadcast();
    autoCollapse();
  },
});
const voice = new VoiceController({
  prepare: async () => {
    requireSession();
    changePanel('input');
    await input.prepare(false);
  },
  start: async () => {
    if (settings.voice.engine === 'system') {
      const id = voice.state.id;
      await systemSpeech.start((text) => {
        if (voice.state.id === id) voice.live(text);
      });
    }
  },
  stop: async (signal) => {
    if (settings.voice.engine === 'system') return systemSpeech.stop();
    const payload = await new Promise<{ data: Uint8Array; mime: string }>((resolve, reject) => {
      pendingAudio = {
        resolve,
        reject,
        timer: setTimeout(() => {
          pendingAudio = null;
          reject(new Error('没有收到录音，请检查麦克风权限'));
        }, 8000),
      };
    });
    return transcribe(payload.data, payload.mime, settings.voice, path.join(home, 'audio'), signal);
  },
  abort: () => {
    systemSpeech.abort();
    if (pendingAudio) {
      clearTimeout(pendingAudio.timer);
      pendingAudio.reject(new Error('录音已取消'));
      pendingAudio = null;
    }
  },
  submit: async (text) => {
    await input.submit(input.state.turnId!, text, true);
    autoCollapse();
  },
  cancel: () => input.cancel(),
  changed: () => {
    broadcast();
    autoCollapse();
  },
  confirmMs: () => settings.voice.confirmMs,
});

function settleCapture(allow: boolean) {
  if (!captureRequest) return;
  const request = captureRequest;
  captureRequest = null;
  if (request.timer) clearTimeout(request.timer);
  captureState = null;
  request.resolve(allow);
  broadcast();
  autoCollapse();
}
async function approveCapture(signal: AbortSignal) {
  if (signal.aborted) return false;
  if (settings.captureTier === 'always') return true;
  if (captureRequest) throw new Error('已有截屏请求');
  const phase = settings.captureTier === 'lesson' ? 'countdown' : 'pending';
  captureState = { phase, remaining: phase === 'countdown' ? 3 : 0 };
  expand();
  return new Promise<boolean>((resolve) => {
    const abort = () => {
      if (captureRequest === request) settleCapture(false);
    };
    const request = {
      resolve: (allow: boolean) => {
        signal.removeEventListener('abort', abort);
        resolve(allow);
      },
      timer: setTimeout(
        () => settleCapture(phase === 'countdown'),
        phase === 'countdown' ? 3000 : 60000,
      ),
    };
    captureRequest = request;
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else broadcast();
  });
}
async function consent(kind: 'start' | 'attach', topic: string, signal: AbortSignal) {
  if (signal.aborted) return false;
  if (connectionRequest) throw new Error('已有连接请求待处理');
  connection = { kind, topic };
  expand();
  return new Promise<boolean>((resolve) => {
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(false), 30000);
    const finish = (allow: boolean) => {
      if (connectionRequest !== finish) return;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      connectionRequest = null;
      connection = null;
      broadcast();
      resolve(allow);
    };
    connectionRequest = finish;
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else broadcast();
  });
}
async function action(a: Action) {
  if (quitting && a.type !== 'quit') throw new Error('应用正在退出');
  if (panelRecovering) {
    // Initial layout reports from the new document are harmless before its handshake.
    if (['panel-context', 'panel-motion-end', 'hover', 'resize'].includes(a.type))
      return snapshot();
    if (!['quit', 'board-change', 'edit'].includes(a.type))
      throw new Error('面板正在恢复，请稍后重试');
  }
  switch (a.type) {
    case 'prepare':
      error = null;
      if (!session || session.phase === 'ended') {
        expand();
        break;
      }
      changePanel('input');
      broadcast();
      if (voice.state.phase !== 'idle') throw new Error('请先完成或撤回语音输入');
      requireSession();
      await input.prepare();
      break;
    case 'copy-connect':
      clipboard.writeText(
        `请使用 $teach-me skill 连接本机 Teach me, Agent，开始一次教学。\n请运行：tma start\n未注册全局命令时可运行：node "${path.join(app.getAppPath(), 'bin', 'teach-me.mjs')}" start\n连接后用 wait 等待我的提问，用 say 回复。`,
      );
      break;
    case 'submit':
      await input.submit(a.turnId, a.text, a.attachBoard);
      break;
    case 'cancel':
      await input.cancel();
      break;
    case 'continue': {
      const s = requireSession();
      if (!['ready', 'waiting'].includes(s.phase) || input.state.phase !== 'idle')
        throw new Error('Agent 仍在处理中');
      await input.prepare();
      await input.submit(input.state.turnId!, settings.continueText, true);
      break;
    }
    case 'toggle-expanded':
      changePanel(panelState.mode === 'conversation' ? 'compose' : 'conversation');
      autoCollapse();
      break;
    case 'panel-mode': {
      const next = transitionPanel(panelState, a.mode, panelActivity());
      if (next.mode === 'mini' && panelState.mode !== 'mini') {
        await input.cancel();
      }
      changePanel(a.mode);
      autoCollapse();
      break;
    }
    case 'panel-context':
      hasDraft = a.hasDraft;
      toolsOpen = a.toolsOpen;
      reducedMotion = a.reducedMotion;
      if (reducedMotion) panelMotion?.finish();
      autoCollapse();
      break;
    case 'panel-motion-end':
      panelMotion?.complete(a.id);
      break;
    case 'hover':
      hover = a.on;
      autoCollapse();
      break;
    case 'resize':
      if (movingPanel || a.mode !== panelState.mode || a.layoutVersion !== panelLayoutVersion)
        break;
      panelHeights[a.mode] =
        a.mode === 'mini'
          ? 48
          : Math.max(
              a.mode === 'conversation' ? 240 : 64,
              Math.min(560, a.height * panel.webContents.getZoomFactor()),
            );
      setBounds(undefined, true);
      break;
    case 'settings-drag': {
      if (!settingsOpen || !settingsWindow.isVisible()) break;
      if (a.phase === 'start') {
        const content = settingsWindow.getContentBounds();
        settingsClientSize ||= { width: content.width, height: content.height };
        settingsDrag = {
          id: a.dragId,
          bounds: settingsWindow.getBounds(),
          content: { ...content, ...settingsClientSize },
        };
      } else if (settingsDrag?.id === a.dragId) {
        const b = settingsWindow.getBounds();
        const next = {
          ...b,
          x: Math.round(settingsDrag.bounds.x + a.dx),
          y: Math.round(settingsDrag.bounds.y + a.dy),
        };
        const area = screen.getDisplayMatching(next).workArea;
        const x = Math.max(area.x, Math.min(next.x, area.x + area.width - b.width));
        const y = Math.max(area.y, Math.min(next.y, area.y + area.height - b.height));
        // Preserve client size: reapplying outer bounds drifts at fractional Windows DPI.
        settingsWindow.setContentBounds({
          ...settingsDrag.content,
          x: settingsDrag.content.x + x - settingsDrag.bounds.x,
          y: settingsDrag.content.y + y - settingsDrag.bounds.y,
        });
        if (a.phase === 'end') settingsDrag = null;
      }
      break;
    }
    case 'panel-drag': {
      if (a.phase === 'start') {
        if (pointerDrag) break;
        movingPanel = true;
        panelLayoutVersion++;
        panelMotion?.finish();
        const bounds = panel.getBounds();
        const intent = panelMotion?.destination || bounds;
        pointerDrag = {
          id: a.dragId,
          bounds,
          size: { width: intent.width, height: intent.height },
        };
        if (collapseTimer) clearTimeout(collapseTimer);
      } else if (pointerDrag?.id === a.dragId) {
        panel.setBounds({
          x: Math.round(pointerDrag.bounds.x + a.dx),
          y: Math.round(pointerDrag.bounds.y + a.dy),
          ...pointerDrag.size,
        });
        if (a.phase === 'end') {
          pointerDrag = null;
          finishPanelMove();
        }
      }
      break;
    }
    case 'toggle-guides':
      guidesHidden = !guidesHidden;
      break;
    case 'clear':
      if (a.layer !== 'user') guides = [];
      if (a.layer !== 'agent') clearUserBoard();
      break;
    case 'edit':
      editing = a.on;
      if (editing) changePanel('input');
      overlay.setIgnoreMouseEvents(!editing);
      await setWindowInput(overlay, editing, false, windows);
      if (editing) {
        await foreground();
        if (!overlay.isVisible()) overlay.show();
        if (!overlay.isFocused()) overlay.focus();
        if (!overlay.isFocused()) {
          const handle = overlay.getNativeWindowHandle();
          await windows.activate(
            (handle.length >= 8
              ? handle.readBigUInt64LE()
              : BigInt(handle.readUInt32LE())
            ).toString(),
          );
        }
        if (editing && overlay.isFocused()) overlay.webContents.focus();
      } else {
        await windows.activate(lastExternal);
      }
      break;
    case 'board-change':
      if (a.epoch !== userBoard.epoch) return snapshot();
      userBoard = { ...userBoard, count: a.count };
      break;
    case 'settings':
      error = null;
      if (voice.state.phase !== 'idle') await voice.cancel();
      await saveSettings(a.settings);
      settings = a.settings;
      settingsWindow.setBackgroundColor(
        themes[settings.appearance.theme][snapshot().colorScheme].bg,
      );
      applyCaptureVisibility();
      autoCollapse();
      break;
    case 'settings-focus':
      if (a.on) {
        if (voice.state.phase !== 'idle') throw new Error('请先完成或撤回语音输入');
        await foreground();
        settingsOpen = true;
        if (collapseTimer) clearTimeout(collapseTimer);
        broadcast();
        settingsWindow.show();
        // A hidden Windows launcher can consume the first native show request.
        if (!settingsWindow.isVisible()) settingsWindow.showInactive();
        settingsWindow.focus();
      } else await closeSettings();
      break;
    case 'capture-decision':
      if (a.decision === 'interrupt' && captureState?.phase === 'countdown') {
        if (captureRequest?.timer) clearTimeout(captureRequest.timer);
        captureState = { phase: 'pending', remaining: 0 };
        if (captureRequest) captureRequest.timer = setTimeout(() => settleCapture(false), 60000);
      } else settleCapture(a.decision === 'allow');
      break;
    case 'connection-decision':
      connectionRequest?.(a.allow);
      break;
    case 'select-display': {
      if (!screen.getAllDisplays().some((d) => d.id === a.id)) throw new Error('屏幕已断开');
      const requested = displayRequest;
      await voice.cancel();
      if (quitting || panelRecovering || displayRequest !== requested) return snapshot();
      await input.cancel();
      if (quitting || panelRecovering || displayRequest !== requested) return snapshot();
      if (!screen.getAllDisplays().some((d) => d.id === a.id)) throw new Error('屏幕已断开');
      displayId = a.id;
      error = null;
      captureDisplayEpoch++;
      guides = [];
      clearUserBoard();
      lastShot = null;
      place();
      if (displayRequest) {
        clearTimeout(displayRequest.timer);
        displayRequest.resolve(true);
        displayRequest = null;
      }
      break;
    }
    case 'end':
      await voice.cancel();
      session?.end();
      await input.cancel();
      guides = [];
      settleCapture(false);
      editing = false;
      overlay.setIgnoreMouseEvents(true);
      await setWindowInput(overlay, false, false, windows);
      break;
    case 'quit':
      await shutdown('panel-quit');
      break;
    case 'voice-start':
      requireSession();
      if (input.state.phase === 'editing') await input.cancel();
      if (input.state.phase !== 'idle') throw new Error('请先发送或取消文字输入');
      await voice.start();
      break;
    case 'voice-stop':
      await voice.stop();
      break;
    case 'voice-cancel':
      await voice.cancel();
      break;
    case 'voice-audio':
      if (a.id !== voice.state.id || voice.state.phase !== 'transcribing' || !pendingAudio)
        throw new Error('录音已失效');
      clearTimeout(pendingAudio.timer);
      pendingAudio.resolve({ data: a.data, mime: a.mime });
      pendingAudio = null;
      break;
    case 'voice-error':
      if (a.id === voice.state.id) await voice.fail(a.error);
      break;
  }
  broadcast();
  return snapshot();
}

async function body(req: IncomingMessage) {
  let count = 0;
  const chunks: Buffer[] = [];
  for await (const data of req) {
    count += data.length;
    if (count > 512 * 1024) throw new Error('请求过大');
    chunks.push(Buffer.from(data));
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
function checkDriver(req: IncomingMessage) {
  if (!session || req.headers['x-session-token'] !== session.token)
    throw new Error('需要有效教学连接，请 start 或 attach');
  return requireSession();
}
async function startServer() {
  const server = createServer(async (req, res) => {
    const respond = (code: number, value: unknown) => {
      if (!res.destroyed) {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(value));
      }
    };
    if (req.headers['x-companion-token'] !== auth) {
      respond(401, { error: 'authentication required' });
      return;
    }
    const requestAbort = new AbortController();
    const disconnected = () => {
      if (!res.writableEnded) requestAbort.abort();
    };
    res.once('close', disconnected);
    const requireConnected = () => {
      if (res.destroyed || requestAbort.signal.aborted) throw new Error('连接请求已取消');
    };
    try {
      const route = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      const data = req.method === 'POST' ? await body(req) : {};
      if (quitting && route !== '/stop' && route !== '/status') throw new Error('应用正在退出');
      if (panelRecovering && ['/start', '/attach', '/capture'].includes(route))
        throw new Error('面板正在恢复，请稍后重试');
      let result: unknown;
      if (route === '/status') {
        const state = snapshot();
        result = {
          session: state.session,
          displayId: state.displayId,
          shots: [...shots.values()].slice(-10),
          home,
          version: '0.2.0',
        };
      } else if (route === '/start') {
        requireConnected();
        const topic = z.string().max(500).default('').parse(data.topic);
        if (session && session.phase !== 'ended') {
          if (req.headers['x-session-token'] === session.token)
            result = { id: session.id, token: session.token };
          else throw new Error('已有活跃教学，请先结束');
        } else {
          if (startInProgress) throw new Error('已有教学启动请求正在处理');
          startInProgress = true;
          try {
            const free = !!launchSecret && data.launchSecret === launchSecret;
            if (!free && !(await consent('start', topic, requestAbort.signal)))
              throw new Error('用户拒绝连接');
            requireConnected();
            if (data.displayId !== undefined) {
              const selected = z.number().int().parse(data.displayId);
              if (!screen.getAllDisplays().some((d) => d.id === selected))
                throw new Error('指定屏幕不存在');
              if (selected !== target().id) clearUserBoard();
              displayId = selected;
              place();
            } else if (screen.getAllDisplays().length > 1) {
              const selected = await new Promise<boolean>((resolve) => {
                const abort = () => finish(false);
                const finish = (allow: boolean) => {
                  if (displayRequest !== request) return;
                  clearTimeout(request.timer);
                  requestAbort.signal.removeEventListener('abort', abort);
                  displayRequest = null;
                  broadcast();
                  resolve(allow);
                };
                const request = {
                  resolve: finish,
                  timer: setTimeout(() => finish(false), 30000),
                };
                displayRequest = request;
                requestAbort.signal.addEventListener('abort', abort, { once: true });
                expand();
                if (requestAbort.signal.aborted) abort();
                else broadcast();
              });
              if (!selected) throw new Error('尚未选择教学屏幕');
            } else {
              displayId = screen.getPrimaryDisplay().id;
            }
            if (quitting) throw new Error('应用正在退出');
            requireConnected();
            await input.cancel();
            requireConnected();
            if (quitting) throw new Error('应用正在退出');
            requireTeachingDisplay();
            launchSecret = '';
            const hadSession = session !== null;
            session = new Session(topic, broadcast);
            guides = [];
            if (hadSession) clearUserBoard();
            lastShot = null;
            shots.clear();
            originals.clear();
            result = { id: session.id, token: session.token, home };
            broadcast();
          } finally {
            startInProgress = false;
          }
        }
      } else if (route === '/attach') {
        requireConnected();
        const requested = session;
        if (!requested || data.session !== requested.id || requested.phase === 'ended')
          throw new Error('会话不存在或已结束');
        if (!(await consent('attach', requested.topic, requestAbort.signal)))
          throw new Error('用户拒绝连接');
        requireConnected();
        if (session !== requested || requireSession() !== requested)
          throw new Error('会话已变更，请重新连接');
        result = { id: requested.id, token: requested.token };
      } else if (route === '/stop') {
        await shutdown('api-stop');
        result = { ok: true };
      } else {
        const active = checkDriver(req);
        switch (route) {
          case '/wait': {
            requireConnected();
            runtimeEvent('wait-start');
            const messages = await active.wait(
              z.number().min(1).max(480000).default(480000).parse(data.timeoutMs),
              requestAbort.signal,
            );
            runtimeEvent('wait-complete', { messages: messages.length });
            result = {
              messages,
              ended: active.phase === 'ended',
              timeout: !messages.length && active.phase !== 'ended',
            };
            break;
          }
          case '/ack':
            active.ack(z.number().int().parse(data.id));
            result = { ok: true };
            break;
          case '/say':
            active.say(z.string().trim().min(1).max(8000).parse(data.text));
            expand('reply');
            result = { ok: true };
            break;
          case '/show': {
            const scene = parseScene(data);
            const display = requireTeachingDisplay();
            const shot = shots.get(scene.shot || lastShot?.id || '');
            if (!shot) throw new Error('先 capture 或接收用户截图后再画');
            if (shot.scaleFactor !== display.scaleFactor)
              throw new Error('屏幕缩放已变，请重新 capture');
            const nextGuides = mapGuides(scene, shot, { ...display.bounds }, display.id);
            const html = nextGuides.filter(
              (g): g is Extract<Guide, { type: 'html' }> => g.type === 'html',
            );
            if (html.length > 1) throw new Error('每个场景最多一段 HTML');
            if (html[0]) {
              validateHtmlArea(html[0].rect, display.bounds);
              validateHtmlSource(html[0].html);
            }
            guides = nextGuides;
            htmlHost.clear();
            htmlHost.visible(!guidesHidden);
            if (html[0]) await htmlHost.show(html[0], display);
            active.say(scene.say);
            expand('reply');
            result = { drawn: guides.length };
            break;
          }
          case '/clear':
            guides = [];
            if (data.all === true) clearUserBoard();
            result = { ok: true };
            break;
          case '/capture': {
            const scope = captureScope(active, requireConnected);
            if (!(await approveCapture(requestAbort.signal))) throw new Error('截屏未获允许');
            scope.assertCurrent();
            let shot: Shot | null = null;
            for (let n = 0; n < 3; n++) {
              try {
                shot = await captureScreen(scope);
                break;
              } catch (e) {
                scope.assertCurrent();
                if (n === 2) throw e;
                await wait(200);
              }
            }
            scope.assertCurrent();
            lastShot = shot;
            result = { shot };
            break;
          }
          case '/zoom': {
            const assertCurrent = imageSessionScope(active, requireConnected);
            assertCurrent();
            const source = shots.get(z.string().optional().parse(data.shot) || lastShot?.id || '');
            if (!source) throw new Error('截图不存在');
            const rect = z
              .tuple([
                z.number().int().nonnegative(),
                z.number().int().nonnegative(),
                z.number().int().positive(),
                z.number().int().positive(),
              ])
              .parse(data.rect);
            const id = `s${++shotSequence}`;
            try {
              const resultShot = await zoomShot(
                source,
                originals.get(source.id),
                rect,
                id,
                assertCurrent,
              );
              assertCurrent();
              shots.set(resultShot.shot.id, resultShot.shot);
              originals.set(resultShot.shot.id, resultShot.original);
              lastShot = resultShot.shot;
              result = { shot: lastShot };
            } catch (e) {
              for (const file of zoomFiles(source, id)) {
                try {
                  await fs.rm(file, { force: true });
                } catch (cleanupError) {
                  runtimeEvent('zoom-cleanup-failed', failureMetadata(cleanupError));
                }
              }
              throw e;
            }
            break;
          }
          case '/board':
            result = {
              userStrokes: userBoard.count,
              userElements: userBoard.count,
              agentStrokes: guides.filter((g) => g.type === 'stroke').length,
            };
            break;
          default:
            respond(404, { error: 'unknown route' });
            return;
        }
        broadcast();
      }
      respond(200, result);
    } catch (e) {
      respond(400, { error: e instanceof Error ? e.message : String(e) });
    } finally {
      res.removeListener('close', disconnected);
    }
  });
  server.requestTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server failed');
  await fs.writeFile(
    endpointFile,
    JSON.stringify({ pid: process.pid, port: address.port, token: auth }),
    { mode: 0o600 },
  );
  return server;
}

function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shutdownTask) return shutdownTask;
  quitting = true;
  runtimeEvent('shutdown', { reason });
  // A stuck OS/file operation must not leave an uncloseable single-instance lock.
  const deadline = setTimeout(() => {
    runtimeEvent('shutdown-timeout');
    windows.dispose();
    app.exit(1);
  }, 5000);
  app.once('will-quit', () => clearTimeout(deadline));
  const cleanup = async (step: string, run: () => unknown) => {
    try {
      await run();
    } catch (e) {
      runtimeEvent('shutdown-cleanup-failed', { step, ...failureMetadata(e) });
    }
  };
  shutdownTask = (async () => {
    await cleanup('motion', () => panelMotion?.dispose());
    await cleanup('html', () => htmlHost.clear());
    // Settle consumers before any asynchronous native or filesystem cleanup.
    await cleanup('session', () => session?.end());
    await cleanup('requests', () => {
      if (displayRequest) {
        clearTimeout(displayRequest.timer);
        displayRequest.resolve(false);
        displayRequest = null;
      }
      settleCapture(false);
      connectionRequest?.(false);
    });
    await cleanup('voice', () => voice.cancel());
    await cleanup('input', () => input.cancel());
    await cleanup('endpoint', () => fs.rm(endpointFile, { force: true }));
    // Let an API stop response flush before closing windows and the HTTP server.
    setTimeout(() => {
      readyToQuit = true;
      if (exitCode) {
        windows.dispose();
        app.exit(exitCode);
      } else app.quit();
    }, 100);
  })();
  return shutdownTask;
}

async function loadWindow(w: BrowserWindow, mode: string) {
  if (process.env.TMA_DEV_URL) await w.loadURL(`${process.env.TMA_DEV_URL}?mode=${mode}`);
  else await w.loadFile(path.join(__dirname, '../ui/index.html'), { query: { mode } });
}
async function recoverPanel() {
  if (quitting) return;
  const now = Date.now();
  if (panelRecovering || now - panelRecoveryAt < 60000) {
    runtimeEvent('panel-recovery-exhausted');
    await shutdown('panel-recovery-exhausted', 1);
    return;
  }
  panelRecoveryAt = now;
  panelRecovering = true;
  runtimeEvent('panel-recovery-start');
  const deadline = setTimeout(() => {
    runtimeEvent('panel-recovery-timeout');
    void shutdown('panel-recovery-timeout', 1);
  }, 10000);
  try {
    // A crashed UI cannot consent or complete an input. Keep committed Session data.
    if (displayRequest) {
      clearTimeout(displayRequest.timer);
      displayRequest.resolve(false);
      displayRequest = null;
    }
    settleCapture(false);
    connectionRequest?.(false);
    await voice.cancel();
    await input.cancel();
    if (quitting) return;
    panelMotion?.finish();
    movingPanel = false;
    pointerDrag = null;
    hasDraft = false;
    toolsOpen = false;
    hover = false;
    panelState = { mode: 'compose', unread: panelState.unread };
    panelLayoutVersion++;
    panelHeights.compose = 76;
    error = '面板已恢复。未发送的草稿或录音可能丢失，请重新输入。';
    setBounds();
    await setWindowInput(panel, false, true, windows);
    if (quitting) return;
    const ready = new Promise<void>((resolve) => {
      panelRecoveryReady = () => {
        panelRecovering = false;
        resolve();
      };
    });
    await loadWindow(panel, 'panel');
    await ready;
    if (quitting) return;
    error = '面板已恢复。未发送的草稿或录音可能丢失，请重新输入。';
    panel.showInactive();
    broadcast();
    runtimeEvent('panel-recovery-complete');
  } catch (e) {
    runtimeEvent('panel-recovery-failed', failureMetadata(e));
    await shutdown('panel-recovery-failed', 1);
  } finally {
    clearTimeout(deadline);
    panelRecoveryReady = null;
    // During terminal failure, keep actions blocked until shutdown completes.
    if (!quitting) panelRecovering = false;
  }
}
async function closeSettings() {
  settingsDrag = null;
  const focused = settingsWindow.isFocused();
  settingsOpen = false;
  settingsWindow.hide();
  broadcast();
  if (focused && input.state.phase === 'editing') {
    panel.focus();
    panel.webContents.focus();
  } else if (focused && input.state.phase === 'idle') await windows.activate(lastExternal);
  autoCollapse();
}
app
  .whenReady()
  .then(async () => {
    await fs.mkdir(home, { recursive: true });
    runtimeEvent('startup');
    await pruneSessions(home, 7);
    await readSettings();
    try {
      panelPosition = panelPositionSchema.parse(
        JSON.parse(await fs.readFile(path.join(home, 'panel-position.json'), 'utf8')),
      );
    } catch {
      panelPosition = null;
    }
    const preferences = {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    };
    panel = new BrowserWindow({
      title: 'Teach me, Agent',
      width: 120,
      height: 48,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      focusable: true,
      minimizable: false,
      skipTaskbar: false,
      alwaysOnTop: true,
      webPreferences: preferences,
    });
    panelMotion = new PanelMotion(panel, (active) => {
      panelAnimating = active;
      broadcast();
    });
    panel.on('blur', () => autoCollapse());
    overlay = new BrowserWindow({
      title: 'Teach me Overlay',
      ...target().bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      focusable: true,
      minimizable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: preferences,
    });
    const area = screen.getDisplayMatching(panel.getBounds()).workArea;
    const settingsWidth = Math.min(640, area.width);
    const settingsHeight = Math.min(680, area.height);
    settingsWindow = new BrowserWindow({
      title: 'Teach me, Agent · 设置',
      frame: false,
      modal: false,
      x: Math.round(area.x + (area.width - settingsWidth) / 2),
      y: Math.round(area.y + (area.height - settingsHeight) / 2),
      width: settingsWidth,
      height: settingsHeight,
      minWidth: Math.min(440, settingsWidth),
      minHeight: Math.min(420, settingsHeight),
      show: false,
      backgroundColor: themes[settings.appearance.theme][snapshot().colorScheme].bg,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      webPreferences: preferences,
    });
    settingsWindow.setMenu(null);
    let manualSettingsResize = false;
    settingsWindow.on('will-resize', () => {
      manualSettingsResize = true;
    });
    settingsWindow.on('resized', () => {
      if (!manualSettingsResize) return;
      manualSettingsResize = false;
      const { width, height } = settingsWindow.getContentBounds();
      settingsClientSize = { width, height };
    });
    nativeTheme.on('updated', () => {
      if (settings.appearance.mode === 'system' && !quitting) {
        settingsWindow.setBackgroundColor(
          themes[settings.appearance.theme][snapshot().colorScheme].bg,
        );
        broadcast();
      }
    });
    settingsWindow.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      closeSettings().catch(fail);
    });
    for (const w of [panel, overlay, settingsWindow]) {
      w.setContentProtection(!settings.showInScreenCapture);
      w.setAlwaysOnTop(true, 'screen-saver');
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      w.webContents.on('will-navigate', (e) => e.preventDefault());
    }
    await setWindowInput(panel, false, true, windows);
    await setWindowInput(overlay, false, false, windows);
    panel.on('show', () => panel.setSkipTaskbar(false));
    overlay.on('show', () => overlay.setSkipTaskbar(true));
    for (const [role, window] of [
      ['panel', panel],
      ['overlay', overlay],
      ['settings', settingsWindow],
    ] as const) {
      const log = (event: string) => () =>
        runtimeEvent(`window-${event}`, {
          role,
          visible: window.isVisible(),
          minimized: window.isMinimized(),
        });
      window.on('show', log('show'));
      window.on('hide', log('hide'));
      window.on('minimize', log('minimize'));
      window.on('restore', log('restore'));
      window.on('focus', log('focus'));
      window.on('blur', log('blur'));
    }
    overlay.setIgnoreMouseEvents(true);
    overlay.on('focus', () => {
      if (editing) overlay.webContents.focus();
    });
    applyCaptureVisibility();
    place();
    ipcMain.handle('companion:snapshot', (e) => {
      if (
        ![panel.webContents.id, overlay.webContents.id, settingsWindow.webContents.id].includes(
          e.sender.id,
        )
      )
        throw new Error('unknown sender');
      if (e.sender.id === panel.webContents.id) panelRecoveryReady?.();
      return snapshot();
    });
    ipcMain.handle('companion:action', async (e, value) => {
      if (
        ![panel.webContents.id, overlay.webContents.id, settingsWindow.webContents.id].includes(
          e.sender.id,
        )
      )
        throw new Error('unknown sender');
      const parsed = actionSchema.parse(value);
      if (
        e.sender.id === settingsWindow.webContents.id &&
        !['settings', 'settings-focus', 'settings-drag', 'select-display'].includes(parsed.type)
      )
        throw new Error('settings action rejected');
      if (parsed.type === 'settings-drag' && e.sender.id !== settingsWindow.webContents.id)
        throw new Error('settings drag sender rejected');
      if (e.sender.id === overlay.webContents.id && !['board-change', 'edit'].includes(parsed.type))
        throw new Error('overlay action rejected');
      if (parsed.type === 'board-change' && e.sender.id !== overlay.webContents.id)
        throw new Error('board sender rejected');
      const recoveryAt = panelRecoveryAt;
      try {
        return await action(parsed);
      } catch (err) {
        if (
          !quitting &&
          !panelRecovering &&
          recoveryAt === panelRecoveryAt &&
          e.sender.id !== settingsWindow.webContents.id
        )
          fail(err);
        throw err;
      }
    });
    await Promise.all([
      loadWindow(panel, 'panel'),
      loadWindow(overlay, 'overlay'),
      loadWindow(settingsWindow, 'settings'),
    ]);
    overlay.showInactive();
    panel.showInactive();
    await startServer();
    let checking = false;
    fgTimer = setInterval(() => {
      session?.refreshConnection();
      if (!checking) {
        checking = true;
        foreground()
          .catch(() => {})
          .finally(() => {
            checking = false;
          });
      }
    }, 150);
    for (const [key, handler] of [
      [
        'Control+Alt+W',
        async () => {
          if (talkBusy) return;
          talkBusy = true;
          const recoveryAt = panelRecoveryAt;
          try {
            await wait(280);
            if (quitting || panelRecovering || recoveryAt !== panelRecoveryAt) return;
            const held = await windows.talkDown();
            if (quitting || panelRecovering || recoveryAt !== panelRecoveryAt) return;
            if (!held) {
              await action({ type: 'prepare' });
              return;
            }
            const starting = action({ type: 'voice-start' });
            while (await windows.talkDown()) {
              if (quitting || panelRecovering || recoveryAt !== panelRecoveryAt) return;
              await wait(40);
            }
            if (quitting || panelRecovering || recoveryAt !== panelRecoveryAt) return;
            await voice.stop();
            await starting;
          } finally {
            talkBusy = false;
          }
        },
      ],
      ['Control+Alt+H', () => action({ type: 'toggle-guides' })],
    ] as const) {
      if (
        !globalShortcut.register(key, () => {
          if (quitting || panelRecovering) return;
          const recoveryAt = panelRecoveryAt;
          Promise.resolve(handler()).catch((e) => {
            if (!quitting && !panelRecovering && recoveryAt === panelRecoveryAt) fail(e);
          });
        })
      )
        fail(new Error(`快捷键 ${key} 被占用`));
    }
    observeDisplays();
    panel.on('close', (e) => {
      if (!readyToQuit) {
        e.preventDefault();
        shutdown('native-window-close').catch(fail);
      }
    });
    broadcast();
    runtimeReady = true;
  })
  .catch((e) => {
    runtimeEvent('startup-failed', failureMetadata(e));
    console.error(e);
    app.exit(1);
  });
app.on('window-all-closed', () => {
  runtimeEvent('window-all-closed');
  app.quit();
});
app.on('before-quit', (event) => {
  runtimeEvent('before-quit', { requested: quitting });
  if (!readyToQuit) {
    event.preventDefault();
    if (!quitting) void shutdown('app-quit');
  }
});
app.on('quit', (_event, exitCode) => runtimeEvent('quit', { exitCode }));
app.on('will-quit', () => {
  runtimeEvent('will-quit');
  globalShortcut.unregisterAll();
  windows.dispose();
  if (fgTimer) clearInterval(fgTimer);
  if (collapseTimer) clearTimeout(collapseTimer);
});
app.on('render-process-gone', (_event, contents, details) => {
  const role =
    panel?.webContents === contents
      ? 'panel'
      : overlay?.webContents === contents
        ? 'overlay'
        : settingsWindow?.webContents === contents
          ? 'settings'
          : 'html';
  runtimeEvent('renderer-exit', { role, reason: details.reason, exitCode: details.exitCode });
  if (role === 'panel' && runtimeReady && !quitting) void recoverPanel();
});
app.on('child-process-gone', (_event, details) => {
  runtimeEvent('child-exit', {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
  });
});
