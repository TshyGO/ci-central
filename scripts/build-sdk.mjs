import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['review-action/src/sdk-client.js'],
  outfile: 'review-action/dist/sdk-client.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  minify: true,
  legalComments: 'linked',
});
const notices = await Promise.all(['openai', 'undici'].map(async (name) => {
  const base = new URL(`../node_modules/${name}/`, import.meta.url);
  const { version } = JSON.parse(await readFile(new URL('package.json', base), 'utf8'));
  return `${name} ${version}\n\n${await readFile(new URL('LICENSE', base), 'utf8')}`;
}));
await writeFile(new URL('../review-action/dist/THIRD_PARTY_LICENSES.txt', import.meta.url), notices.join('\n\n---\n\n'));
