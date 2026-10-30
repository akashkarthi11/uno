// AI videos for private rooms (the generator and the file store are replaced by in-memory stand-ins here).
process.env.GAME_VIDEO_FAKE = '1';
process.env.GAME_VIDEO_DAILY = '5';
process.env.GAME_VIDEO_MONTHLY = '8';
process.env.GAME_DEAL = 'off';
import test from 'node:test';
process.env.GAME_ADMIN_ANY_NAME = '1'; // these tests sign the admin in under made-up names; adminname.test.mjs checks the real rule
import assert from 'node:assert/strict';
import handler from '../api/game.js';

function call(body) {
  return new Promise((resolve) => {
    const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
    handler({ method: 'POST', body }, res);
  });
}
const PIC = 'data:image/jpeg;base64,' + Buffer.alloc(3000, 1).toString('base64');

test('video: private rooms only; the admin and private players; nobody else gets anything', async () => {
  const R = 'vid' + (Date.now() % 100000), P = 'vpub' + (Date.now() % 100000);
  const admin = (await call({ op: 'join', room: R, name: 'Boss', password: '110299' })).body.state;
  assert.equal(admin.canAiVideo, false, 'a public room has no AI videos');
  await call({ op: 'private', room: R, playerId: admin.you, on: true });
  const priv = (await call({ op: 'join', room: R, name: 'Priv', password: '281101' })).body.state;
  const obs = (await call({ op: 'join', room: R, name: 'x', password: '1102' })).body.state;
  assert.equal((await call({ op: 'videoList', room: R, playerId: admin.you })).code, 200);
  assert.equal((await call({ op: 'videoList', room: R, playerId: priv.you })).code, 200);
  assert.equal((await call({ op: 'videoList', room: R, playerId: obs.you })).code, 400, 'the observer account is not a player');
  assert.equal((await call({ op: 'videoList', room: R, playerId: 'nobody' })).code, 400);
  const pa = (await call({ op: 'join', room: P, name: 'Pub', password: '123456' })).body.state;
  assert.equal((await call({ op: 'videoMake', room: P, playerId: pa.you, prompt: 'a cat' })).code, 400, 'a public room refuses it');
  assert.equal((await call({ op: 'state', room: R, playerId: priv.you })).body.state?.canAiVideo ?? true, true);
});

test('video: make from words and from a picture, it finishes, it stays in the list until deleted, only the owner or admin delete', async () => {
  const R = 'vid2' + (Date.now() % 100000);
  const admin = (await call({ op: 'join', room: R, name: 'Boss', password: '110299' })).body.state;
  await call({ op: 'private', room: R, playerId: admin.you, on: true });
  const priv = (await call({ op: 'join', room: R, name: 'Priv', password: '281101' })).body.state;
  const priv2 = (await call({ op: 'join', room: R, name: 'Priv2', password: '281101' })).body.state;

  assert.equal((await call({ op: 'videoMake', room: R, playerId: priv.you, prompt: 'ab' })).code, 400, 'too short without a picture');
  assert.equal((await call({ op: 'videoMake', room: R, playerId: priv.you, image: 'data:text/html;base64,AAAA' })).code, 400, 'only pictures');
  const big = 'data:image/jpeg;base64,' + Buffer.alloc(2 * 1024 * 1024, 1).toString('base64');
  assert.equal((await call({ op: 'videoMake', room: R, playerId: priv.you, image: big })).code, 400, 'too big');

  const m1 = await call({ op: 'videoMake', room: R, playerId: priv.you, prompt: 'a red balloon floating up' });
  assert.equal(m1.code, 200);
  assert.equal(m1.body.videos[0].status, 'making');
  const m2 = await call({ op: 'videoMake', room: R, playerId: priv.you, prompt: '', image: PIC });
  assert.equal(m2.code, 200, 'a picture alone is enough');
  assert.equal(m2.body.videos.find((v) => v.mode === 'image').imageUrl.startsWith('fake://'), true);

  const done = (await call({ op: 'videoCheck', room: R, playerId: priv.you })).body;
  assert.ok(done.videos.every((v) => v.status === 'ready' && v.videoUrl), 'both finished');
  assert.ok(done.videos.every((v) => v.bytes > 0));
  assert.equal(done.limits.day, 2);
  assert.ok(done.limits.bytes > 4000, 'storage is counted');

  // it stays (a later look from somebody else still lists it)
  const later = (await call({ op: 'videoList', room: R, playerId: priv2.you })).body;
  assert.equal(later.videos.length, 2);
  assert.equal(later.videos.every((v) => v.canDelete), false, 'not theirs');
  const mine = (await call({ op: 'videoList', room: R, playerId: priv.you })).body;
  assert.equal(mine.videos.every((v) => v.canDelete), true);
  assert.equal((await call({ op: 'videoDelete', room: R, playerId: priv2.you, id: mine.videos[0].id })).code, 400, 'not theirs');
  const del = await call({ op: 'videoDelete', room: R, playerId: priv.you, id: mine.videos[0].id });
  assert.equal(del.code, 200);
  assert.equal(del.body.videos.length, 1);
  assert.equal(del.body.limits.day, 2, 'deleting does not hand the day back');
  assert.equal((await call({ op: 'videoDelete', room: R, playerId: admin.you, id: mine.videos[1].id })).body.videos.length, 0, 'the admin deletes any');
});

