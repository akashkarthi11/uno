// The admin password (110299) belongs to one username: karthickkeyan303. No other name can use it.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GAME_USERS_MEMORY = '1';
delete process.env.GAME_ADMIN_ANY_NAME; // the real rule
const { default: handler } = await import('../api/game.js');
const { _memRows } = await import('../api/_lib/users.js');

const call = (body) => new Promise((resolve) => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
  handler({ method: 'POST', body }, res);
});

test('110299 with any other username is just a wrong password', async () => {
  for (const name of ['Boss', 'admin', 'karthickkeyan', 'karthickkeyan3030', '']) {
    const r = await call({ op: 'login', name, password: '110299' });
    assert.equal(r.code, 401, JSON.stringify(name));
    assert.equal(r.body.error, 'Wrong password.');
    assert.equal(r.body.sys, undefined);
  }
  // the older per-room sign-in follows the same rule, and the admin diagnostics too
  const room = await call({ op: 'join', room: 'adminname1', name: 'Boss', password: '110299' });
  assert.equal(room.code, 401);
  assert.equal(room.body.state, undefined);
  assert.equal((await call({ op: 'bench', password: '110299', name: 'Boss' })).code, 401);
  assert.equal(_memRows().length, 0, 'nothing was saved');
});

test('karthickkeyan303 with 110299 is the admin, whatever the letter case, and is recorded on that user', async () => {
  for (const name of ['karthickkeyan303', 'KarthickKeyan303', '  karthickkeyan303 ']) {
    const r = await call({ op: 'login', name, password: '110299' });
    assert.equal(r.code, 200, name);
    assert.deepEqual([r.body.role, r.body.name], ['admin', 'karthickkeyan303']);
  }
  const admin = (await call({ op: 'login', name: 'KARTHICKKEYAN303', password: '110299' })).body.sys;
  const made = await call({ op: 'join', sys: admin, create: true });
  assert.equal(made.code, 200);
  assert.equal(made.body.state.admin, true);
  assert.equal(made.body.state.players.find((p) => p.id === made.body.state.you).name, 'karthickkeyan303');
  const row = _memRows().find((r) => r.username === 'karthickkeyan303');
  assert.ok(row && row.is_admin && row.logins >= 4, 'one user row, marked as the admin, counting every sign-in');
  // the per-room sign-in works for the admin's username too
  assert.equal((await call({ op: 'join', room: 'adminname2', name: 'karthickkeyan303', password: '110299' })).body.state.admin, true);
  assert.equal((await call({ op: 'bench', password: '110299', name: 'karthickkeyan303' })).code !== 401, true);
});

test('nobody else can register the admin\'s username, and the other shared passwords are unchanged', async () => {
  assert.equal((await call({ op: 'login', name: 'karthickkeyan303', password: '123456' })).body.error, 'That name is taken.');
  assert.equal((await call({ op: 'login', name: 'karthickkeyan303', password: '123456', newPassword: 'abcdef12' })).code, 401);
  assert.equal((await call({ op: 'login', name: 'Friend', password: '281101' })).body.role, 'private');
  assert.equal((await call({ op: 'login', name: 'x', password: '1102' })).body.role, 'observer');
});
