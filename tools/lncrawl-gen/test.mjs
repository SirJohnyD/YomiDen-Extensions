// Offline test: loads every generated plugin into the real plugin runtime (QuickJS), checks the required members,
// and exercises one plugin per template against canned HTML. No network. `npm test` / `node test.mjs`.
import { newQuickJSAsyncWASMModule } from 'quickjs-emscripten';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const YDN = resolve(HERE, '../..');
// Prefer the app repo's build when this folder lives inside it; otherwise use the vendored copy in runtime/.
const RUNTIME = [process.env.YDN_RUNTIME, resolve(YDN, '../app/src/main/assets/yomiden/plugin-runtime.js'), resolve(YDN, 'runtime/plugin-runtime.js')].find((f) => f && existsSync(f));
if (!RUNTIME) throw new Error('plugin runtime not found (set YDN_RUNTIME or provide runtime/plugin-runtime.js)');
const manifest = JSON.parse(readFileSync(join(YDN, 'plugins', 'manifest.json'), 'utf8'));
assert.ok(manifest.plugins.length > 0, 'manifest lists no plugins');

const QuickJS = await newQuickJSAsyncWASMModule();
const rt = QuickJS.newRuntime();
rt.setMaxStackSize(4 * 1024 * 1024);
const ctx = rt.newContext();
const responses = new Map();
let handleSeq = 0;
let route = () => undefined; // (req) => html | {status, body} | undefined (404)
const nativeObj = ctx.newObject();
function fn(name, impl) {
  const h = ctx.newFunction(name, (...args) => {
    const r = impl(...args.map((a) => ctx.dump(a)));
    if (r === undefined || r === null) return ctx.undefined;
    return typeof r === 'number' ? ctx.newNumber(r) : ctx.newString(String(r));
  });
  ctx.setProp(nativeObj, name, h);
  h.dispose();
}
fn('log', () => {});
fn('storage', (op) => (op === 'keys' ? '[]' : ''));
fn('responseBytes', (h) => Buffer.from(responses.get(h) || '').toString('base64'));
fn('decode', (b64) => Buffer.from(b64, 'base64').toString('utf8'));
fn('urlEncode', (s) => encodeURIComponent(s));
fn('sleep', () => {});
fn('fetch', (reqJson) => {
  const req = JSON.parse(reqJson);
  const r = route(req);
  const handle = ++handleSeq;
  const status = r === undefined ? 404 : typeof r === 'object' ? r.status : 200;
  const body = r === undefined ? 'missing' : typeof r === 'object' ? r.body : r;
  responses.set(handle, body);
  return JSON.stringify({ status, statusText: status === 200 ? 'OK' : 'ERR', url: req.url, headers: [['Content-Type', 'text/html']], text: body, handle });
});
ctx.setProp(ctx.global, '__ydNative', nativeObj);
nativeObj.dispose();

