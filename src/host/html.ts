import { app, BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { htmlDocument, validateHtmlArea } from '../core/html.ts';
import type { Guide } from '../shared/protocol.ts';

export class HtmlHost {
  private window: BrowserWindow | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private cancelLoad: ((error: Error) => void) | null = null;
  private loaded = false;
  private requestedVisible = true;
  private captureVisible = false;
  setCaptureVisible(visible: boolean) {
    this.captureVisible = visible;
    if (this.window && !this.window.isDestroyed()) this.window.setContentProtection(!visible);
  }
  constructor(privateChanged: (reason: string) => void) {
    this.changed = privateChanged;
  }
  private changed: (reason: string) => void;
  async show(
    item: Extract<Guide, { type: 'html' }>,
    display: { bounds: { x: number; y: number; width: number; height: number } },
  ) {
    validateHtmlArea(item.rect, display.bounds);
    const document = htmlDocument(item.html);
    this.clear();
    const [x, y, w, h] = item.rect;
    let window: BrowserWindow;
    try {
      window = new BrowserWindow({
        x: Math.round(display.bounds.x + x),
        y: Math.round(display.bounds.y + y),
        width: Math.round(w),
        height: Math.round(h),
        show: false,
        frame: false,
        focusable: false,
        resizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          partition: `html-${randomUUID()}`,
          backgroundThrottling: true,
        },
      });
    } catch (e) {
      this.changed('自定义指引窗口创建失败，请重试。');
      throw e;
    }
    this.window = window;
    let rejectLoad!: (error: Error) => void;
    const canceled = new Promise<void>((_resolve, reject) => {
      rejectLoad = reject;
    });
    // A synchronous setup failure can cancel before Promise.race is attached.
    void canceled.catch(() => {});
    this.cancelLoad = rejectLoad;
    const deadline = setTimeout(() => rejectLoad(new Error('自定义指引加载超时')), 10000);
    const close = (reason: string) => {
      if (this.window !== window) return;
      this.clear();
      this.changed(reason);
    };
    try {
      window.setContentProtection(!this.captureVisible);
      window.setAlwaysOnTop(true, 'screen-saver');
      window.setIgnoreMouseEvents(true);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (e) => e.preventDefault());
      window.webContents.on('will-redirect', (e) => e.preventDefault());
      window.webContents.session.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'file://*/*'] },
        (_details, callback) => callback({ cancel: true }),
      );
      window.webContents.session.on('will-download', (e) => e.preventDefault());
      window.webContents.on('render-process-gone', () =>
        close('自定义指引进程已退出，不会自动恢复。'),
      );
      window.on('closed', () => close('自定义指引窗口已关闭。'));
      let overload = 0;
      this.watchdog = setInterval(() => {
        if (this.window !== window || window.isDestroyed()) return;
        try {
          const metric = app
            .getAppMetrics()
            .find((m) => m.pid === window.webContents.getOSProcessId());
          const tooMuch =
            metric &&
            (metric.memory.workingSetSize > 192 * 1024 || metric.cpu.percentCPUUsage > 30);
          overload = tooMuch ? overload + 1 : 0;
          if (overload >= 2) close('自定义指引占用过高，已关闭。');
        } catch {
          close('无法检查自定义指引资源占用，已关闭。');
        }
      }, 1000);
      await Promise.race([
        window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(document)),
        canceled,
      ]);
      if (this.window !== window || window.isDestroyed()) throw new Error('自定义指引已取消');
      this.loaded = true;
      this.visible(this.requestedVisible);
      this.timer = setTimeout(() => close(''), item.ttl);
    } catch (e) {
      close('自定义指引加载失败，已关闭，请重试。');
      throw e;
    } finally {
      clearTimeout(deadline);
      if (this.window === window) this.cancelLoad = null;
    }
  }
  visible(show: boolean) {
    this.requestedVisible = show;
    if (this.window && !this.window.isDestroyed()) {
      if (show && this.loaded && !this.window.isVisible()) this.window.showInactive();
      else if (!show && this.window.isVisible()) this.window.hide();
    }
  }
  clear() {
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.timer = null;
    this.watchdog = null;
    const window = this.window;
    this.window = null;
    this.loaded = false;
    const cancel = this.cancelLoad;
    this.cancelLoad = null;
    cancel?.(new Error('自定义指引已取消'));
    if (window && !window.isDestroyed()) window.destroy();
  }
}
