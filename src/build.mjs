#!/usr/bin/env node
// Bundle a JS entry into one HTML file that opens offline with a double click.
// .glb/.gltf/.png/.jpg/.hdr imports become embedded data URLs.
//
// Usage (run where esbuild and your 3D packages are installed):
//   node build_single_html.mjs main.js out.html "Page title" [template.html]
// A template, if given, must contain the marker <!--BUNDLE--> where the script goes.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const [entry, out, title = '3D', template] = process.argv.slice(2);
if (!entry || !out) {
  console.error('Usage: node build_single_html.mjs main.js out.html "Page title" [template.html]');
  process.exit(2);
}
const require = createRequire(path.join(process.cwd(), 'noop.js'));
const esbuild = require('esbuild');

const result = await esbuild.build({
  entryPoints: [entry], bundle: true, format: 'esm', target: 'es2022', minify: process.env.NOMIN ? false : true, write: false,
  loader: { '.glb': 'dataurl', '.gltf': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl', '.hdr': 'dataurl' },
  logLevel: 'warning',
});
// "</script" inside the bundle would end the tag early.
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const tag = `<script type="module">${js}</script>`;
const shell = template
  ? fs.readFileSync(template, 'utf8')
  : `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>html,body{margin:0;height:100%;overflow:hidden;background:#0b0d12}canvas{display:block}</style></head>
<body><!--BUNDLE--></body></html>`;
if (!shell.includes('<!--BUNDLE-->')) {
  console.error('Template is missing <!--BUNDLE-->');
  process.exit(2);
}
fs.writeFileSync(out, shell.replace('<!--BUNDLE-->', () => tag));
console.log(`${out}: ${(fs.statSync(out).size / 1048576).toFixed(2)} MB`);
