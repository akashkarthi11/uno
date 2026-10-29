process.env.GAME_DEAL = 'off';
// The live Korean lesson: the real admin teaches, private players follow and answer; nobody else can see or touch it.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../api/_lib/game.js';

const now = 1000;
function room() {
  const s = G.newRoom('t');
  const admin = G.join(s, { name: 'Boss', admin: true, role: 'admin' }, now);
  G.act(s, admin, { op: 'private', on: true }, now);
  const ann = G.join(s, { name: 'Ann', role: 'private' }, now);
  const bob = G.join(s, { name: 'Bob', role: 'private' }, now);
  return { s, admin, ann, bob };
}

test('only the admin and private players can see or use the lesson; others get what a made-up action gets', () => {
  const { s, admin, ann } = room();
  G.act(s, admin, { op: 'learnShow', tab: 'vowels', idx: 2 }, now);
  assert.deepEqual([G.view(s, ann, now).learn.tab, G.view(s, ann, now).learn.idx], ['vowels', 2]);
  const pub = G.join(s, { name: 'Pat', role: 'public' }, now);
  assert.equal(G.view(s, pub, now).learn, undefined);
  assert.equal('learn' in JSON.parse(JSON.stringify(G.view(s, pub, now))), false, 'the field is not even sent');
  for (const op of ['learnShow', 'learnQuiz', 'learnAnswer', 'learnReveal', 'learnEnd']) {
    assert.throws(() => G.act(s, pub, { op, tab: 'vowels', idx: 0, choice: 0 }, now), /Unknown action/);
  }
});

test('only the teacher chooses the letter and runs the quiz; students follow', () => {
  const { s, admin, ann } = room();
  assert.throws(() => G.act(s, ann, { op: 'learnShow', tab: 'vowels', idx: 0 }, now), /Only the teacher/);
  assert.throws(() => G.act(s, ann, { op: 'learnQuiz' }, now), /Only the teacher/);
  assert.throws(() => G.act(s, admin, { op: 'learnShow', tab: 'nope', idx: 0 }, now), /Bad letter/);
  assert.throws(() => G.act(s, admin, { op: 'learnShow', tab: 'vowels', idx: 99 }, now), /Bad letter/);
  G.act(s, admin, { op: 'learnShow', tab: 'double', idx: 1 }, now);
  assert.deepEqual([G.view(s, ann, now).learn.tab, G.view(s, ann, now).learn.idx, G.view(s, ann, now).learn.mode], ['double', 1, 'learn']);
});

test('a quiz: everyone answers, the right answer stays hidden until all have answered, then points are given', () => {
  const { s, admin, ann, bob } = room();
  G.act(s, admin, { op: 'learnQuiz', tab: 'consonants' }, now);
  const q = s.learn.q;
  assert.equal(q.opts.length, 4);
  assert.equal(new Set(q.opts).size, 4, 'four different sounds');
  assert.equal(q.opts[q.correct], HANGULROW(q.letter)[1]);
  const v = G.view(s, ann, now).learn.q;
  assert.equal(v.correct, undefined, 'hidden while open');
  assert.equal(v.revealed, false);
  assert.equal(JSON.stringify(G.view(s, ann, now)).includes('"correct"'), false);
  G.act(s, ann, { op: 'learnAnswer', choice: q.correct }, now);
  assert.throws(() => G.act(s, ann, { op: 'learnAnswer', choice: 0 }, now), /already answered/);
  assert.equal(G.view(s, bob, now).learn.q.answered, 1);
  assert.equal(G.view(s, bob, now).learn.q.revealed, false);
  G.act(s, bob, { op: 'learnAnswer', choice: (q.correct + 1) % 4 }, now);
  G.act(s, admin, { op: 'learnAnswer', choice: q.correct }, now); // the last one in: the question opens up by itself
  const after = G.view(s, ann, now).learn;
  assert.equal(after.q.revealed, true);
  assert.equal(after.q.correct, q.correct);
  assert.deepEqual(after.scores, { Ann: 10, Boss: 10 });
  assert.deepEqual(after.q.results.map((r) => r.name + ':' + r.ok).sort(), ['Ann:true', 'Bob:false', 'Boss:true']);
  assert.throws(() => G.act(s, bob, { op: 'learnAnswer', choice: 0 }, now), /no open question/);
});

test('the teacher can reveal early, and a bad answer is refused', () => {
  const { s, admin, ann } = room();
  G.act(s, admin, { op: 'learnQuiz', tab: 'vowels' }, now);
  assert.throws(() => G.act(s, ann, { op: 'learnAnswer', choice: 7 }, now), /Bad answer/);
  assert.throws(() => G.act(s, ann, { op: 'learnReveal' }, now), /Only the teacher/);
  G.act(s, admin, { op: 'learnReveal' }, now);
  assert.equal(G.view(s, ann, now).learn.q.revealed, true);
  G.act(s, admin, { op: 'learnQuiz', tab: 'vowels' }, now);
  assert.equal(s.learn.qn, 2);
  assert.equal(G.view(s, ann, now).learn.q.mine, null, 'a new question is fresh');
});

test('making the game public ends the lesson', () => {
  const { s, admin } = room();
  G.act(s, admin, { op: 'learnShow', tab: 'vowels', idx: 0 }, now);
  G.act(s, admin, { op: 'private', on: false }, now);
  assert.equal(s.learn, null);
});

import { HANGUL } from '../api/_lib/korean.js';
const HANGULROW = (ch) => Object.values(HANGUL).flat().find((r) => r[0] === ch);
