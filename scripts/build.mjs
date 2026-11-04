// Builds dist/esm and dist/cjs with tsc. Refuses to build when src/version.ts and
// package.json disagree, because the version is sent in every User-Agent header.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const versionSource = readFileSync(join(root, 'src', 'version.ts'), 'utf8');
const sourceVersion = /VERSION = '([^']+)'/.exec(versionSource)?.[1];
if (sourceVersion !== pkg.version) {
  console.error(`build: src/version.ts says ${sourceVersion}, package.json says ${pkg.version}`);
  process.exit(1);
}

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
rmSync(join(root, 'dist'), { recursive: true, force: true });
for (const project of ['tsconfig.build-esm.json', 'tsconfig.build-cjs.json']) {
  execFileSync(process.execPath, [tsc, '-p', project], { cwd: root, stdio: 'inherit' });
}
writeFileSync(join(root, 'dist', 'cjs', 'package.json'), '{\n  "type": "commonjs"\n}\n');
console.log(`build: sursolver ${pkg.version} -> dist/esm, dist/cjs`);
