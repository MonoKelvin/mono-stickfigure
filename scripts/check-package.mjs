import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('请通过 npm run test:package 执行');
const runNpm = (args, cwd) => execFileSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8' });
const directory = await mkdtemp(join(root, '.artifacts', 'consumer-'));
const packed = Object.values(JSON.parse(runNpm(['pack', '--json', '--pack-destination', directory], root)))[0];
const tarball = join(directory, packed.filename);
const files = packed.files.map((file) => file.path);
if (files.some((file) => /^(src|tests|examples|node_modules|\.artifacts)\//.test(file))) throw new Error('发布白名单包含开发文件');
await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'mono-consumer-test', version: '0.0.0', private: true, type: 'module' }));
runNpm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball], directory);
const code = `import { createStickFigure, type StickFigureOptions } from 'mono-stickfigure';\nimport { createStickFigure as createCore } from 'mono-stickfigure/core';\nconst options: StickFigureOptions = { seed: 7 };\ncreateStickFigure(options).destroy();\ncreateCore(options).getSnapshot();\n`;
await writeFile(join(directory, 'index.mts'), code);
await writeFile(join(directory, 'index.cts'), code);
const documentationSources = ['README.md', 'README.zh.md', 'docs/02-详细设计.md'];
const documentationFiles = [];
for (const source of documentationSources) {
  const document = await readFile(join(root, source), 'utf8');
  const current = source.startsWith('docs/') ? document.split('### 11.1')[1].split('### 11.3')[0] : document;
  const snippets = [...current.matchAll(/^```ts\r?\n([\s\S]*?)^```/gm)].map((match) => match[1]).join('\n');
  const file = `usage-${documentationFiles.length + 1}.mts`;
  await writeFile(join(directory, file), snippets);
  documentationFiles.push(file);
}
const require = createRequire(import.meta.url);
const tsPackage = require.resolve('typescript/package.json');
const tsMeta = JSON.parse(await readFile(tsPackage, 'utf8'));
const compiler = resolve(dirname(tsPackage), tsMeta.bin.tsc);
for (const mode of ['NodeNext', 'Bundler']) {
  const config = {
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: false, target: 'ES2022', module: mode === 'NodeNext' ? 'NodeNext' : 'ESNext', moduleResolution: mode, lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: [] },
    include: [...(mode === 'NodeNext' ? ['index.mts', 'index.cts'] : ['index.mts']), ...documentationFiles],
  };
  await writeFile(join(directory, 'tsconfig.json'), JSON.stringify(config));
  execFileSync(process.execPath, [compiler, '-p', join(directory, 'tsconfig.json')], { cwd: directory, stdio: 'pipe' });
}
await writeFile(join(directory, 'runtime.mjs'), `import assert from 'node:assert/strict';\nimport {createRequire} from 'node:module';\nimport {createStickFigure} from 'mono-stickfigure';\nconst require=createRequire(import.meta.url);\nfor(const create of [createStickFigure,require('mono-stickfigure').createStickFigure,require('mono-stickfigure/core').createStickFigure]) {\nconst actor=create();assert.equal(actor.getSnapshot().status,'created');await assert.rejects(actor.start(),/BROWSER_REQUIRED/);actor.destroy();assert.equal(actor.getSnapshot().status,'destroyed');\n}\n`);
execFileSync(process.execPath, [join(directory, 'runtime.mjs')], { cwd: directory, stdio: 'pipe' });
const report = { tarball: packed.filename, fileCount: files.length, nodeNext: 'passed', bundler: 'passed', documentationExamples: { status: 'passed', sources: documentationSources }, runtimeEsmAndCjs: 'passed', whitelist: 'passed' };
await writeFile(join(root, '.artifacts', 'package-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
