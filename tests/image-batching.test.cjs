const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = process.env.SOURCE_ROOT || path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/worker.js'), 'utf8');
const image = (id) => ({ mime: 'image/png', url: `https://images.test/${id}` });
const entry = (id, count, content = '') => ({
  msgid: id, timestamp: 10000, content,
  attachments: Array.from({ length: count }, (_, i) => image(`${id}-${i}`))
});

function harness(feed, failRecord = 0) {
  let kv = '[]';
  let recordCalls = 0;
  const posts = [];
  const downloaded = [];
  const uploaded = [];
  const context = vm.createContext({
    Response, Blob, console: { log() {}, error() {} },
    fetch: async (url, options) => {
      if (url === 'https://feed.test/data') return { ok: true, json: async () => structuredClone(feed) };
      if (url.endsWith('createSession')) return { ok: true, json: async () => ({ accessJwt: 'fixture' }) };
      if (url.startsWith('https://images.test/')) {
        downloaded.push(url);
        return { ok: true, blob: async () => new Blob([url], { type: 'image/png' }) };
      }
      if (url.endsWith('uploadBlob')) {
        const id = await options.body.text();
        uploaded.push(id);
        return { ok: true, json: async () => ({ blob: { fixture: id } }) };
      }
      if (url.endsWith('createRecord')) {
        recordCalls++;
        if (recordCalls === failRecord) return { ok: false, text: async () => 'fixture failure' };
        const post = JSON.parse(options.body);
        assert.ok((post.record.embed?.images.length || 0) <= 4);
        posts.push(post);
        return { ok: true };
      }
      throw new Error(`Unexpected fixture URL: ${url}`);
    }
  });
  vm.runInContext(source.replace('export default {', 'const handler = {') + '\nglobalThis.WorkerClass = BlueskySync;', context);
  const worker = new context.WorkerClass({
    BLUESKY_USERNAME: 'fixture.invalid', BLUESKY_PASSWORD: 'fixture', JSON_SOURCE_URL: 'https://feed.test/data',
    BLUESKY_SYNC_KV: { get: async () => kv, put: async (_, value) => { kv = value; } }
  });
  return { worker, posts, downloaded, uploaded, ids: () => JSON.parse(kv) };
}

for (const [a, b] of [[4, 1], [3, 2], [2, 3], [1, 4], [4, 4]]) {
  test(`sync preserves both image-only entries with ${a}+${b} images across retries`, async () => {
    const h = harness([entry('first', a), entry('second', b)]);
    assert.equal((await h.worker.sync()).status, 200);
    assert.equal(h.posts.length, 2);
    assert.deepEqual(h.posts.map(p => p.record.embed.images.length), [a, b]);
    assert.equal(h.downloaded.length, a + b);
    assert.equal(h.uploaded.length, a + b);
    assert.deepEqual(h.ids(), ['first', 'second']);
    await h.worker.sync();
    assert.equal(h.posts.length, 2);
    assert.equal(h.downloaded.length, a + b);
  });
}

test('all two-entry valid attachment-count combinations conserve images', async () => {
  for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) {
    const h = harness([entry('first', a, 'a'), entry('second', b, 'b')]);
    assert.equal((await h.worker.sync()).status, 200);
    assert.equal(h.posts.length, a + b <= 4 ? 1 : 2, `${a}+${b}`);
    assert.equal(h.posts.reduce((sum, p) => sum + (p.record.embed?.images.length || 0), 0), a + b, `${a}+${b}`);
  }
});

test('three entries roll over without losing attachments', async () => {
  const h = harness([entry('a', 2), entry('b', 2), entry('c', 1)]);
  await h.worker.sync();
  assert.deepEqual(h.posts.map(p => p.record.embed.images.length), [4, 1]);
  assert.deepEqual(h.ids(), ['a', 'b', 'c']);
});

test('nonimage attachments do not consume image capacity', async () => {
  const first = entry('a', 2, 'a');
  first.attachments.push({ mime: 'application/pdf', url: 'https://unused.test/a' });
  const h = harness([first, entry('b', 2, 'b')]);
  await h.worker.sync();
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].record.embed.images.length, 4);
});

test('absent attachment arrays combine text normally', async () => {
  const h = harness([{ msgid: 'a', timestamp: 10000, content: 'a' }, { msgid: 'b', timestamp: 10000, content: 'b' }]);
  await h.worker.sync();
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].record.text, 'a\n\nb');
});

test('split batch records only successful entry when the second post fails', async () => {
  const h = harness([entry('a', 4), entry('b', 1)], 2);
  assert.equal((await h.worker.sync()).status, 500);
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.ids(), ['a']);
  assert.equal((await h.worker.sync()).status, 200);
  assert.equal(h.posts.length, 2);
  assert.deepEqual(h.ids(), ['a', 'b']);
});

test('existing time and text limits still prevent combining', () => {
  const h = harness([]);
  assert.equal(h.worker.shouldCombineMessages([{ ...entry('a', 0, 'a'), timestamp: 5000 }, { ...entry('b', 0, 'b'), timestamp: 2000 }]), false);
  assert.equal(h.worker.shouldCombineMessages([entry('a', 0, 'x'.repeat(200)), entry('b', 0, 'y'.repeat(200))]), false);
});

test('one oversized source entry keeps existing four-image policy', async () => {
  const h = harness([entry('a', 5)]);
  await h.worker.sync();
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].record.embed.images.length, 4);
});
