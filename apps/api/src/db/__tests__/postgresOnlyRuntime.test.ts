import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
    .filter(Boolean);
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

const FORBIDDEN_DEPLOYMENT_TOKEN = /\bMONGO(?:DB)?_URI\b|mongodb(?:\+srv)?:\/\//i;
const PROVIDER_CREDENTIAL_ENV = new RegExp(
  `\\b(?:${[
    'ANTHROPIC',
    'CEREBRAS',
    'CLOUDFLARE',
    'COHERE',
    'DEEPSEEK',
    'DIGITALOCEAN',
    'FIREWORKS',
    'GOOGLE',
    'GROK',
    'GROQ',
    'HYPERBOLIC',
    'MISTRAL',
    'NOVITA',
    'OPENAI',
    'OPENROUTER',
    'PERPLEXITY',
    'REPLICATE',
    'SAMBANOVA',
    'TOGETHER',
    'XAI',
  ].join('|')})_(?:API_KEY|KEYS)\\b`,
);

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

  it('keeps Mongo connection configuration out of deploy and env surfaces', () => {
    expect('MONGODB_URI=mongodb://127.0.0.1:27017/station').toMatch(FORBIDDEN_DEPLOYMENT_TOKEN);

    const configurationFiles = trackedFiles(
      '.do',
      '.github',
      'sst.config.ts',
      'apps/api/.env.example',
      'apps/api/Dockerfile',
    );
    const offenders = configurationFiles.filter((file) =>
      FORBIDDEN_DEPLOYMENT_TOKEN.test(readFileSync(resolve(REPOSITORY_ROOT, file), 'utf8')),
    );

    expect(configurationFiles.length).toBeGreaterThan(3);
    expect(offenders).toEqual([]);
  });

  it('keeps provider credentials out of Station source and environment surfaces', () => {
    expect(['OPENAI', 'API_KEY'].join('_')).toMatch(PROVIDER_CREDENTIAL_ENV);

    const credentialSurfaces = trackedFiles(
      'apps/api/src',
      'apps/api/.env.example',
      '.do',
      '.github',
      'sst.config.ts',
    );
    const offenders = credentialSurfaces.filter((file) =>
      PROVIDER_CREDENTIAL_ENV.test(readFileSync(resolve(REPOSITORY_ROOT, file), 'utf8')),
    );

    expect(credentialSurfaces.length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
