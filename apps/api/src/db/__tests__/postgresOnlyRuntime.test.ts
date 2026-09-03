import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const API_ROOT = resolve(__dirname, '..', '..', '..');
const REPOSITORY_ROOT = resolve(API_ROOT, '..', '..');

function trackedFiles(...paths: string[]): string[] {
  return execFileSync('git', ['ls-files', '--', ...paths], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .filter((file) => existsSync(resolve(REPOSITORY_ROOT, file)));
}

function importedPackages(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map(({ fileName }) => fileName);
}

function mongoImports(): string[] {
  return trackedFiles('apps/api/src')
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .filter((file) =>
      importedPackages(readFileSync(resolve(REPOSITORY_ROOT, file), 'utf8')).some(
        (specifier) =>
          specifier === 'mongoose' ||
          specifier.startsWith('mongoose/') ||
          specifier === 'mongodb' ||
          specifier.startsWith('mongodb/'),
      ),
    );
}

describe('the Station runtime stays PostgreSQL-only', () => {
  it('detects real package imports before asserting the Mongo importer set is empty', () => {
    const sourceFiles = trackedFiles('apps/api/src').filter((file) => /\.[cm]?[jt]sx?$/.test(file));
    const drizzleImporters = sourceFiles.filter((file) =>
      importedPackages(readFileSync(resolve(REPOSITORY_ROOT, file), 'utf8')).some(
        (specifier) => specifier === 'drizzle-orm' || specifier.startsWith('drizzle-orm/'),
      ),
    );

    expect(sourceFiles.length).toBeGreaterThan(50);
    expect(sourceFiles).toEqual(expect.arrayContaining([
      'apps/api/src/index.ts',
      'apps/api/src/db/client.ts',
      'apps/api/src/db/schema/index.ts',
      'apps/api/src/routes/workspaces.ts',
    ]));
    expect(drizzleImporters.length).toBeGreaterThan(10);
    expect(mongoImports()).toEqual([]);
  });

  it('declares no Mongo driver or test server dependency', () => {
    const manifest = JSON.parse(readFileSync(resolve(API_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]);

    expect([...declared].filter((name) => ['mongoose', 'mongodb', 'mongodb-memory-server'].includes(name))).toEqual([]);
  });
});

describe('the checked-in public surfaces describe routes that exist', () => {
  it('has no implicit production API origin', () => {
    const config = readFileSync(
      resolve(REPOSITORY_ROOT, 'apps/app/lib/config.ts'),
      'utf8',
    );
    const validator = readFileSync(
      resolve(REPOSITORY_ROOT, 'apps/app/lib/api-origin.ts'),
      'utf8',
    );
    const deploy = readFileSync(
      resolve(REPOSITORY_ROOT, '.github/workflows/deploy.yml'),
      'utf8',
    );

    expect(config).toContain("process.env.NODE_ENV === 'production'");
    expect(config).not.toContain('api.station.oxy.so');
    expect(validator).toContain('EXPO_PUBLIC_API_URL is required');
    expect(validator).not.toContain('api.station.oxy.so');
    expect(deploy).toContain('EXPO_PUBLIC_API_URL: ${{ vars.STATION_API_URL }}');
    expect(deploy).toContain('bun run build:production');
    expect(deploy).not.toContain('api.station.oxy.so');
    expect(
      readFileSync(resolve(REPOSITORY_ROOT, 'apps/api/src/routes/share-links.ts'), 'utf8'),
    ).not.toContain("|| 'https://station.oxy.so'");
  });

  it('binds notification sockets to the server-validated Oxy session', () => {
    const serverSocket = readFileSync(
      resolve(REPOSITORY_ROOT, 'apps/api/src/socket.ts'),
      'utf8',
    );
    const clientSocket = readFileSync(
      resolve(REPOSITORY_ROOT, 'apps/app/lib/hooks/use-notification-setup.ts'),
      'utf8',
    );

    expect(serverSocket).toContain('io.use(oxyClient.authSocket())');
    expect(serverSocket).toContain('socket.data.userId');
    expect(serverSocket).not.toContain("socket.on('subscribe-notifications'");
    expect(clientSocket).toContain('oxyServices.getAccessToken()');
    expect(clientSocket).not.toContain("socket.emit('subscribe-notifications'");
  });

  it('generates a sitemap containing only Station routes that are present', () => {
    const generator = readFileSync(
      resolve(REPOSITORY_ROOT, 'apps/app/scripts/generate-sitemap.ts'),
      'utf8',
    );
    const generatedRoutes = [...generator.matchAll(/\bloc:\s*['"]([^'"]+)['"]/g)]
      .map((match) => match[1]);
    const sitemap = readFileSync(
      resolve(REPOSITORY_ROOT, 'apps/app/public/sitemap.xml'),
      'utf8',
    );
    const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((match) => match[1]);

    expect(generatedRoutes).toEqual(['/']);
    expect(sitemapUrls).toEqual(['https://station.oxy.so/']);
  });

  it('does not advertise Alia or nonexistent Station pages in robots.txt', () => {
    const robots = readFileSync(
      resolve(REPOSITORY_ROOT, 'apps/app/public/robots.txt'),
      'utf8',
    );
    const sitemapLines = robots
      .split('\n')
      .filter((line) => line.startsWith('Sitemap:'));

    expect(robots).not.toContain('alia.onl');
    expect(robots).not.toContain('/developers/');
    expect(sitemapLines).toEqual(['Sitemap: https://station.oxy.so/sitemap.xml']);
  });

  it('does not mount or advertise the catch-all webhook router that always returned 404', () => {
    const indexSource = readFileSync(
      resolve(REPOSITORY_ROOT, 'apps/api/src/index.ts'),
      'utf8',
    );

    expect(existsSync(resolve(REPOSITORY_ROOT, 'apps/api/src/routes/webhooks.ts'))).toBe(false);
    expect(indexSource).not.toContain("./routes/webhooks.js");
    expect(indexSource).not.toMatch(/app\.use\(['"]\/webhooks['"]/);
  });

  it('mounts the workspace API without retired inference route groups', () => {
    const indexSource = readFileSync(resolve(REPOSITORY_ROOT, 'apps/api/src/index.ts'), 'utf8');

    expect(indexSource).toContain("app.use('/workspaces', workspacesRouter)");
    expect(indexSource).toContain("app.use('/pages', pagesRouter)");
    expect(indexSource).toContain("app.use('/databases', databasesRouter)");
    expect(indexSource).not.toMatch(/app\.use\(['"]\/(?:v1|clarity|conversations|billing|credits|models|analytics|internal)/u);
  });
});
