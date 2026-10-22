import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlDocument, validateHtmlArea } from '../src/core/html.ts';
test('custom HTML is enclosed in a script-only sandbox with host watermark', () => {
  const doc = htmlDocument('<script>window.x=1</script>');
  assert.match(doc, /sandbox="allow-scripts"/);
  assert.doesNotMatch(doc, /allow-same-origin/);
  assert.match(doc, /Agent 自定义指引/);
  assert.match(doc, /connect-src 'none'/);
  assert.match(doc, /&lt;script&gt;/);
});
test('HTML size and screen coverage are bounded', () => {
  assert.throws(() => htmlDocument('中'.repeat(100000)), /256KB/);
  assert.throws(() => validateHtmlArea([0, 0, 1000, 800], { width: 1000, height: 800 }), /35%/);
  assert.throws(() => validateHtmlArea([-1, 0, 100, 100], { width: 1000, height: 800 }));
  assert.doesNotThrow(() => validateHtmlArea([30, 30, 300, 150], { width: 1000, height: 800 }));
});

test('HTML rejects unpaired surrogates before URL encoding and preserves valid emoji', () => {
  for (const value of ['\ud800', '\udfff', 'a\ud800b'])
    assert.throws(() => htmlDocument(value), /无效 Unicode/);
  const doc = htmlDocument('<p>教学 😀</p>');
  assert.match(doc, /😀/);
  assert.equal(decodeURIComponent(encodeURIComponent(doc)), doc);
});
