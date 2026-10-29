// Guards against a mistake that already happened once: two elements sharing an id (the page code then talks to the wrong one,
// and an id-based style lands on both).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8') + fs.readFileSync(new URL('../public/voice.js', import.meta.url), 'utf8');

test('the Korean quiz hides the letter grid (it labels every letter with its sound) while a question is open', () => {
  assert.ok(js.includes('["koreanTabs", "koreanGrid", "groupProgress"].forEach((id) => $(id).classList.toggle("hidden", openQ))'));
  assert.ok(js.indexOf('const openQ') < js.indexOf('"koreanGrid", "groupProgress"]'));
});

test('every id in the page is unique', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dupes)], [], 'duplicate ids: ' + dupes.join(', '));
});

test('every element the page code looks up by id exists in the page', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const created = new Set([...js.matchAll(/\.id\s*=\s*"([^"]+)"/g)].map((m) => m[1])); // ids the script makes itself
  const used = [...new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
  const missing = used.filter((id) => !ids.has(id) && !created.has(id));
  assert.deepEqual(missing, [], 'looked up but not in the page: ' + missing.join(', '));
});
