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

test('asking each other to write a word: auto-checked with an expected answer, otherwise marked by the asker', () => {
  const { s, admin, ann, bob } = room();
  // a private player asks the admin, with the right answer typed in (only the asker ever sees it)
  G.act(s, ann, { op: 'learnAsk', to: admin.id, text: 'Write "water" in Korean', expect: '물' }, now);
  const forAdmin = G.view(s, admin, now).learn.asks[0];
  assert.deepEqual([forAdmin.fromName, forAdmin.toName, forAdmin.auto, forAdmin.expect], ['Ann', 'Boss', true, undefined]);
  assert.equal(G.view(s, bob, now).learn.asks.length, 0, 'a question to someone else is private');
  assert.equal(JSON.stringify(G.view(s, admin, now)).includes('물'), false, 'the answer is not sent to the one being asked');
  assert.equal(G.view(s, ann, now).learn.asks[0].expect, '물');
  assert.throws(() => G.act(s, bob, { op: 'learnWrite', id: forAdmin.id, text: '물' }, now), /not for you/);
  assert.throws(() => G.act(s, ann, { op: 'learnWrite', id: forAdmin.id, text: '물' }, now), /You asked this one/);
  G.act(s, admin, { op: 'learnWrite', id: forAdmin.id, text: ' 물 ' }, now);
  assert.equal(G.view(s, ann, now).learn.asks[0].answers[0].ok, true);
  assert.equal(G.view(s, admin, now).learn.scores.Boss, 10);
  assert.throws(() => G.act(s, admin, { op: 'learnWrite', id: forAdmin.id, text: 'x' }, now), /already answered/);

  // the admin asks everyone, no expected answer: each answer is marked by the asker, once
  G.act(s, admin, { op: 'learnAsk', to: 'all', text: 'Write the letter for "m"' }, now);
  const all = G.view(s, ann, now).learn.asks.find((a) => a.fromName === 'Boss');
  G.act(s, ann, { op: 'learnWrite', id: all.id, text: 'ㅁ' }, now);
  G.act(s, bob, { op: 'learnWrite', id: all.id, text: 'ㄴ' }, now);
  assert.throws(() => G.act(s, ann, { op: 'learnMark', id: all.id, who: ann.id, ok: true }, now), /Only the one who asked/);
  G.act(s, admin, { op: 'learnMark', id: all.id, who: ann.id, ok: true }, now);
  G.act(s, admin, { op: 'learnMark', id: all.id, who: bob.id, ok: false }, now);
  assert.throws(() => G.act(s, admin, { op: 'learnMark', id: all.id, who: ann.id, ok: false }, now), /Already marked/);
  const done = G.view(s, admin, now).learn;
  assert.equal(done.scores.Ann, 10);
  assert.equal(done.scores.Bob, undefined);
  assert.deepEqual(G.view(s, bob, now).learn.asks.find((a) => a.id === all.id).myAnswer, { text: 'ㄴ', ok: false });
  G.act(s, admin, { op: 'learnRemoveAsk', id: all.id }, now);
  assert.equal(G.view(s, ann, now).learn.asks.some((a) => a.id === all.id), false);
});

test('questions between members: bad targets and outsiders are refused', () => {
  const { s, admin, ann } = room();
  const pub = G.join(s, { name: 'Pat', role: 'public' }, now);
  assert.throws(() => G.act(s, ann, { op: 'learnAsk', to: ann.id, text: 'hi' }, now), /Pick who/);
  assert.throws(() => G.act(s, ann, { op: 'learnAsk', to: pub.id, text: 'hi' }, now), /Pick who/);
  assert.throws(() => G.act(s, ann, { op: 'learnAsk', to: admin.id, text: '   ' }, now), /Write the question/);
  assert.throws(() => G.act(s, pub, { op: 'learnAsk', to: 'all', text: 'hi' }, now), /Unknown action/);
});

import { HANGUL } from '../api/_lib/korean.js';
const HANGULROW = (ch) => Object.values(HANGUL).flat().find((r) => r[0] === ch);

