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
  closed: boolean;
  draining: boolean;
  buffer: string;
  stderrBytes: number;
  pending: Map<number, (value: string | null, failure?: Failure) => void>;
};
const codes: Record<Failure, string> = {
  timeout: 'NATIVE_TIMEOUT',
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
  return Object.assign(new Error(message), { code: codes[failure] });
}
export class WindowsAdapter {
  private helper: Helper | null = null;
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
    if (this.helper === helper) this.helper = null;
    helper.buffer = '';
    for (const finish of helper.pending.values()) finish(null, failure);
    helper.pending.clear();
    this.report('native-helper-ended', {
      generation: helper.generation,
      reason: failure,
      ready: helper.ready,
      stderrBytes: helper.stderrBytes,
      ...(exitCode == null ? {} : { exitCode }),
    });
    if (kill) helper.child.kill();
  }
  private ensure(): Helper {
    if (this.helper) return this.helper;
    if (process.platform !== 'win32') throw new Error('当前桌面版本仅支持 Windows');
    const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'public class CompanionNative {${members}}'; [Console]::WriteLine('@READY'); while($null -ne ($line=[Console]::ReadLine())) { try { $q=$line|ConvertFrom-Json; $v=''; if($q.kind -eq 'fg'){$v=[CompanionNative]::GetForegroundWindow().ToInt64().ToString()}; if($q.kind -eq 'activate'){ $v=[CompanionNative]::Activate([IntPtr]([long]$q.handle)).ToString() }; if($q.kind -eq 'down'){$v=(([CompanionNative]::GetAsyncKeyState(87) -band 0x8000) -ne 0).ToString()}; if($q.kind -eq 'input'){$v=[CompanionNative]::InputPolicy([IntPtr]([long]$q.handle),[bool]$q.visible,[bool]$q.acceptInput).ToString()}; if($q.kind -eq 'style'){$v=[CompanionNative]::GetWindowLong([IntPtr]([long]$q.handle),-20).ToString()}; [Console]::WriteLine(('@'+$q.id+'='+$v)); } catch { [Console]::WriteLine(('@'+$q.id+'=!ERROR')); } }`;
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const helper: Helper = {
      child,
      generation: ++this.generation,
      ready: false,
      closed: false,
      draining: false,
      buffer: '',
      stderrBytes: 0,
      pending: new Map(),
    };
    this.helper = helper;
    this.report('native-helper-start', { generation: helper.generation });
    child.stdout!.on('data', (data) => {
      if (helper.closed) return;
      helper.buffer += String(data);
      let i;
      while ((i = helper.buffer.indexOf('\n')) >= 0) {
        const line = helper.buffer.slice(0, i).trim();
        helper.buffer = helper.buffer.slice(i + 1);
        if (line === '@READY') {
          helper.ready = true;
          this.report('native-helper-ready', { generation: helper.generation });
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
    child.on('exit', (code) => this.close(helper, 'exit', false, code));
    child.stdin!.on('error', () => this.close(helper, 'write', true));
    return helper;
  }
  private call(
    kind: string,
    handle?: string,
    visible?: boolean,
    acceptInput?: boolean,
  ): Promise<Reply> {
    let helper: Helper;
    try {
      helper = this.ensure();
    } catch {
      this.report('native-request-failed', {
        kind,
        reason: 'spawn',
        generation: this.generation,
        elapsedMs: 0,
        ready: false,
      });
      return Promise.resolve({ value: null, failure: 'spawn' });
    }
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
    if (this.helper) this.close(this.helper, 'disposed', true);
  }
}
