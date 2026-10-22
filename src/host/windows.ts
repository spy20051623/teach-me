import { spawn } from 'node:child_process';

// Application platform adapter, kept outside the domain and renderer.
const members = `
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern short GetAsyncKeyState(int v);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, System.IntPtr p);
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a,uint b,bool attach);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr h, int index);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int SetWindowLong(System.IntPtr h, int index, int value);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int w, int height, uint flags);
public static bool InputPolicy(System.IntPtr h, bool visible, bool acceptInput) {
  if(!IsWindow(h)) return false;
  int oldStyle=GetWindowLong(h,-20);
  int style=visible ? (oldStyle|0x00040000)&~0x00000080 : (oldStyle&~0x00040000)|0x00000080;
  style=acceptInput ? style&~0x08000000 : style|0x08000000;
  if(style!=oldStyle) {
    SetWindowLong(h,-20,style);
    if(!SetWindowPos(h,System.IntPtr.Zero,0,0,0,0,0x0037)) return false;
  }
  return GetWindowLong(h,-20)==style;
}
public static bool Activate(System.IntPtr h) {
  if(!IsWindow(h))return false;
  uint foreground=GetWindowThreadProcessId(GetForegroundWindow(),System.IntPtr.Zero);
  uint current=GetCurrentThreadId();
  bool attached=foreground!=0 && current!=foreground && AttachThreadInput(current,foreground,true);
  try { SetForegroundWindow(h);return GetForegroundWindow()==h; }
  finally { if(attached)AttachThreadInput(current,foreground,false); }
}
`;
type Failure =
  | 'timeout'
  | 'startup-timeout'
  | 'exit-timeout'
  | 'exit'
  | 'spawn'
  | 'write'
  | 'protocol'
  | 'disposed'
  | 'native-rejected'
  | 'recovering';