test('the word list: members add Korean words and read them; only the adder or the teacher removes; outsiders get nothing', () => {
  const { s, admin, ann, bob } = room();
  G.act(s, ann, { op: 'learnWordAdd', ko: '물', roman: 'mul', meaning: 'water' }, now);
  G.act(s, admin, { op: 'learnWordAdd', ko: '  사랑 ', meaning: 'love' }, now);
  const seen = G.view(s, bob, now).learn.words;
  assert.deepEqual(seen.map((w) => [w.ko, w.roman, w.meaning, w.byName, w.canRemove]), [['물', 'mul', 'water', 'Ann', false], ['사랑', '', 'love', 'Boss', false]]);
  assert.equal(G.view(s, ann, now).learn.words[0].canRemove, true);
  assert.equal(G.view(s, admin, now).learn.words[0].canRemove, true, 'the teacher can remove any word');
  assert.throws(() => G.act(s, bob, { op: 'learnWordRemove', id: seen[0].id }, now), /Only the one who added it/);
  G.act(s, ann, { op: 'learnWordRemove', id: seen[0].id }, now);
  G.act(s, admin, { op: 'learnWordRemove', id: seen[1].id }, now);
  assert.deepEqual(G.view(s, bob, now).learn.words, []);
  const pub = G.join(s, { name: 'Pat', role: 'public' }, now);
  assert.throws(() => G.act(s, pub, { op: 'learnWordAdd', ko: '물', meaning: 'water' }, now), /Unknown action/);
});

test('word checks: Korean letters required, meaning required, no duplicates, capped', () => {
  const { s, ann } = room();
  assert.throws(() => G.act(s, ann, { op: 'learnWordAdd', ko: 'water', meaning: 'water' }, now), /Korean letters/);
  assert.throws(() => G.act(s, ann, { op: 'learnWordAdd', ko: '물', meaning: ' ' }, now), /what the word means/);
  assert.throws(() => G.act(s, ann, { op: 'learnWordAdd', ko: '', meaning: 'x' }, now), /Korean word first/);
  G.act(s, ann, { op: 'learnWordAdd', ko: '물', meaning: 'water' }, now);
  assert.throws(() => G.act(s, ann, { op: 'learnWordAdd', ko: '물', meaning: 'again' }, now), /already in the list/);
  for (let i = 0; i < 59; i++) G.act(s, ann, { op: 'learnWordAdd', ko: '가' + String.fromCharCode(0xac00 + i), meaning: 'w' + i }, now);
  assert.throws(() => G.act(s, ann, { op: 'learnWordAdd', ko: '나나나', meaning: 'x' }, now), /list is full/);
});

import { WORDS } from '../api/_lib/words.js';
test('the starter dictionary is well formed: Korean, a reading and a meaning in every row, no repeats', () => {
  const rows = Object.values(WORDS).flatMap(([, r]) => r);
  assert.ok(rows.length >= 80);
  for (const [ko, roman, en] of rows) {
    assert.match(ko, /^[\uac00-\ud7af ]+$/, ko);
    assert.match(roman, /^[a-z ]+$/, roman);
    assert.ok(en.length > 0);
  }
  assert.equal(new Set(rows.map((r) => r[0])).size, rows.length, 'a word appears twice');
});

test('chat replies quote the message they answer; a reply to a message that is gone is a plain message', () => {
  const { s, admin, ann, bob } = room();
  G.act(s, ann, { op: 'chat', text: 'How do I say water?' }, now);
  const asked = s.chat[0];
  G.act(s, admin, { op: 'chat', text: 'mul — 물', replyT: asked.t, replyFrom: ann.id }, now + 1000);
  const msg = s.chat[1];
  assert.deepEqual([msg.reply.name, msg.reply.text, msg.reply.img], ['Ann', 'How do I say water?', false]);
  G.act(s, bob, { op: 'chat', text: 'ok', replyT: 12345, replyFrom: ann.id }, now + 2000);
  assert.equal(s.chat[2].reply, undefined);
  G.act(s, bob, { op: 'chat', text: 'x'.repeat(300), replyT: s.chat[1].t, replyFrom: admin.id }, now + 3000);
  assert.ok(s.chat[3].reply.text.length <= 80);
});

test('a picture in the chat: only the admin and private players; the message carries an id, never the bytes', () => {
  const { s, admin, ann } = room();
  G.act(s, ann, { op: 'chat', text: '', imgId: 'abc123' }, now);
  assert.deepEqual([s.chat[0].img, s.chat[0].text], ['abc123', '']);
  assert.throws(() => G.act(s, admin, { op: 'chat', text: '' }, now + 1000), /Type a message first/);
  const pub = G.join(s, { name: 'Pat', role: 'public' }, now);
  assert.throws(() => G.act(s, pub, { op: 'chat', text: 'hi', imgId: 'zzz' }, now + 2000), /Unknown action/);
});
