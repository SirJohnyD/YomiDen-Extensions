// Usage: node prepare-paperback.mjs versioning.json source.js source-id > plugin.js
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const [indexPath, bundlePath, sourceId] = process.argv.slice(2);
const index = JSON.parse(await readFile(indexPath, 'utf8'));
const entry = index.sources.find((source) => source.id === sourceId);
if (!entry || !/^[a-zA-Z0-9_-]+$/.test(entry.id)) throw new Error('Invalid Paperback source ID');
if (index.builtWith?.toolchain) throw new Error('This converter supports Paperback 0.6/0.7 only');
if (!['https:', 'http:'].includes(new URL(entry.websiteBaseURL).protocol)) {
  throw new Error('Paperback sources need an HTTP(S) website');
}
const metadata = {
  id: 'paperback-' + entry.id,
  sourceId: entry.id,
  name: entry.name,
  site: entry.websiteBaseURL,
  version: entry.version,
};
const bundle = await transform(await readFile(bundlePath, 'utf8'), {
  target: 'es2016',
  minify: true,
  legalComments: 'inline',
});
process.stdout.write(
  'exports.default = require("yomiden/paperback").createPaperbackPlugin(' +
  JSON.stringify(metadata) + ', ' + JSON.stringify(bundle.code) + ');\n',
);
