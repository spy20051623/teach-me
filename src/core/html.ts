export const htmlPolicy =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
export function validateHtmlSource(html: string) {
  if (Buffer.byteLength(html, 'utf8') > 256 * 1024) throw new Error('HTML 超过 256KB');
  // In Unicode mode this matches lone surrogates, not valid pairs such as emoji.
  if (/[\uD800-\uDFFF]/u.test(html)) throw new Error('HTML 含无效 Unicode 字符');
}
export function htmlDocument(html: string) {
  validateHtmlSource(html);
  const inner = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${htmlPolicy}"><style>html,body{margin:0;color:#e9ebf0;background:transparent;font:14px/1.5 'Segoe UI',sans-serif}*{box-sizing:border-box}</style>${html}`;
  const escape = (s: string) =>
    s
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src about:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:"><style>html,body{margin:0;overflow:hidden;background:#14161b;color:#8d93a1;font:11px 'Segoe UI',sans-serif}header{height:26px;line-height:26px;padding:0 10px;border:1px solid #ff3d7f}iframe{display:block;width:100%;height:calc(100vh - 26px);border:1px solid #2b2f39;background:#14161b}</style><header>Teach me · Agent 自定义指引</header><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escape(inner)}"></iframe>`;
}
export function validateHtmlArea(
  rect: [number, number, number, number],
  screen: { width: number; height: number },
) {
  const [x, y, w, h] = rect;
  if (
    x < 0 ||
    y < 0 ||
    x + w > screen.width ||
    y + h > screen.height ||
    w * h > screen.width * screen.height * 0.35 ||
    w < 100 ||
    h < 70
  )
    throw new Error('HTML 指引须位于屏内，至少 100×70，最多覆盖 35% 屏幕');
}