test('video: failures show up, a refused prompt does not break the list, and the daily and monthly caps hold', async () => {
  const R = 'vid3' + (Date.now() % 100000);
  const admin = (await call({ op: 'join', room: R, name: 'Boss', password: '110299' })).body.state;
  await call({ op: 'private', room: R, playerId: admin.you, on: true });
  const before = (await call({ op: 'videoList', room: R, playerId: admin.you })).body.limits;
  await call({ op: 'videoMake', room: R, playerId: admin.you, prompt: 'boom this one fails' });
  await call({ op: 'videoMake', room: R, playerId: admin.you, prompt: 'slow one stays pending' });
  const st = (await call({ op: 'videoCheck', room: R, playerId: admin.you })).body;
  assert.ok(st.videos.some((v) => v.status === 'failed' && /refused/.test(v.error)));
  assert.ok(st.videos.some((v) => v.status === 'making'), 'the slow one is still being made');
  // run into a cap (daily 5 / monthly 8: one of the two is hit first, whatever earlier tests used)
  let refused = null;
  for (let i = 0; i < 10 && !refused; i++) {
    const r = await call({ op: 'videoMake', room: R, playerId: admin.you, prompt: 'cap test number ' + i });
    if (r.code === 400) refused = r.body.error;
  }
  assert.match(refused, /Daily limit|Monthly limit/);
  assert.ok(before.dayMax === 5 && before.monthMax === 8);
});

test('video: with a Replicate token the generator is Replicate (requests and polling go to its API)', async () => {
  const { startVideo, getStatus, modelFor } = await import('../api/_lib/video.js');
  const old = { fake: process.env.GAME_VIDEO_FAKE, tok: process.env.REPLICATE_API_TOKEN, fetch: globalThis.fetch };
  process.env.GAME_VIDEO_FAKE = '0';
  process.env.REPLICATE_API_TOKEN = 'r8_test';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([url, init && init.method, init && init.body && JSON.parse(init.body)]);
    const status = calls.length === 3 ? 'succeeded' : calls.length === 2 ? 'processing' : 'starting';
    const body = String(url).includes('/predictions/') ? { status, output: status === 'succeeded' ? ['https://x/y.mp4'] : null } : { id: 'pred1', status };
    return { ok: true, json: async () => body };
  };
  try {
    const op = await startVideo({ imageUrl: 'https://pic/1.jpg', text: 'hello' });
    assert.deepEqual(op, { replicate: 'pred1' });
    assert.match(calls[0][0], /models\/wan-video\/wan-2\.2-i2v-fast\/predictions$/);
    assert.equal(calls[0][2].input.image, 'https://pic/1.jpg');
    assert.equal(calls[0][2].input.prompt, 'hello');
    assert.deepEqual(await getStatus(op), { state: 'pending' });
    assert.deepEqual(await getStatus(op), { state: 'completed', url: 'https://x/y.mp4' });
    assert.match(modelFor(false), /t2v/);
  } finally {
    globalThis.fetch = old.fetch;
    process.env.GAME_VIDEO_FAKE = old.fake;
    if (old.tok === undefined) delete process.env.REPLICATE_API_TOKEN; else process.env.REPLICATE_API_TOKEN = old.tok;
  }
});
