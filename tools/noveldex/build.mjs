// Builds the YDN NovelDex plugins from the upstream LNReader TypeScript source (MIT, LNReader contributors).
//   node tools/noveldex/build.mjs <path to noveldex.ts> [typescript module dir]
// Outputs: plugins/patches/noveldex.js        (novel plugin, patch of the vendored LNReader copy)
//          plugins/own/noveldex-comics.js     (comic plugin, own entry) + plugins/own/noveldex-comics.json (catalog meta)
// Compiled like upstream ships it: tsc, target ES5, module CommonJS, esModuleInterop.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(process.argv[2], 'utf8');
const require = createRequire(import.meta.url);
const ts = require(process.argv[3] || 'typescript');

function replaceOnce(text, from, to) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`expected exactly one match (${n}) for: ${from.slice(0, 70)}`);
  return text.replace(from, () => to);
}
function replaceAll(text, from, to, expected) {
  const n = text.split(from).length - 1;
  if (n !== expected) throw new Error(`expected ${expected} matches (${n}) for: ${from.slice(0, 70)}`);
  return text.split(from).join(to);
}

const NOVEL_TYPES = ['Novel', 'Light Novel', 'Web Novel', 'Published Novel', 'Fanfiction', 'Original Fiction', 'One Shot'];
const COMIC_TYPES = ['Manhwa', 'Manhua', 'Manga', 'Webtoon'];

const helpers = (variant) => `
  contentType = '${variant.comic ? 'comic' : 'novel'}';
  ${variant.comic ? "imageRequestInit = { headers: { Referer: 'https://noveldex.io' } };" : ''}

  // YomiDen: this plugin only lists series of its own kind (novels here, comics in NovelDex Comics)
  private defaultTypes: string[] = ${JSON.stringify(variant.comic ? COMIC_TYPES : NOVEL_TYPES)};

  private textOf(v: any): string {
    if (typeof v === 'string') return v.trim();
    if (v && typeof v === 'object') return this.textOf(v.name ?? v.label ?? v.title ?? '');
    return '';
  }

  // YomiDen: the series' type (Light Novel / Web Novel / Manhwa ...) and origin (Korean / Chinese / Japanese) go
  // first in the genre list so the app can detect the format badge from them.
  private tagList(s: any): string[] {
    const out: string[] = [];
    const add = (v: any) => {
      const t = this.textOf(v);
      if (t && !out.some(o => o.toLowerCase() === t.toLowerCase())) out.push(t);
    };
    add(s?.type ?? s?.seriesType ?? s?.contentType ?? s?.format);
    add(s?.origin ?? s?.originCountry ?? s?.country);
    (Array.isArray(s?.genres) ? s.genres : []).forEach((g: any) => add(g));
    return out;
  }

  private seriesPath(s: any): string {
    // use whatever path the site gives; upstream's /series/novel/<slug> serves every type
    const given = s?.urlPath ?? s?.path ?? s?.href;
    if (typeof given === 'string' && given.startsWith('/series/')) return given;
    return \`/series/novel/\${s.urlSlug}\`;
  }
`;

const comicMethods = `
  // YomiDen: comic chapters. The page list is read from the RSC payload; every failure is a clear error.
  private pageUrl(v: any): string {
    const raw = typeof v === 'string' ? v : v?.url ?? v?.src ?? v?.imageUrl ?? v?.image ?? '';
    if (typeof raw !== 'string' || !raw.trim()) return '';
    try {
      return new URL(raw.trim(), this.site).href;
    } catch {
      return '';
    }
  }

  private pagesFromPayload(rscText: string): string[] {
    for (const key of ['images', 'pages', 'panels']) {
      const re = new RegExp('"' + key + '"\\\\s*:\\\\s*\\\\[', 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(rscText))) {
        const json = this.extractBalancedJson(rscText, m.index + m[0].length - 1);
        if (!json) continue;
        try {
          const arr = JSON.parse(json);
          const urls = Array.isArray(arr) ? arr.map((x: any) => this.pageUrl(x)).filter(Boolean) : [];
          if (urls.length) return urls;
        } catch {
          // try the next occurrence
        }
      }
    }
    return [];
  }

  async parsePages(chapterPath: string): Promise<string[]> {
    const rscText = await this.fetchRsc(\`\${this.site}\${chapterPath}\`);
    if (/"isUnlocked"\\s*:\\s*false/.test(rscText)) {
      throw new Error('This chapter requires premium access and cannot be read here.');
    }
    let pages = this.pagesFromPayload(rscText);
    if (!pages.length && /"xorEncryption"/.test(rscText)) {
      // some chapters ship their content encrypted like novel text: decrypt and read the <img> tags
      try {
        const html = await this.parseNovelChapter(chapterPath);
        pages = Array.from(html.matchAll(/<img\\b[^>]*?\\bsrc="([^"]+)"/gi))
          .map(m => this.pageUrl(m[1]))
          .filter(Boolean);
      } catch (error) {
        throw new Error('NovelDex comic pages could not be loaded: ' + (error as Error).message);
      }
    }
    if (!pages.length) {
      throw new Error(
        'NovelDex comic pages could not be parsed (the site layout may have changed, or the chapter is premium).',
      );
    }
    return pages;
  }
`;

