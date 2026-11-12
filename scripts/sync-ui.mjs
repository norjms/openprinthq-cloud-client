// Copy artisanhub-ui's look into this app: its CSS values (dist/theme.css), its base classes (src/lib/base.css),
// and the Manrope, Sora and JetBrains Mono files it bundles (SIL Open Font License 1.1) with their licences.
// The app ships offline, so nothing is fetched at run time.
//
//   git clone https://github.com/norjms/artisanhub-ui && cd artisanhub-ui && git checkout v0.1.0 && npm ci
//   node scripts/sync-ui.mjs <artisanhub-ui checkout> [<destination folder>]
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = resolve(process.argv[2] || '');
const dest = resolve(root, process.argv[3] || 'app/ui/ui');
const pkg = JSON.parse(readFileSync(join(ui, 'package.json'), 'utf8'));
if (pkg.name !== 'artisanhub-ui') throw new Error(`${ui} is not an artisanhub-ui checkout`);

const FONTS = [
  ['Manrope', 'manrope', [400, 500, 600, 700]],
  ['Sora', 'sora', [500, 600]],
  ['JetBrains Mono', 'jetbrains-mono', [400]],
];
const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, '
  + 'U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

rmSync(dest, { recursive: true, force: true });
mkdirSync(join(dest, 'fonts'), { recursive: true });
const head = `/* artisanhub-ui ${pkg.version} (MIT), https://github.com/norjms/artisanhub-ui. Copied by scripts/sync-ui.mjs; do not edit. */\n`;
writeFileSync(join(dest, 'theme.css'), head + readFileSync(join(ui, 'dist', 'theme.css'), 'utf8'));
writeFileSync(join(dest, 'base.css'), head + readFileSync(join(ui, 'src', 'lib', 'base.css'), 'utf8'));
let css = head + '/* Fonts: SIL Open Font License 1.1, see fonts/*-OFL.txt. Latin subsets from @fontsource. */\n';
for (const [family, pkgName, weights] of FONTS) {
  const dir = join(ui, 'node_modules', '@fontsource', pkgName);
  copyFileSync(join(dir, 'LICENSE'), join(dest, 'fonts', `${pkgName}-OFL.txt`));
  for (const w of weights) {
    const file = `${pkgName}-latin-${w}-normal.woff2`;
    copyFileSync(join(dir, 'files', file), join(dest, 'fonts', file));
    css += `@font-face{font-family:"${family}";font-style:normal;font-weight:${w};font-display:swap;src:url(fonts/${file}) format("woff2");unicode-range:${LATIN}}\n`;
  }
}
writeFileSync(join(dest, 'fonts.css'), css);
writeFileSync(join(dest, 'VERSION'), `artisanhub-ui ${pkg.version}\n`);
console.log(`artisanhub-ui ${pkg.version} -> ${dest}`);
