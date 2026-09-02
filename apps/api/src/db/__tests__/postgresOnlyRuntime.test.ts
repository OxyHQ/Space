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

    expect(sourceFiles.length).toBeGreaterThan(100);
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

  it('documents only the named events emitted by the current chat handler', () => {
    const chatDocs = readFileSync(resolve(REPOSITORY_ROOT, 'docs/chat-api.mdx'), 'utf8');
    const handler = readFileSync(
      resolve(REPOSITORY_ROOT, 'apps/api/src/routes/v1/chat-completions.ts'),
      'utf8',
    );
    const documentedEvents = [...chatDocs.matchAll(/`(oxystation\.[a-z_]+)`/g)]
      .map((match) => match[1]);
    const emittedEvents = [...handler.matchAll(/event: (oxystation\.[a-z_]+)/g)]
      .map((match) => match[1]);

    expect(new Set(documentedEvents)).toEqual(new Set(emittedEvents));
    expect(chatDocs).not.toContain('event: clarity.');
    expect(chatDocs).not.toContain('deepResearch?:');
  });
});
