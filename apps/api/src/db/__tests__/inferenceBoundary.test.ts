import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const API_ROOT = resolve(__dirname, '..', '..', '..');
const REPOSITORY_ROOT = resolve(API_ROOT, '..', '..');

interface Artifact {
  path: string;
  source: string;
}

type ViolationKind =
  | 'provider_env'
  | 'provider_storage'
  | 'provider_sdk'
  | 'mongo_runtime'
  | 'provider_execution'
  | 'legacy_inference_route';

interface Violation {
  kind: ViolationKind;
  path: string;
}

const PROVIDER_ENV_NAMES = [
  'OPENAI_API_KEY',
  'OPENAI_KEYS',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_KEYS',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GOOGLE_KEYS',
  'GROQ_API_KEY',
  'GROQ_KEYS',
  'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'TOGETHER_API_KEY',
  'TOGETHER_KEYS',
  'REPLICATE_API_TOKEN',
  'CEREBRAS_API_KEY',
  'CEREBRAS_KEYS',
  'OPENROUTER_API_KEY',
  'COHERE_API_KEY',
  'FIREWORKS_API_KEY',
  'PERPLEXITY_API_KEY',
  'XAI_API_KEY',
  'SAMBANOVA_API_KEY',
  'HYPERBOLIC_API_KEY',
  'NOVITA_API_KEY',
  'DIGITALOCEAN_KEYS',
] as const;

const PROVIDER_SDKS = new Set([
  '@ai-sdk/anthropic',
  '@ai-sdk/google',
  '@ai-sdk/openai',
  '@anthropic-ai/sdk',
  'cohere-ai',
  'groq-sdk',
  'openai',
  'replicate',
]);

const MONGO_PACKAGES = new Set(['mongodb', 'mongodb-memory-server', 'mongoose']);

function trackedFiles(...paths: string[]): string[] {
  return execFileSync('git', ['ls-files', '--', ...paths], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .filter((file) => existsSync(resolve(REPOSITORY_ROOT, file)));
}

function artifacts(paths: readonly string[]): Artifact[] {
  return paths.map((path) => ({
    path,
    source: readFileSync(resolve(REPOSITORY_ROOT, path), 'utf8'),
  }));
}

function importedPackages(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map(({ fileName }) => fileName);
}

function packageRoot(specifier: string): string {
  if (!specifier.startsWith('@')) return specifier.split('/')[0] ?? specifier;
  return specifier.split('/').slice(0, 2).join('/');
}

function boundaryViolations(
  runtime: readonly Artifact[],
  configuration: readonly Artifact[],
  manifests: readonly Artifact[],
): Violation[] {
  const violations: Violation[] = [];
  const providerEnvPattern = new RegExp(`\\b(?:${PROVIDER_ENV_NAMES.join('|')})\\b`, 'u');

  for (const artifact of [...runtime, ...configuration]) {
    if (providerEnvPattern.test(artifact.source)) {
      violations.push({ kind: 'provider_env', path: artifact.path });
    }
  }

  for (const artifact of runtime) {
    const imports = importedPackages(artifact.source).map(packageRoot);
    if (
      artifact.path.includes('/internal/providers/') ||
      /\bprovider_keys\b|\bproviderKeys\b|key-manager/iu.test(artifact.source)
    ) {
      violations.push({ kind: 'provider_storage', path: artifact.path });
    }
    if (imports.some((specifier) => PROVIDER_SDKS.has(specifier))) {
      violations.push({ kind: 'provider_sdk', path: artifact.path });
    }
    if (imports.some((specifier) => MONGO_PACKAGES.has(specifier))) {
      violations.push({ kind: 'mongo_runtime', path: artifact.path });
    }
    if (
      /\b(?:createOpenAI|createAnthropic|createGoogleGenerativeAI|generateText|streamText)\s*\(/u.test(
        artifact.source,
      ) ||
      /https:\/\/(?:api\.openai\.com|api\.anthropic\.com|api\.groq\.com)/u.test(
        artifact.source,
      )
    ) {
      violations.push({ kind: 'provider_execution', path: artifact.path });
    }
    if (
      /['"]\/(?:clarity\/search|v1\/chat\/completions|v1\/models)(?:['"/?]|$)/u.test(
        artifact.source,
      )
    ) {
      violations.push({ kind: 'legacy_inference_route', path: artifact.path });
    }
  }

  for (const artifact of configuration) {
    if (/\bMONGODB_URI\b|engine:\s*MONGODB/iu.test(artifact.source)) {
      violations.push({ kind: 'mongo_runtime', path: artifact.path });
    }
  }

  for (const manifest of manifests) {
    const parsed = JSON.parse(manifest.source) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
    ];
    if (declared.some((name) => PROVIDER_SDKS.has(name) || name.startsWith('@ai-sdk/'))) {
      violations.push({ kind: 'provider_sdk', path: manifest.path });
    }
    if (declared.some((name) => MONGO_PACKAGES.has(name))) {
      violations.push({ kind: 'mongo_runtime', path: manifest.path });
    }
  }

  return violations;
}

describe('Station has no local inference runtime', () => {
  it('positive control: every forbidden boundary has a fixture that the gate catches', () => {
    const providerSdk = ['@ai-sdk', 'openai'].join('/');
    const mongoPackage = ['mongo', 'db'].join('');
    const providerStorage = ['provider', 'keys'].join('_');
    const legacyRoute = ['/v1', 'chat', 'completions'].join('/');
    const providerEnvironment = ['OPENAI', 'API', 'KEY'].join('_');
    const runtime: Artifact[] = [
      {
        path: 'fixture.ts',
        source:
          `import sdk from '${providerSdk}'; import db from '${mongoPackage}';\n` +
          `const table = '${providerStorage}'; const route = '${legacyRoute}';\n` +
          'generateText({});',
      },
    ];
    const configuration: Artifact[] = [
      { path: 'fixture.env', source: `${providerEnvironment}=secret\nMONGODB_URI=mongodb://db` },
    ];
    const manifests: Artifact[] = [
      {
        path: 'fixture.json',
        source: JSON.stringify({ dependencies: { [providerSdk]: '1', [mongoPackage]: '1' } }),
      },
    ];

    expect(new Set(boundaryViolations(runtime, configuration, manifests).map((v) => v.kind))).toEqual(
      new Set<ViolationKind>([
        'provider_env',
        'provider_storage',
        'provider_sdk',
        'mongo_runtime',
        'provider_execution',
        'legacy_inference_route',
      ]),
    );
  });

  it('keeps production source, deploy configuration, env examples and manifests clean', () => {
    const runtimePaths = trackedFiles('apps/api/src', 'apps/app')
      .filter((path) => /\.[cm]?[jt]sx?$/u.test(path))
      .filter((path) => !path.includes('/__tests__/'))
      .filter((path) => !path.endsWith('.test.ts'))
      .filter((path) => !path.endsWith('.pgdb.test.ts'));
    const configurationPaths = trackedFiles(
      'apps/api/.env.example',
      'apps/app/.env.example',
      '.github',
      'Dockerfile',
      'apps/api/Dockerfile',
      'apps/api/docker-compose.postgres.yml',
    );
    const manifestPaths = trackedFiles('package.json', 'apps/api/package.json', 'apps/app/package.json');

    expect(runtimePaths.length).toBeGreaterThan(100);
    expect(configurationPaths.length).toBeGreaterThan(3);
    expect(manifestPaths).toHaveLength(3);
    expect(boundaryViolations(
      artifacts(runtimePaths),
      artifacts(configurationPaths),
      artifacts(manifestPaths),
    )).toEqual([]);
  });
});
