import { app, BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { htmlDocument, validateHtmlArea } from '../core/html.ts';
import type { Guide } from '../shared/protocol.ts';

export class HtmlHost {
  private window: BrowserWindow | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
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
    const window = new BrowserWindow({
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
    this.window = window;
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
    window.webContents.on('render-process-gone', () => {
      if (this.window === window) {
        this.clear();
        this.changed('自定义指引进程已退出，不会自动恢复。');
      }
    });
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(document));
    if (this.window !== window || window.isDestroyed()) return;
    window.showInactive();
    this.timer = setTimeout(() => {
      this.clear();
      this.changed('');
    }, item.ttl);
    let overload = 0;
    this.watchdog = setInterval(() => {
      if (window.isDestroyed()) return;
      const metric = app.getAppMetrics().find((m) => m.pid === window.webContents.getOSProcessId());
      const tooMuch =
        metric && (metric.memory.workingSetSize > 192 * 1024 || metric.cpu.percentCPUUsage > 30);
      overload = tooMuch ? overload + 1 : 0;
      if (overload >= 2) {
        this.clear();
        this.changed('自定义指引占用过高，已关闭。');
      }
    }, 1000);
  }
  visible(show: boolean) {
    if (this.window && !this.window.isDestroyed()) {
      if (show && !this.window.isVisible()) this.window.showInactive();
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
    if (window && !window.isDestroyed()) window.destroy();
  }
}