type Reply = { value: string | null; failure?: Failure };
type Reporter = (event: string, detail: Record<string, string | number | boolean>) => void;
type Helper = {
  child: ReturnType<typeof spawn>;
  generation: number;
  ready: boolean;
  entered: boolean;
  started: number;
  startup: Promise<Failure | null>;
  finishStartup: (failure: Failure | null) => void;
  startupTimer: ReturnType<typeof setTimeout> | null;
  exited: Promise<void>;
  finishExit: () => void;
  closed: boolean;
  draining: boolean;
  buffer: string;
  stderrBytes: number;
  pending: Map<number, (value: string | null, failure?: Failure) => void>;
};
type ReadyResult = { helper: Helper } | { failure: Failure; generation?: number };
type Startup = {
  promise: Promise<ReadyResult>;
  canceled: boolean;
  cancellation: Promise<Failure>;
  cancel: () => void;
};
const codes: Record<Failure, string> = {
  timeout: 'NATIVE_TIMEOUT',
  'startup-timeout': 'NATIVE_STARTUP_TIMEOUT',
  'exit-timeout': 'NATIVE_HELPER_EXIT_TIMEOUT',
  exit: 'NATIVE_HELPER_EXIT',
  spawn: 'NATIVE_SPAWN_FAILED',
  write: 'NATIVE_WRITE_FAILED',
  protocol: 'NATIVE_PROTOCOL_ERROR',
  disposed: 'NATIVE_DISPOSED',
  'native-rejected': 'NATIVE_POLICY_REJECTED',
  recovering: 'NATIVE_HELPER_RECOVERING',
};
function nativeError(message: string, failure: Failure) {
  if (failure === 'recovering') message = 'Windows辅助进程正在恢复，请稍后重试';
  if (failure === 'startup-timeout') message = 'Windows辅助进程启动超时，请重试';
  if (failure === 'exit-timeout') message = 'Windows辅助进程尚未退出，请稍后重试';
  return Object.assign(new Error(message), { code: codes[failure] });
}
export class WindowsAdapter {
  private helper: Helper | null = null;
  private startup: Startup | null = null;
  private retiringStartup: Helper | null = null;
  private sequence = 0;
  private generation = 0;
  private report: Reporter;
  constructor(report: Reporter = () => {}) {
    this.report = (event, detail) => {
      try {
        report(event, detail);
      } catch {
        /* Diagnostics must never alter lifecycle. */
      }
    };
  }
  private close(helper: Helper, failure: Failure, kill = false, exitCode?: number | null) {
    if (helper.closed) return;
    helper.closed = true;
    // A timed-out startup can still be alive even after kill(). Do not let later
    // polling create additional helpers until its actual exit is observed.
    if (failure === 'startup-timeout') this.retiringStartup = helper;
    if (this.helper === helper) this.helper = null;
    helper.buffer = '';
    if (helper.startupTimer) clearTimeout(helper.startupTimer);
    helper.startupTimer = null;
    helper.finishStartup(failure);
    for (const finish of helper.pending.values()) finish(null, failure);
    helper.pending.clear();
    this.report('native-helper-ended', {
      generation: helper.generation,
      reason: failure,
      ready: helper.ready,
      entered: helper.entered,
      elapsedMs: Date.now() - helper.started,
      stderrBytes: helper.stderrBytes,
      ...(exitCode == null ? {} : { exitCode }),
    });
    if (kill) {
      try {
        helper.child.kill();
      } catch {
        this.report('native-helper-kill-failed', { generation: helper.generation });
      }
    }
  }
  private ensure(): Helper {
    if (this.helper) return this.helper;
    if (process.platform !== 'win32') throw new Error('当前桌面版本仅支持 Windows');
    const script = `$ErrorActionPreference='Stop'; [Console]::WriteLine('@ENTER'); Add-Type -TypeDefinition 'public class CompanionNative {${members}}'; [Console]::WriteLine('@READY'); while($null -ne ($line=[Console]::ReadLine())) { try { $q=$line|ConvertFrom-Json; $v=''; if($q.kind -eq 'fg'){$v=[CompanionNative]::GetForegroundWindow().ToInt64().ToString()}; if($q.kind -eq 'activate'){ $v=[CompanionNative]::Activate([IntPtr]([long]$q.handle)).ToString() }; if($q.kind -eq 'down'){$v=(([CompanionNative]::GetAsyncKeyState(87) -band 0x8000) -ne 0).ToString()}; if($q.kind -eq 'input'){$v=[CompanionNative]::InputPolicy([IntPtr]([long]$q.handle),[bool]$q.visible,[bool]$q.acceptInput).ToString()}; if($q.kind -eq 'style'){$v=[CompanionNative]::GetWindowLong([IntPtr]([long]$q.handle),-20).ToString()}; [Console]::WriteLine(('@'+$q.id+'='+$v)); } catch { [Console]::WriteLine(('@'+$q.id+'=!ERROR')); } }`;
    const started = Date.now();
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let finishStartup!: (failure: Failure | null) => void;
    const startup = new Promise<Failure | null>((resolve) => {
      finishStartup = resolve;
    });
    let finishExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      finishExit = resolve;
    });
    const helper: Helper = {
      child,
      generation: ++this.generation,
      ready: false,
      entered: false,
      started,
      startup,
      finishStartup,
      startupTimer: null,
      exited,
      finishExit,
      closed: false,
      draining: false,
      buffer: '',
      stderrBytes: 0,
      pending: new Map(),
    };
    this.helper = helper;
    this.report('native-helper-start', { generation: helper.generation });
    helper.startupTimer = setTimeout(() => this.close(helper, 'startup-timeout', true), 10000);
    child.stdout!.on('data', (data) => {
      if (helper.closed) return;
      helper.buffer += String(data);
      let i;
      while ((i = helper.buffer.indexOf('\n')) >= 0) {
        const line = helper.buffer.slice(0, i).trim();
        helper.buffer = helper.buffer.slice(i + 1);
        if (line === '@ENTER') {
          if (!helper.entered)
            this.report('native-helper-enter', {
              generation: helper.generation,
              elapsedMs: Date.now() - helper.started,
            });
          helper.entered = true;
          continue;
        }
        if (line === '@READY') {
          if (helper.ready) continue;
          helper.ready = true;
          if (helper.startupTimer) clearTimeout(helper.startupTimer);
          helper.startupTimer = null;
          helper.finishStartup(null);
          this.report('native-helper-ready', {
            generation: helper.generation,
            elapsedMs: Date.now() - helper.started,
          });
          continue;
        }
        const match = /^@(\d+)=(.*)$/.exec(line);
        if (!match) continue;
        const finish = helper.pending.get(Number(match[1]));
        if (match[2] === '!ERROR') finish?.(null, 'protocol');
        else finish?.(match[2]);
      }
    });
    // Drain stderr, but never record raw PowerShell errors, commands or handles.
    child.stderr!.on('data', (data) => {
      helper.stderrBytes += Buffer.byteLength(data);
    });
    child.stdout!.on('error', () => this.close(helper, 'protocol', true));
    child.stderr!.on('error', () => this.close(helper, 'protocol', true));
    child.on('error', () => this.close(helper, 'spawn', true));
    child.on('exit', (code) => {
      if (this.retiringStartup === helper) this.retiringStartup = null;
      helper.finishExit();
      this.close(helper, 'exit', false, code);
    });
    child.stdin!.on('error', () => this.close(helper, 'write', true));
    return helper;
  }
  private ready(): Promise<ReadyResult> {
    // Keep concurrent callers on the same handshake, including the exit-confirmation gap.
    if (this.startup) return this.startup.promise;
    if (this.retiringStartup)
      return Promise.resolve({
        failure: 'exit-timeout',
        generation: this.retiringStartup.generation,
      });
    if (this.helper?.ready && !this.helper.closed) return Promise.resolve({ helper: this.helper });
    let cancel!: () => void;
    const cancellation = new Promise<Failure>((resolve) => {
      cancel = () => resolve('disposed');
    });
    const startup: Startup = {
      promise: Promise.resolve({ failure: 'disposed' }),
      canceled: false,
      cancellation,
      cancel: () => {
        startup.canceled = true;
        cancel();
      },
    };
    this.startup = startup;
    startup.promise = this.start(startup).finally(() => {
      if (this.startup === startup) this.startup = null;
    });
    return startup.promise;
  }
  private async start(startup: Startup): Promise<ReadyResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (startup.canceled) return { failure: 'disposed' };
      let helper: Helper;
      try {
        helper = this.ensure();
      } catch {
        return { failure: 'spawn' };
      }
      const failure = await Promise.race([helper.startup, startup.cancellation]);
      if (startup.canceled) return { failure: 'disposed', generation: helper.generation };
      if (failure === null) {
        if (helper.closed || this.helper !== helper)
          return { failure: 'exit', generation: helper.generation };
        return { helper };
      }
      if (failure !== 'startup-timeout' || attempt === 1)
        return { failure, generation: helper.generation };
      // No command has been sent to this helper. A single retry is safe only after exit.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const stopped = await Promise.race([
        helper.exited.then(() => null),
        startup.cancellation,
        new Promise<Failure>((resolve) => {
          deadline = setTimeout(() => resolve('exit-timeout'), 2000);
        }),
      ]).finally(() => clearTimeout(deadline));
      if (startup.canceled) return { failure: 'disposed', generation: helper.generation };
      if (stopped !== null) return { failure: stopped, generation: helper.generation };
      this.report('native-helper-startup-retry', {
        generation: helper.generation,
        elapsedMs: Date.now() - helper.started,
      });
    }
    return { failure: 'startup-timeout' };
  }
  private async call(
    kind: string,
    handle?: string,
    visible?: boolean,
    acceptInput?: boolean,
  ): Promise<Reply> {
    const waitingSince = Date.now();
    const ready = await this.ready();
    if ('failure' in ready) {
      this.report('native-request-failed', {
        kind,
        reason: ready.failure,
        generation: ready.generation ?? this.generation,
        elapsedMs: Date.now() - waitingSince,
        ready: false,
      });
      return { value: null, failure: ready.failure };
    }
    const helper = ready.helper;
    if (helper.closed || this.helper !== helper) return { value: null, failure: 'disposed' };
    if (helper.draining) {
      this.report('native-request-failed', {
        kind,
        reason: 'recovering',
        generation: helper.generation,
        elapsedMs: 0,
        ready: helper.ready,
      });
      return Promise.resolve({ value: null, failure: 'recovering' });
    }
    const id = ++this.sequence;
    const started = Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          if (['fg', 'down', 'style'].includes(kind)) {
            // A read timeout must not shorten an outstanding window write's deadline.
            // Reject new work so polling cannot keep a stalled helper alive indefinitely.
            helper.draining = true;
            helper.pending.get(id)?.(null, 'timeout');
          } else {
            // A timed-out write may already have executed. Retire it; never replay it.
            this.close(helper, 'timeout', true);
          }
        },
        kind === 'input' || kind === 'style' ? 10000 : 3000,
      );
      helper.pending.set(id, (value, failure) => {
        clearTimeout(timer);
        helper.pending.delete(id);
        if (!failure && value !== null) {
          const valid = ['input', 'activate', 'down'].includes(kind)
            ? /^(True|False)$/.test(value)
            : /^-?\d+$/.test(value);
          if (!valid) failure = 'protocol';
          else if (kind === 'input' && value === 'False') failure = 'native-rejected';
        }
        if (failure)
          this.report('native-request-failed', {
            kind,
            reason: failure,
            generation: helper.generation,
            elapsedMs: Date.now() - started,
            ready: helper.ready,
          });
        resolve({ value: failure ? null : value, failure });
        if (helper.draining && helper.pending.size === 0) this.close(helper, 'timeout', true);
      });
      try {
        helper.child.stdin!.write(
          JSON.stringify({ id, kind, handle, visible, acceptInput }) + '\n',
        );
      } catch {
        this.close(helper, 'write', true);
      }
    });
  }
  async foreground() {
    return (await this.call('fg')).value;
  }
  async activate(handle: string | null) {
    if (handle && /^\d+$/.test(handle))
      return (await this.call('activate', handle)).value === 'True';
    return false;
  }
  async talkDown() {
    return (await this.call('down')).value === 'True';
  }
  async inputPolicy(handle: string, visible: boolean, acceptInput: boolean) {
    const result = await this.call('input', handle, visible, acceptInput);
    if (result.failure) throw nativeError('无法应用窗口任务栏样式', result.failure);
  }
  async windowStyle(handle: string) {
    const result = await this.call('style', handle);
    if (result.failure || result.value === null)
      throw nativeError('无法读取窗口样式', result.failure || 'protocol');
    return Number(result.value);
  }
  dispose() {
    const startup = this.startup;
    this.startup = null;
    startup?.cancel();
    if (this.helper) this.close(this.helper, 'disposed', true);
  }
}