function evalSync(code) {
  const r = ctx.evalCode(code);
  if (r.error) {
    const e = ctx.dump(r.error);
    r.error.dispose();
    throw new Error(e?.message ?? JSON.stringify(e));
  }
  const v = ctx.dump(r.value);
  r.value.dispose();
  return v;
}
const call = (expr) => {
  const v = evalSync(expr);
  return typeof v === 'string' && /^[\[{"]/.test(v) ? JSON.parse(v) : v;
};

evalSync(readFileSync(RUNTIME, 'utf8'));

// ---- 1. every generated plugin loads and has the required members -------------------------------------------
let loaded = 0;
for (const p of manifest.plugins) {
  const file = join(YDN, p.path);
  const code = readFileSync(file, 'utf8');
  let desc;
  try {
    desc = JSON.parse(evalSync(`__yd.load(${JSON.stringify(p.id)}, ${JSON.stringify(code)})`));
  } catch (e) {
    assert.fail(`${p.path}: failed to load: ${e.message}`);
  }
  assert.equal(desc.id, p.id, `${p.path}: id`);
  assert.ok(desc.name, `${p.path}: name`);
  assert.match(desc.site, /^https?:\/\/.+\/$/, `${p.path}: site`);
  assert.ok(desc.version, `${p.path}: version`);
  assert.equal(desc.contentType, p.contentType, `${p.path}: contentType`);
  // Missing members would fail with "not a function"; a present member fails with our offline 404 instead.
  route = () => undefined;
  for (const [label, expr] of [
    ['popularNovels', `__yd.popular(${JSON.stringify(p.id)}, 1, false, "")`],
    ['searchNovels', `__yd.search(${JSON.stringify(p.id)}, "x", 1)`],
    ['parseNovel', `__yd.novel(${JSON.stringify(p.id)}, "/x/")`],
    ['parseChapter', `__yd.chapter(${JSON.stringify(p.id)}, "/x/1/")`],
    ...(p.contentType === 'comic' ? [['parsePages', `__yd.pages(${JSON.stringify(p.id)}, "/x/1/")`]] : []),
  ]) {
    if (label === 'parseChapter' && p.contentType === 'comic') {
      assert.equal(evalSync(expr), '', `${p.path}: parseChapter may be empty for comics`);
      continue;
    }
    // A member that exists either answers (empty list) or fails with our offline HTTP 404; a missing one is "not a function".
    try {
      const out = evalSync(expr);
      assert.ok(label !== 'parsePages' || out !== '[]', `${p.path}: parsePages missing`);
    } catch (e) {
      assert.ok(/404/.test(e.message) && !/not a function/.test(e.message), `${p.path}: ${label} missing or broken: ${e.message}`);
    }
  }
  loaded++;
}
console.log(`loaded ${loaded}/${manifest.plugins.length} generated plugins, required members present`);

// ---- 2. behaviour against canned HTML, one plugin per template ----------------------------------------------
const pick = (jsTemplate, contentType) => {
  const p = manifest.plugins.find((x) => x.jsTemplate === jsTemplate && x.contentType === contentType);
  assert.ok(p, `no generated ${jsTemplate}/${contentType} plugin to test`);
  return p;
};
const load = (p) => JSON.parse(evalSync(`__yd.load(${JSON.stringify(p.id)}, ${JSON.stringify(readFileSync(join(YDN, p.path), 'utf8'))})`));

// Madara novel
{
  const p = pick('madara', 'novel');
  const d = load(p);
  const site = d.site;
  route = (req) => {
    const u = req.url;
    if (u.startsWith(`${site}?s=&post_type=wp-manga`) || u.includes('?s=dragon')) {
      return `<div class="c-tabs-item__content"><div class="post-title"><h3><a href="${site}novel/dragon-saga/" title="Dragon Saga">Dragon Saga</a></h3></div><img data-src="/c/d.jpg"></div>`;
    }
    if (u === `${site}novel/dragon-saga/`) {
      return `<div class="post-title"><h1><span class="manga-title-badges">HOT</span> Dragon Saga</h1></div><div class="summary_image"><a><img src="/c/d.jpg"></a></div>
        <div class="author-content"><a href="/manga-author/x">Ann</a></div><div class="genres-content"><a rel="tag">Fantasy</a><a rel="tag">Action</a></div>
        <div class="description-summary"><p>One.</p><p>Two.</p></div>
        <div class="post-content_item"><div class="summary-heading">Status</div><div class="summary-content">OnGoing</div></div>
        <div id="manga-chapters-holder" data-id="42"></div>`;
    }
    if (u === `${site}novel/dragon-saga/ajax/chapters/` && req.method === 'POST') {
      return `<ul class="main"><li class="wp-manga-chapter"><a href="${site}novel/dragon-saga/chapter-2/">Chapter 2</a><span class="chapter-release-date"><i>March 5, 2024</i></span></li>
        <li class="wp-manga-chapter"><a href="${site}novel/dragon-saga/chapter-1/">Chapter 1</a></li></ul>`;
    }
    if (u === `${site}novel/dragon-saga/chapter-1/`) {
      return '<div class="reading-content"><h3>junk</h3><p>Hello <b>world</b>.</p><script>x()</script><p>Second.</p></div>';
    }
  };
  const pop = call(`__yd.popular(${JSON.stringify(p.id)}, 1, false, "")`);
  assert.deepEqual(pop, [{ name: 'Dragon Saga', path: '/novel/dragon-saga/', cover: `${new URL(site).origin}/c/d.jpg` }]);
  assert.equal(call(`__yd.search(${JSON.stringify(p.id)}, "dragon", 1)`).length, 1);
  const n = call(`__yd.novel(${JSON.stringify(p.id)}, "/novel/dragon-saga/")`);
  assert.equal(n.name, 'Dragon Saga');
  assert.equal(n.author, 'Ann');
  assert.equal(n.genres, 'Fantasy,Action');
  assert.equal(n.summary, 'One.\n\nTwo.');
  assert.equal(n.status, 'Ongoing');
  assert.deepEqual(n.chapters.map((c) => c.name), ['Chapter 1', 'Chapter 2'], 'oldest first');
  assert.equal(n.chapters[1].path, '/novel/dragon-saga/chapter-2/');
  const html = evalSync(`__yd.chapter(${JSON.stringify(p.id)}, "/novel/dragon-saga/chapter-1/")`);
  assert.match(html, /<p>Hello <b>world<\/b>\.<\/p>/);
  assert.doesNotMatch(html, /junk|script/);
  console.log(`madara/novel ok (${p.id})`);
}

// Madara comic
{
  const p = pick('madara', 'comic');
  const d = load(p);
  assert.ok(d.imageRequestInit?.headers?.Referer, 'comic plugins send a Referer for images');
  route = (req) => {
    if (req.url.includes('/ch-1/?style=list')) {
      return '<div class="reading-content"><img data-src=" /i/1.jpg "><img src="/i/2.jpg"><img src="data:image/gif;base64,AAA"></div>';
    }
  };
  const pages = call(`__yd.pages(${JSON.stringify(p.id)}, "/manga/x/ch-1/")`);
  const origin = new URL(d.site).origin;
  assert.deepEqual(pages, [`${origin}/i/1.jpg`, `${origin}/i/2.jpg`]);
  assert.equal(evalSync(`__yd.chapter(${JSON.stringify(p.id)}, "/manga/x/ch-1/")`), '');
  console.log(`madara/comic ok (${p.id})`);
}

// NovelFull
{
  const p = pick('novelfull', 'novel');
  const d = load(p);
  const site = d.site;
  route = (req) => {
    const u = req.url;
    if (u.startsWith(`${site}most-popular`) || u.startsWith(`${site}search?keyword=`)) {
      return '<div id="list-page"><div class="row"><h3 class="truyen-title"><a href="/hero.html" title="The Hero">The Hero</a></h3><img class="cover" src="/u/h.jpg"></div></div>';
    }
    if (u === `${site}hero.html`) {
      return `<div class="col-info-desc"><h3 class="title">The Hero</h3></div><div class="book"><img src="/u/h.jpg"></div>
        <div class="info"><ul><li><h3>Author:</h3><a href="/author/bob">Bob</a></li><li><h3>Genre:</h3><a>Action</a><a>Drama</a></li><li><h3>Status:</h3><a>Completed</a></li></ul></div>
        <div class="desc-text"><p>A hero.</p></div><div id="rating" data-novel-id="7"></div>`;
    }
    if (u === `${site}ajax/chapter-archive?novelId=7`) {
      return '<ul class="list-chapter"><li><a href="/hero/chapter-1.html" title="Chapter 1: Start">Chapter 1</a></li><li><a href="/hero/chapter-2.html" title="Chapter 2">Chapter 2</a></li></ul>';
    }
    if (u === `${site}hero/chapter-1.html`) {
      return '<div id="chr-content"><div class="ad">buy</div><h3>Chapter 1</h3><p>Once upon a time.</p></div>';
    }
  };
  assert.equal(call(`__yd.popular(${JSON.stringify(p.id)}, 1, false, "")`)[0].name, 'The Hero');
  assert.equal(call(`__yd.search(${JSON.stringify(p.id)}, "hero", 1)`)[0].path, '/hero.html');
  const n = call(`__yd.novel(${JSON.stringify(p.id)}, "/hero.html")`);
  assert.equal(n.name, 'The Hero');
  assert.equal(n.author, 'Bob');
  assert.equal(n.genres, 'Action,Drama');
  assert.equal(n.status, 'Completed');
  assert.deepEqual(n.chapters.map((c) => c.name), ['Chapter 1: Start', 'Chapter 2']);
  const html = evalSync(`__yd.chapter(${JSON.stringify(p.id)}, "/hero/chapter-1.html")`);
  assert.match(html, /Once upon a time/);
  assert.doesNotMatch(html, /buy|<h3>/);
  console.log(`novelfull/novel ok (${p.id})`);
}

// MangaStream (novel flavour in the current lncrawl set; also run the comic path through a forced config)
{
  const p = pick('mangastream', manifest.plugins.some((x) => x.jsTemplate === 'mangastream' && x.contentType === 'comic') ? 'comic' : 'novel');
  const d = load(p);
  const site = d.site;
  route = (req) => {
    const u = req.url;
    if (u.startsWith(`${site}manga/?page=1&order=popular`)) {
      return '<div class="listupd"><div class="bsx"><a class="tip" href="/manga/blade/" title="Blade"><img data-src="/c/b.jpg"><div class="tt">Blade</div></a></div></div>';
    }
    if (u === `${site}manga/blade/`) {
      return `<h1 class="entry-title">Blade</h1><div class="thumbook"><img src="/c/b.jpg"></div><div class="entry-content" itemprop="description"><p>Sharp.</p></div>
        <div class="eplister"><ul><li data-num="2"><a href="/blade-ch-2/"><span class="chapternum">Chapter 2</span><span class="chapterdate">March 5, 2024</span></a></li>
        <li data-num="1"><a href="/blade-ch-1/"><span class="chapternum">Chapter 1</span></a></li></ul></div>`;
    }
    if (u === `${site}blade-ch-1/`) {
      return `<div id="readerarea"><img src="/p/1.jpg"><img data-src="/p/2.jpg"><p>Text page</p></div>`;
    }
  };
  assert.equal(call(`__yd.popular(${JSON.stringify(p.id)}, 1, false, "")`)[0].name, 'Blade');
  const n = call(`__yd.novel(${JSON.stringify(p.id)}, "/manga/blade/")`);
  assert.equal(n.name, 'Blade');
  assert.deepEqual(n.chapters.map((c) => c.name), ['Chapter 1', 'Chapter 2']);
  const origin = new URL(site).origin;
  if (p.contentType === 'comic') {
    assert.deepEqual(call(`__yd.pages(${JSON.stringify(p.id)}, "/blade-ch-1/")`), [`${origin}/p/1.jpg`, `${origin}/p/2.jpg`]);
  } else {
    assert.match(evalSync(`__yd.chapter(${JSON.stringify(p.id)}, "/blade-ch-1/")`), /Text page/);
  }
  console.log(`mangastream/${p.contentType} ok (${p.id})`);
}

ctx.dispose();
rt.dispose();
console.log('YDN LNCRAWL-GEN TESTS PASSED');
