const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// Exercise the actual Worker source without network calls or a Cloudflare account.
function fixture() {
  let state = '[]';
  const posts = [];
  const sandbox = {
    Response,
    console: { error() {} },
    fetch: async (url, options) => {
      const post = JSON.parse(options.body);
      posts.push(post);
      // These fixtures are ASCII, so characters and graphemes have equal length.
      return post.record.text.length <= 300
        ? new Response('{}')
        : new Response('text exceeds 300 graphemes', { status: 400 });
    }
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, '../src/worker.js'), 'utf8');
  vm.runInContext(source.replace('export default {', 'const worker = {') + '\nglobalThis.Sync = BlueskySync;', sandbox);
  const sync = new sandbox.Sync({
    BLUESKY_USERNAME: 'test.invalid',
    BLUESKY_SYNC_KV: {
      get: async () => state,
      put: async (key, value) => { state = value; }
    }
  });
  sync.login = async () => {};
  return { sync, posts, saved: () => JSON.parse(state) };
}

for (const [name, contents, expectedLengths] of [
  ['exactly 300 including separator', ['a'.repeat(149), 'b'.repeat(149)], [300]],
  ['301 including separator splits', ['a'.repeat(150), 'b'.repeat(149)], [150, 149]],
  ['302 including separator splits', ['a'.repeat(150), 'b'.repeat(150)], [150, 150]],
  ['three entries count both separators', ['a'.repeat(99), 'b'.repeat(99), 'c'.repeat(99)], [200, 99]],
  ['three entries exactly fit', ['a'.repeat(98), 'b'.repeat(99), 'c'.repeat(99)], [300]],
  ['empty content adds no separator', ['a'.repeat(149), '', 'b'.repeat(149)], [300]],
  ['formatting precedes counting', ['  ' + 'a'.repeat(149) + '  ', 'b'.repeat(149)], [300]],
  ['single permitted post', ['a'.repeat(300)], [300]],
  ['ordinary short updates combine', ['hello', 'world'], [12]],
  ['larger sum remains separate', ['a'.repeat(151), 'b'.repeat(150)], [151, 150]]
]) {
  test(name, async () => {
    const { sync, posts, saved } = fixture();
    const entries = contents.map((content, index) => ({ content, msgid: String(index), timestamp: 1000 - index }));
    sync.fetchJSONFeed = async () => entries;
    const result = await sync.sync();
    assert.equal(result.status, 200);
    assert.deepEqual(posts.map(post => post.record.text.length), expectedLengths);
    assert.deepEqual(saved(), entries.map(entry => entry.msgid));
  });
}

test('time window still keeps distant posts separate', async () => {
  const { sync, posts } = fixture();
  sync.fetchJSONFeed = async () => [
    { msgid: 'new', content: 'hello', timestamp: 2002 },
    { msgid: 'old', content: 'world', timestamp: 1000 }
  ];
  assert.equal((await sync.sync()).status, 200);
  assert.deepEqual(posts.map(post => post.record.text), ['hello', 'world']);
});
