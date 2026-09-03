import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_ROOT = resolve(__dirname, '..', '..', '..');
const REPOSITORY_ROOT = resolve(API_ROOT, '..', '..');
const APP_ROOT = resolve(REPOSITORY_ROOT, 'apps', 'app');

function runOriginPreflight(origin: string | undefined) {
  const env = { ...process.env };
  if (origin === undefined) {
    delete env.EXPO_PUBLIC_API_URL;
  } else {
    env.EXPO_PUBLIC_API_URL = origin;
  }

  return spawnSync('bun', ['run', 'validate:api-origin'], {
    cwd: APP_ROOT,
    env,
    encoding: 'utf8',
  });
}

describe('the web export fails closed before bundling', () => {
  it.each([
    'https://api.example.test',
    'https://api.example.test/',
    'https://api.example.test:8443',
  ])('accepts the valid HTTPS origin %s', (origin) => {
    const result = runOriginPreflight(origin);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it.each([
    undefined,
    '',
    ' https://api.example.test',
    'http://api.example.test',
    'ftp://api.example.test',
    'https://user:password@api.example.test',
    'https://api.example.test/v1',
    'https://api.example.test?target=v1',
    'https://api.example.test#target',
  ])('kills a missing or invalid production origin mutant: %s', (origin) => {
    const result = runOriginPreflight(origin);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
  });

  it('does not echo a malformed origin into the failure output', () => {
    const marker = 'private-origin-marker';
    const result = runOriginPreflight(`not-a-url-${marker}`);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(marker);
  });

  it('wires the checked preflight into both export commands and the deploy workflow', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(APP_ROOT, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const workflow = readFileSync(
      resolve(REPOSITORY_ROOT, '.github', 'workflows', 'deploy.yml'),
      'utf8',
    );
    const ciWorkflow = readFileSync(
      resolve(REPOSITORY_ROOT, '.github', 'workflows', 'ci.yml'),
      'utf8',
    );

    expect(manifest.scripts?.['validate:api-origin']).toBe('bun scripts/validate-api-origin.ts');
    expect(manifest.scripts?.build).toMatch(/^bun run validate:api-origin &&/u);
    expect(manifest.scripts?.['build:production']).toMatch(/^bun run validate:api-origin &&/u);
    expect(workflow).toContain('EXPO_PUBLIC_API_URL: ${{ vars.STATION_API_URL }}');
    expect(workflow).toContain('run: cd apps/app && bun run build:production');
    expect(workflow).not.toContain('bunx expo export --platform web');
    expect(ciWorkflow).toContain('EXPO_PUBLIC_API_URL: https://api.example.test');
    expect(ciWorkflow).not.toContain('EXPO_PUBLIC_API_URL: http://');
  });
});