function build(variant) {
  let t = src;
  t = replaceOnce(t, "id = 'noveldex';", `id = '${variant.id}';`);
  t = replaceOnce(t, "name = 'NovelDex';", `name = '${variant.name}';`);
  t = replaceOnce(t, "version = '1.0.0';", "version = '1.0.0-ydn.1';");
  t = replaceOnce(t, 'webStorageUtilized?: boolean;', 'webStorageUtilized?: boolean;\n' + helpers(variant));
  // imageRequestInit is declared once upstream; the comic variant sets it in helpers, so drop the upstream line
  if (variant.comic) {
    t = replaceOnce(t, 'imageRequestInit?: Plugin.ImageRequestInit | undefined = undefined;', '');
  }
  // (a) type + origin in the genre list
  t = replaceOnce(
    t,
    /const genres =\s*s\.genres\s*\?\.map\(g => g\.name\)\s*\.filter\(Boolean\)\s*\.join\(', '\) \|\| '';/.exec(t)?.[0] ?? '<<no match>>',
    "const genres = this.tagList(s).join(', ');",
  );
  t = replaceOnce(t, 'const genres = seriesData?.genres?.map(g => g.name) || [];', 'const genres = this.tagList(seriesData);');
  // (b) browse/search stay inside this plugin's own kind
  t = replaceAll(t, 'path: `/series/novel/${s.urlSlug}`,', 'path: this.seriesPath(s),', 2);
  t = replaceOnce(t, "addList(f?.type?.value, 'type');", "addList(f?.type?.value?.length ? f.type.value : this.defaultTypes, 'type');");
  t = replaceOnce(
    t,
    "const params = new URLSearchParams({ q: searchTerm, sort: 'views' });",
    "const params = new URLSearchParams({ q: searchTerm, sort: 'views' });\n    params.set('type', this.defaultTypes.join(','));",
  );
  // parseNovel / parseChapter wrappers
  t = replaceOnce(t, 'async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {', 'private async parseNovelCore(novelPath: string): Promise<Plugin.SourceNovel> {');
  t = replaceOnce(t, 'async parseChapter(chapterPath: string): Promise<string> {', 'private async parseNovelChapter(chapterPath: string): Promise<string> {');
  const wrappers = variant.comic
    ? `
  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const candidates = [novelPath];
    if (novelPath.startsWith('/series/novel/')) {
      candidates.push(novelPath.replace('/series/novel/', '/series/comic/'));
    }
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        const novel = await this.parseNovelCore(candidate);
        if (novel?.chapters?.length || candidate === candidates[candidates.length - 1]) return novel;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error('NovelDex comic could not be loaded: ' + ((lastError as Error)?.message || 'unknown layout'));
  }

  // comics are read through parsePages
  async parseChapter(_chapterPath: string): Promise<string> {
    return '';
  }
${comicMethods}`
    : `
  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    return this.parseNovelCore(novelPath);
  }

  async parseChapter(chapterPath: string): Promise<string> {
    return this.parseNovelChapter(chapterPath);
  }
`;
  t = replaceOnce(t, '  resolveUrl = (path: string) => this.site + path;', wrappers + '\n  resolveUrl = (path: string) => this.site + path;');
  const js = ts.transpileModule(t, {
    compilerOptions: { target: ts.ScriptTarget.ES5, module: ts.ModuleKind.CommonJS, esModuleInterop: true, strict: true },
  }).outputText;
  return js;
}

const header = (what) =>
  `// YomiDen ${what}: derived from LNReader's NovelDex plugin (MIT, LNReader contributors). Generated by tools/noveldex/build.mjs.\n// ydn-patch: 1\n`;

mkdirSync(path.join(root, 'plugins/patches'), { recursive: true });
mkdirSync(path.join(root, 'plugins/own'), { recursive: true });
writeFileSync(
  path.join(root, 'plugins/patches/noveldex.js'),
  header('patch') + build({ id: 'noveldex', name: 'NovelDex', comic: false }),
);
writeFileSync(
  path.join(root, 'plugins/own/noveldex-comics.js'),
  header('plugin') + build({ id: 'noveldex-comics', name: 'NovelDex Comics', comic: true }),
);
writeFileSync(
  path.join(root, 'plugins/own/noveldex-comics.json'),
  JSON.stringify(
    { id: 'noveldex-comics', name: 'NovelDex Comics', lang: 'en', contentType: 'comic', nsfw: false, version: '1.0.0-ydn.1',
      site: 'https://noveldex.io', iconUrl: 'https://noveldex.io/favicon.ico', credit: 'LNReader noveldex plugin (MIT)' },
    null, 1,
  ) + '\n',
);
console.log('ok');
