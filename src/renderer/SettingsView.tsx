import { useState } from 'react';
import type { Action, Settings, Snapshot } from '../shared/protocol.ts';
import { PanelIcon } from './PanelIcon.tsx';
import { useAppearancePreview } from './use-appearance.ts';
import type { ColorMode } from '../shared/appearance.ts';
import { useWindowDrag } from './use-window-drag.ts';
export function SettingsView({
  state,
  perform,
}: {
  state: Snapshot;
  perform: (a: Action) => Promise<Snapshot>;
}) {
  const [draft, setDraft] = useState<Settings>(state.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useAppearancePreview(draft.appearance);
  const drag = useWindowDrag('settings-drag', (a) => {
    perform(a).catch(() => {});
  });
  const run = async (action: Action) => {
    setError('');
    try {
      await perform(action);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await perform({ type: 'settings', settings: draft });
      await perform({ type: 'settings-focus', on: false });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="settings-window"
      aria-label="设置"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) run({ type: 'settings-focus', on: false });
      }}
    >
      <header className="settings-header" title="拖动此处移动设置窗口" {...drag}>
        <h2>设置</h2>
        <button
          className="icon settings-close"
          aria-label="关闭设置"
          title="关闭设置"
          disabled={busy}
          onClick={() => run({ type: 'settings-focus', on: false })}
        >
          <PanelIcon name="close" />
        </button>
      </header>
      <div className="settings-intro">
        <p className="muted">调整后保存，教学对话与草稿会保留。</p>
      </div>
      <div className="settings-content">
        <fieldset disabled={busy}>
          <div className="appearance-setting">
            <h3>外观</h3>
            <div className="color-modes" role="group" aria-label="颜色模式">
              {(
                [
                  ['light', '浅色'],
                  ['dark', '深色'],
                  ['system', '跟随系统'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  data-color-mode={mode}
                  aria-pressed={draft.appearance.mode === mode}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      appearance: { ...draft.appearance, mode: mode as ColorMode },
                    })
                  }
                >
                  <span className={`color-swatch ${mode}`} aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
            <p className="muted">当前窗口预览，保存后应用到所有窗口。</p>
          </div>
          <label className="setting-row">
            <span>用户消息附带截图</span>
            <input
              type="checkbox"
              checked={draft.attachScreenshot}
              onChange={(e) => setDraft({ ...draft, attachScreenshot: e.target.checked })}
            />
          </label>
          <label className="setting-row">
            <span>在远程控制／屏幕共享中显示应用</span>
            <input
              type="checkbox"
              checked={draft.showInScreenCapture}
              onChange={(e) => setDraft({ ...draft, showInScreenCapture: e.target.checked })}
            />
          </label>
          <label className="setting-row">
            <span>Agent 请求截屏</span>
            <select
              value={draft.captureTier}
              onChange={(e) =>
                setDraft({ ...draft, captureTier: e.target.value as Settings['captureTier'] })
              }
            >
              <option value="ask">每次询问</option>
              <option value="lesson">本次教学默认允许</option>
              <option value="always">始终允许</option>
            </select>
          </label>
          <label className="setting-row">
            <span>自动收起（秒，0 关闭）</span>
            <input
              type="number"
              min="0"
              max="120"
              value={draft.autoCollapseSec}
              onChange={(e) => setDraft({ ...draft, autoCollapseSec: Number(e.target.value) })}
            />
          </label>
          <label className="setting-row">
            <span>继续按钮文案</span>
            <input
              maxLength={80}
              value={draft.continueText}
              onChange={(e) => setDraft({ ...draft, continueText: e.target.value })}
            />
          </label>
          <label className="setting-row">
            <span>教学屏幕</span>
            <select
              value={state.displayId ?? ''}
              onChange={(e) => run({ type: 'select-display', id: Number(e.target.value) })}
            >
              <option value="" disabled>
                请选择教学屏幕
              </option>
              {state.displays.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label} · {d.width}×{d.height} · {Math.round(d.scaleFactor * 100)}%
                </option>
              ))}
            </select>
          </label>
          <p className="muted">输入 Ctrl+Alt+W · 指引显隐 Ctrl+Alt+H</p>
          <label className="setting-row">
            <span>语音识别</span>
            <select
              value={draft.voice.engine}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  voice: { ...draft.voice, engine: e.target.value as Settings['voice']['engine'] },
                })
              }
            >
              <option value="system">Windows 系统</option>
              <option value="local">本地程序</option>
              <option value="custom">自定义 API</option>
            </select>
          </label>
          {draft.voice.engine === 'local' && (
            <label className="setting-row">
              <span>识别程序路径</span>
              <input
                value={draft.voice.localCommand}
                onChange={(e) =>
                  setDraft({ ...draft, voice: { ...draft.voice, localCommand: e.target.value } })
                }
                placeholder="接收音频路径，输出文字"
              />
            </label>
          )}
          {draft.voice.engine === 'custom' && (
            <label className="setting-row">
              <span>语音 API 地址</span>
              <input
                value={draft.voice.customUrl}
                onChange={(e) =>
                  setDraft({ ...draft, voice: { ...draft.voice, customUrl: e.target.value } })
                }
                placeholder="HTTP(S) 接口"
              />
            </label>
          )}
          <label className="setting-row">
            <span>朗读 Agent 回复</span>
            <input
              type="checkbox"
              checked={draft.voice.tts}
              onChange={(e) =>
                setDraft({ ...draft, voice: { ...draft.voice, tts: e.target.checked } })
              }
            />
          </label>
          <p className="session-id">会话 {state.session?.id || '尚未开始'}</p>
        </fieldset>
      </div>
      <footer className="settings-footer">
        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <button disabled={busy} onClick={() => run({ type: 'settings-focus', on: false })}>
            取消
          </button>
          <button className="primary" disabled={busy || !draft.continueText.trim()} onClick={save}>
            {busy ? '正在保存…' : '保存设置'}
          </button>
        </div>
      </footer>
    </section>
  );
}
