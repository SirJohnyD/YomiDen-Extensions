#!/usr/bin/env node
// YomiDen lncrawl -> JS plugin generator (spec 5.5).
//
// Reads lightnovel-crawler's sources/_index.json and the crawler files, and for every crawler built on one of the
// ported templates emits a self-contained LNReader-format plugin to ydn/plugins/<lang>/<id>.js plus
// ydn/plugins/manifest.json (consumed by tools/aggregate.py).
//
//   node generate.mjs [--lncrawl DIR]    # default: shallow clone into ydn/.cache/lightnovel-crawler
//
// Ported templates (lncrawl class -> JS template):
//   NovelFullTemplate                                  -> templates/novelfull.js     (novels)
//   MadaraTemplate, WordpressTemplate,
//   WordpressMangaTemplate                             -> templates/madara.js        (novels + comics)
//   MangaStreamTemplate                                -> templates/mangastream.js   (comics + novels)
// Crawlers that override chapter-list/body logic are skipped (listed in the manifest), not guessed at.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { parseLiteral } from './pyliteral.mjs';

export const GEN_REV = 1; // bump when the templates change so versions move forward
const HERE = dirname(fileURLToPath(import.meta.url));
const YDN = resolve(HERE, '../..');
const PLUGINS = join(YDN, 'plugins');
const LNCRAWL_REPO = 'https://github.com/lncrawl/lightnovel-crawler.git';
// Same check the Android runtime performs (novel-runtime/src/runtime.js): native async/await is not supported there.
const NATIVE_ASYNC = /(^|[^\w$.])async\s+(function\b|\(|[A-Za-z_$][\w$]*\s*(=>|\())|(^|[^\w$.])await\s+[\w$(\[]/;

const TEMPLATES = {
  NovelFullTemplate: {
    js: 'novelfull',
    sel: {
      title: 'h3.title',
      cover: '.book img',
      author: ".info a[href*='/a/'], .info a[href*='/au/'], .info a[href*='author']",
      tags: ".info a[href*='/au/']",
      synopsis: '.desc-text',
      chapterBody: '#chr-content, #chapter-content',
    },
    badTags: [],
  },
  MadaraTemplate: madara(),
  WordpressTemplate: madara(),
  WordpressMangaTemplate: madara(),
  MangaStreamTemplate: {
    js: 'mangastream',
    sel: {
      title: 'h1.entry-title',
      cover: ".thumbook img, meta[property='og:image'],.sertothumb img",
      author: ".spe a[href*='/writer/']",
      tags: ".bottom.tags a[href*='/tag/']",
      synopsis: '.entry-content',
      chapterBody: '#readernovel, #readerarea, .entry-content',
    },
    badTags: ['h3'],
  },
};

function madara() {
  return {
    js: 'madara',
    sel: {
      title: '.post-title h1',
      cover: '.summary_image a img',
      author: '.author-content a[href*="manga-author"]',
      tags: '.genres-content a[rel="tag"]',
      synopsis: '.description-summary',
      chapterBody: 'div.reading-content',
    },
    badTags: ['h3'],
    badCss: ['a[href="javascript:void(0)"]'],
  };
}

const ATTR_TO_SEL = {
  novel_title_selector: 'title',
  novel_cover_selector: 'cover',
  novel_author_selector: 'author',
  novel_tags_selector: 'tags',
  novel_synopsis_selector: 'synopsis',
  chapter_list_selector: 'chapterList',
  chapter_body_selector: 'chapterBody',
};

// Overriding any of these changes how chapters are listed/fetched; the template port would be wrong.
const BLOCKING_METHODS = new Set([
  'select_chapter_tags',
  'select_chapter_body',
  'download_chapter',
  'parse_volume_list',
  'select_volume_tags',
  'parse_chapter_item',
  'parse_chapter_body',
  'parse_chapter_url',
  'build_chapter_url',
  'select_search_item_list',
  'search',
  'read_novel_info',
  'get_chapter_list',
]);

function log(...a) {
  console.log('[lncrawl-gen]', ...a);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function ensureClone() {
  const given = arg('--lncrawl');
  if (given) return { dir: resolve(given), branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], resolve(given)) };
  const dir = join(YDN, '.cache', 'lightnovel-crawler');
  mkdirSync(join(YDN, '.cache'), { recursive: true });
  let lastErr;
  for (const branch of ['dev', 'master', 'main']) {
    try {
      if (existsSync(join(dir, '.git'))) {
        git(['fetch', '--depth', '1', 'origin', branch], dir);
        git(['reset', '--hard', 'FETCH_HEAD'], dir);
      } else {
        rmSync(dir, { recursive: true, force: true });
        git(['clone', '--depth', '1', '--branch', branch, LNCRAWL_REPO, dir], YDN);
      }
      if (existsSync(join(dir, 'sources', '_index.json'))) return { dir, branch };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`could not clone lightnovel-crawler: ${lastErr?.message}`);
}

export function domainOf(url) {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^(www|m)\./, '');
  } catch {
    return '';
  }
}

function normBase(u) {
  let s = String(u).trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.endsWith('/') ? s : `${s}/`;
}

/** Splits a python file into its class bodies keyed by class name. */
function parseClasses(src) {
  const lines = src.split('\n');
  const out = [];
  let cur = null;
  for (const line of lines) {
    const m = /^class\s+(\w+)\s*\(([\w.]+)\)\s*:/.exec(line);
    if (m) {
      cur = { name: m[1], base: m[2].split('.').pop(), lines: [] };
      out.push(cur);
    } else if (cur && (line.startsWith(' ') || line.startsWith('\t') || line.trim() === '')) {
      cur.lines.push(line);
    } else if (cur && line.trim() !== '' && !line.startsWith('#')) {
      cur = null;
    }
  }
  return out.map((c) => ({ ...c, body: c.lines.join('\n') }));
}

function parseClassBody(body) {
  const attrs = {};
  for (const m of body.matchAll(/^ {4}(\w+)\s*(?::\s*[^=\n]+)?=\s*/gm)) {
    try {
      attrs[m[1]] = parseLiteral(body, m.index + m[0].length).value;
    } catch {
      // not a literal (computed value) - ignore
    }
  }
  const methods = [...body.matchAll(/^ {4}def\s+(\w+)/gm)].map((m) => m[1]);
  const cleaner = {};
  const init = /^ {4}def initialize\([^)]*\)[^\n]*:\n([\s\S]*?)(?=^ {4}\S|(?![\s\S]))/m.exec(body);
  if (init) {
    for (const m of init[1].matchAll(/self\.cleaner\.(bad_tags|bad_css|bad_tag_text_pairs)\.update\(\s*/g)) {
      try {
        cleaner[m[1]] = parseLiteral(init[1], m.index + m[0].length).value;
      } catch {
        // ignore
      }
    }
  }
  return { attrs, methods, cleaner, hasInit: !!init, callsSuperInit: !!init && /super\(\)\.initialize\(/.test(init[1]) };
}

function displayName(className, host) {
  const base = className.replace(/(Crawler|Source|Template)$/, '');
  const words = base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s_]+/).filter(Boolean);
  if (words.length > 1) return words.join(' ');
  return host;
}

function compileTemplates() {
  const common = readFileSync(join(HERE, 'templates', 'common.js'), 'utf8');
  const out = {};
  for (const js of ['madara', 'novelfull', 'mangastream']) {
    const src = `${common}\n${readFileSync(join(HERE, 'templates', `${js}.js`), 'utf8')}`;
    const { code } = transformSync(src, { target: 'es2016', loader: 'js', format: 'cjs', legalComments: 'none' });
    if (NATIVE_ASYNC.test(code)) throw new Error(`template ${js} still contains native async syntax`);
    out[js] = code;
  }
  return out;
}

function main() {
  const { dir, branch } = ensureClone();
  const commit = git(['rev-parse', 'HEAD'], dir);
  const index = JSON.parse(readFileSync(join(dir, 'sources', '_index.json'), 'utf8'));
  log(`lncrawl ${branch}@${commit.slice(0, 8)}, ${Object.keys(index.crawlers).length} crawlers`);
  const rejected = new Map();
  for (const [url, reason] of Object.entries(index.rejected || {})) rejected.set(domainOf(url), reason);
  const compiled = compileTemplates();

  const plugins = [];
  const skipped = [];
  const usedIds = new Set();
  const entries = Object.values(index.crawlers).sort((a, b) => a.file_path.localeCompare(b.file_path));

  for (const entry of entries) {
    const file = entry.file_path;
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const classes = parseClasses(readFileSync(path, 'utf8'));
    const cls = classes.find((c) => TEMPLATES[c.base]);
    if (!cls) continue; // legacy / custom / generic crawler: out of scope for the template ports
    const tpl = TEMPLATES[cls.base];
    const skip = (reason) => skipped.push({ file, template: cls.base, reason });

    const { attrs, methods, cleaner, hasInit, callsSuperInit } = parseClassBody(cls.body);
    const blockers = methods.filter((m) => BLOCKING_METHODS.has(m) || m.startsWith('_'));
    if (blockers.length) {
      skip(`custom logic: ${blockers.join(', ')}`);
      continue;
    }
    const bases = [].concat(attrs.base_url ?? entry.base_urls ?? []).map(normBase);
    const alive = bases.filter((b) => !rejected.has(domainOf(b)));
    if (!alive.length) {
      skip(bases.length ? `all base urls rejected by lncrawl (${rejected.get(domainOf(bases[0]))})` : 'no base_url literal');
      continue;
    }
    const comic = !!(entry.has_manga || attrs.has_manga || cls.base === 'WordpressMangaTemplate');
    if (comic && tpl.js === 'novelfull') {
      skip('comic crawler on a novel-only template');
      continue;
    }

    const sel = { ...tpl.sel };
    for (const [attr, key] of Object.entries(ATTR_TO_SEL)) {
      if (typeof attrs[attr] === 'string') sel[key] = attrs[attr];
    }
    const useTplCleaner = !hasInit || callsSuperInit;
    const badTags = [...(useTplCleaner ? tpl.badTags ?? [] : []), ...(Array.isArray(cleaner.bad_tags) ? cleaner.bad_tags : [])];
    const badCss = [...(useTplCleaner ? tpl.badCss ?? [] : []), ...(Array.isArray(cleaner.bad_css) ? cleaner.bad_css : [])];
    const badTagText = {};
    for (const [tag, pats] of Object.entries(cleaner.bad_tag_text_pairs ?? {})) {
      const valid = [].concat(pats).filter((p) => {
        try {
          new RegExp(p, 'i');
          return typeof p === 'string';
        } catch {
          return false;
        }
      });
      if (valid.length) badTagText[tag] = valid;
    }

    const lang = String(entry.language || 'en').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'en';
    const module = file.split('/').pop().replace(/\.py$/, '');
    let id = `lncrawl-${module}`;
    if (usedIds.has(id)) id = `${id}-${lang}`;
    for (let n = 2; usedIds.has(id); n++) id = `lncrawl-${module}-${n}`;
    usedIds.add(id);
    const host = domainOf(alive[0]);
    const customized = methods.filter((m) => m !== 'initialize');
    const cfg = {
      id,
      name: displayName(cls.name, host),
      site: alive[0],
      version: `${GEN_REV}.0.${entry.version}`,
      contentType: comic ? 'comic' : 'novel',
      icon: '',
      sel,
      badTags,
      badCss,
      badTagText,
      lncrawl: { file, commit, template: cls.base, customized },
    };
    if (attrs.madara_body_from_paragraphs === true) cfg.bodyFromParagraphs = true;
    if (typeof attrs.madara_search_quote_mode === 'string') cfg.searchQuoteMode = attrs.madara_search_quote_mode;
    if (Number.isInteger(attrs.madara_search_max_results) && attrs.madara_search_max_results > 0) cfg.searchMax = attrs.madara_search_max_results;
    if (attrs.chapter_list_on_novel_page === true) cfg.chapterListOnNovelPage = true;

    const code = [
      `/* YomiDen plugin generated from lightnovel-crawler (GPL-3.0): ${file} @ ${commit.slice(0, 12)}`,
      ` * template: ${cls.base} -> ${tpl.js}. Do not edit; regenerate with ydn/tools/lncrawl-gen. */`,
      compiled[tpl.js],
      `var CONFIG = ${JSON.stringify(cfg, null, 2)};`,
      'exports.default = createPlugin(CONFIG);',
      '',
    ].join('\n');
    if (NATIVE_ASYNC.test(code)) throw new Error(`${id}: native async syntax in output`);
    plugins.push({ cfg, code, lang, tpl: tpl.js, entryVersion: entry.version, baseUrls: alive, rel: `${lang}/${id}.js` });
  }

  // write output
  for (const f of existsSync(PLUGINS) ? readdirSync(PLUGINS) : []) rmSync(join(PLUGINS, f), { recursive: true, force: true });
  mkdirSync(PLUGINS, { recursive: true });
  const manifestPlugins = [];
  for (const p of plugins.sort((a, b) => a.cfg.id.localeCompare(b.cfg.id))) {
    mkdirSync(dirname(join(PLUGINS, p.rel)), { recursive: true });
    writeFileSync(join(PLUGINS, p.rel), p.code);
    manifestPlugins.push({
      id: p.cfg.id,
      name: p.cfg.name,
      lang: p.lang,
      contentType: p.cfg.contentType,
      version: p.cfg.version,
      path: `plugins/${p.rel}`,
      baseUrls: p.baseUrls,
      template: p.cfg.lncrawl.template,
      jsTemplate: p.tpl,
      file: p.cfg.lncrawl.file,
      customized: p.cfg.lncrawl.customized,
    });
  }
  const byTpl = {};
  for (const p of manifestPlugins) {
    const k = `${p.template}:${p.contentType}`;
    byTpl[k] = (byTpl[k] ?? 0) + 1;
  }
  const manifest = {
    generatorRev: GEN_REV,
    lncrawl: { repo: LNCRAWL_REPO, branch, commit, indexVersion: index.v, crawlers: Object.keys(index.crawlers).length },
    counts: { generated: manifestPlugins.length, skipped: skipped.length, byTemplate: byTpl },
    plugins: manifestPlugins,
    skipped,
  };
  writeFileSync(join(PLUGINS, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  log(`generated ${manifestPlugins.length} plugins, skipped ${skipped.length}`);
  console.log(JSON.stringify(byTpl, null, 1));
}

main();
