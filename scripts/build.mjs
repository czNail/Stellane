import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/host/index.ts'], outfile: 'dist/host.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  tsconfig: 'tsconfig.host.json',
  packages: 'external', sourcemap: true,
});
await build({
  entryPoints: ['src/client/index.tsx'], outfile: 'dist/client.js',
  bundle: true, platform: 'browser', format: 'cjs', target: 'es2022',
  tsconfig: 'tsconfig.client.json', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], sourcemap: true,
  loader: { '.css': 'text' },
  banner: { js: 'window.__ModuleLoader__.load({ id: "@stellane/harness-plugin", factory: (require) => { const module = { exports: {} }; const exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
});
