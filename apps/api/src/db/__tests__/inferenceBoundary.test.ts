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
  | 'direct_inference_endpoint'
  | 'name_or_order_routing'
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
  '@aws-sdk/client-bedrock-runtime',
  '@azure/openai',
  '@cloudflare/ai',
  '@fal-ai/client',
  '@google/generative-ai',
  '@google/genai',
  '@huggingface/inference',
  '@mistralai/mistralai',
  '@xai/sdk',
  'ai',
  'cerebras-cloud-sdk',
  'cohere-ai',
  'fireworks-ai',
  'groq-sdk',
  'mistralai',
  'ollama',
  'openai',
  'openrouter',
  'replicate',
  'together-ai',
]);

const MONGO_PACKAGES = new Set(['mongodb', 'mongodb-memory-server', 'mongoose']);
const DIRECT_INFERENCE_ENDPOINT = new RegExp(
  `https?://(?:${[
    'kaana\\.ai',
    'api\\.kaana\\.ai',
    'kaana\\.oxy\\.so',
    'relay\\.oxy\\.so',
    '[a-z0-9.-]*alia-provider[a-z0-9.-]*',
    'api\\.openai\\.com',
    'api\\.anthropic\\.com',
    'api\\.groq\\.com',
    'generativelanguage\\.googleapis\\.com',
    'api\\.mistral\\.ai',
    'api\\.deepseek\\.com',
    'api\\.together\\.xyz',
    'api\\.replicate\\.com',
    'api\\.cerebras\\.ai',
    'openrouter\\.ai',
    'api\\.cohere\\.com',
    'api\\.fireworks\\.ai',
    'api\\.perplexity\\.ai',
    'api\\.x\\.ai',
    'api\\.sambanova\\.ai',
    'api\\.hyperbolic\\.xyz',
    'api\\.novita\\.ai',
  ].join('|')})`,
  'iu',
);
const INFERENCE_SURFACE = /inference|chat.?completions|kaana|relay|alia.?provider/iu;
const NAME_ROUTING_FIELD = /\b(?:provider|providerId|providerName|model|modelId|modelName|deploymentName|routingProfileName|priority|order)\s*:/u;
const ORDER_ROUTING_FALLBACK = /\.(?:find|findIndex|filter|sort|orderBy)\s*\(.{0,500}\b(?:provider|model|name|priority|order)\b/isu;
const FIRST_ROW_ROUTING_FALLBACK = /\b(?:deployments|routes|models|providers|candidates|rows)\s*\[\s*0\s*\]|\.(?:at|limit)\s*\(\s*(?:0|1)\s*\)|\bfindFirst\s*\(/iu;

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
  const internalInferenceEnvPattern = /\b(?:KAANA|RELAY|ALIA_(?:PROVIDER|OPENAI|ANTHROPIC|GOOGLE|GROQ|MISTRAL|DEEPSEEK|TOGETHER|REPLICATE|CEREBRAS|OPENROUTER|COHERE|FIREWORKS|PERPLEXITY|XAI|SAMBANOVA|HYPERBOLIC|NOVITA|DIGITALOCEAN))_[A-Z0-9_]+\b/u;

  for (const artifact of [...runtime, ...configuration]) {
    if (providerEnvPattern.test(artifact.source) || internalInferenceEnvPattern.test(artifact.source)) {
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
    if (
      imports.some(
        (specifier) => PROVIDER_SDKS.has(specifier) || specifier.startsWith('@ai-sdk/'),
      )
    ) {
      violations.push({ kind: 'provider_sdk', path: artifact.path });
    }
    if (imports.some((specifier) => MONGO_PACKAGES.has(specifier))) {
      violations.push({ kind: 'mongo_runtime', path: artifact.path });
    }
    if (
      /\b(?:createOpenAI|createAnthropic|createGoogleGenerativeAI|generateText|streamText)\s*\(/u.test(
        artifact.source,
      )
    ) {
      violations.push({ kind: 'provider_execution', path: artifact.path });
    }
    if (DIRECT_INFERENCE_ENDPOINT.test(artifact.source)) {
      violations.push({ kind: 'direct_inference_endpoint', path: artifact.path });
    }
    if (
      INFERENCE_SURFACE.test(`${artifact.path}\n${artifact.source}`) &&
      (NAME_ROUTING_FIELD.test(artifact.source) ||
        ORDER_ROUTING_FALLBACK.test(artifact.source) ||
        FIRST_ROW_ROUTING_FALLBACK.test(artifact.source))
    ) {
      violations.push({ kind: 'name_or_order_routing', path: artifact.path });
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
    const internalInferenceEnvironment = ['KAANA', 'SIGNING', 'SECRET'].join('_');
    const directEndpoint = ['https://kaana', 'ai'].join('.');
    const runtime: Artifact[] = [
      {
        path: 'fixture.ts',
        source:
          `import sdk from '${providerSdk}'; import db from '${mongoPackage}';\n` +
          `const table = '${providerStorage}'; const route = '${legacyRoute}';\n` +
          `const endpoint = '${directEndpoint}'; const selection = { modelName: 'display-name' };\n` +
          'generateText({});',
      },
    ];
    const configuration: Artifact[] = [
      {
        path: 'fixture.env',
        source:
          `${providerEnvironment}=secret\n${internalInferenceEnvironment}=secret\n` +
          'MONGODB_URI=mongodb://db',
      },
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
        'direct_inference_endpoint',
        'name_or_order_routing',
        'legacy_inference_route',
      ]),
    );
  });

  it.each([
    'https://kaana.ai/internal/v1/inference',
    'http://kaana.ai/internal/v1/inference',
    'https://api.kaana.ai/v1/inference',
    'https://kaana.oxy.so/v1/inference',
    'https://relay.oxy.so/v1/inference',
    'https://edge.alia-provider.oxy.so/v1/inference',
  ])('kills a direct inference endpoint mutant: %s', (endpoint) => {
    expect(
      boundaryViolations(
        [{ path: 'apps/api/src/lib/inference-client.ts', source: `fetch('${endpoint}')` }],
        [],
        [],
      ),
    ).toContainEqual({
      kind: 'direct_inference_endpoint',
      path: 'apps/api/src/lib/inference-client.ts',
    });
  });

  it.each(['KAANA_SIGNING_SECRET', 'RELAY_API_URL', 'ALIA_PROVIDER_TOKEN', 'ALIA_OPENAI_API_KEY'])(
    'kills an internal inference credential mutant: %s',
    (environmentName) => {
      expect(
        boundaryViolations(
          [],
          [{ path: 'fixture.env', source: `${environmentName}=secret` }],
          [],
        ),
      ).toContainEqual({ kind: 'provider_env', path: 'fixture.env' });
    },
  );

  it.each([
    "const request = { provider: 'openai' };",
    "const request = { model: 'gpt-display-name' };",
    "const request = { routingProfileName: 'fast' };",
    'const request = { order: 1 };',
    'const selected = deployments.find((deployment) => deployment.name === wanted);',
    'const selected = deployments.sort((left, right) => left.priority - right.priority)[0];',
    'const selected = deployments.orderBy((deployment) => deployment.order)[0];',
    'const selected = deployments[0];',
    'const selected = candidates.at(0);',
    'const selected = query.limit(1);',
    'const selected = query.findFirst();',
  ])('kills a name or order routing fallback mutant: %s', (source) => {
    expect(
      boundaryViolations(
        [{ path: 'apps/api/src/lib/inference-client.ts', source }],
        [],
        [],
      ),
    ).toContainEqual({
      kind: 'name_or_order_routing',
      path: 'apps/api/src/lib/inference-client.ts',
    });
  });

  it('allows an Oxy inference request that carries only an exact opaque routing id', () => {
    const source =
      "fetch(`${oxyOrigin}/inference/station/summarize`, { body: JSON.stringify({ routingProfileId }) });";

    expect(
      boundaryViolations(
        [{ path: 'apps/api/src/lib/inference-client.ts', source }],
        [],
        [],
      ),
    ).toEqual([]);
  });

  it.each([...PROVIDER_SDKS])('rejects the direct provider SDK %s', (providerSdk) => {
    const manifest: Artifact = {
      path: 'package.json',
      source: JSON.stringify({ dependencies: { [providerSdk]: '1' } }),
    };

    expect(boundaryViolations([], [], [manifest])).toContainEqual({
      kind: 'provider_sdk',
      path: 'package.json',
    });
  });

  it('rejects an unlisted direct AI SDK adapter', () => {
    const source = "import { createProvider } from '@ai-sdk/new-provider';";

    expect(
      boundaryViolations([{ path: 'apps/api/src/lib/inference-client.ts', source }], [], []),
    ).toContainEqual({
      kind: 'provider_sdk',
      path: 'apps/api/src/lib/inference-client.ts',
    });
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
      '.do',
      'app.json',
      'Dockerfile',
      'apps/api/Dockerfile',
      'apps/api/docker-compose.postgres.yml',
      'apps/app/app.json',
      'apps/app/eas.json',
      'sst.config.ts',
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
