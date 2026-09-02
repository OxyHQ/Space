import * as esbuild from 'esbuild';
import { cp } from 'fs/promises';

await esbuild.build({
  // The migrator is a SECOND entry point, not part of the server bundle: the
  // deploy runs it as its own process, and `drizzle-kit migrate` is not an
  // option because drizzle-kit is a devDependency and the production image
  // installs with --production. Without this line `dist/` has no migrator at
  // all, which a passing build says nothing about.
  entryPoints: ['src/index.ts', 'src/db/migrate.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outdir: 'dist',
  outbase: 'src',
  // Keep node_modules external except @oxyhq/* (their ESM builds have broken imports)
  plugins: [{
    name: 'externalize-except-oxyhq',
    setup(build) {
      // Let @oxyhq/* packages be bundled (their ESM has missing .js extensions)
      build.onResolve({ filter: /^@oxyhq\// }, () => undefined);
      // Externalize all other bare imports (node_modules)
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path.startsWith('@oxyhq/')) return undefined;
        return { path: args.path, external: true };
      });
    },
  }],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

// The generated SQL. `src/db/migrate.ts` resolves this folder relative to its
// own module URL and throws when no journal is there, so a build that silently
// skipped this step fails loudly at migrate time instead of reporting a clean
// run over zero migrations. Deliberately NOT wrapped in try/catch: a build that
// cannot ship the migrations must fail, not warn.
await cp('src/drizzle', 'dist/drizzle', { recursive: true });
