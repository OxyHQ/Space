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
  'GEMINI_API_KEY',
  'NVIDIA_API_KEY',
  'AMD_API_KEY',
  'REQUESTY_API_KEY',
  'AI_GATEWAY_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'MODELSCOPE_API_KEY',
  'ZHIPU_API_KEY',
  'OLLAMA_API_KEY',
  'OVH_AI_ENDPOINTS_ACCESS_TOKEN',
  'KILO_API_KEY',
  'OPENCODE_API_KEY',
  'AION_API_KEY',
  'AGNES_API_KEY',
  'DASHSCOPE_API_KEY',
  'SILICONFLOW_API_KEY',
  'GLHF_API_KEY',
  'AI21_API_KEY',
  'NSCALE_API_KEY',
  'NEBIUS_API_KEY',
  'VLLM_API_KEY',
  'MLX_API_KEY',
  'LLAMAFILE_API_KEY',
  'LM_STUDIO_API_KEY',
  'LLAMA_CPP_API_KEY',
  'JAN_API_KEY',
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
  '@google-cloud/vertexai',
  '@huggingface/inference',
  '@huggingface/transformers',
  '@langchain/anthropic',
  '@langchain/google-genai',
  '@langchain/openai',
  '@mistralai/mistralai',
  '@xai/sdk',
  'ai',
  'cerebras-cloud-sdk',
  'cohere-ai',
  'fireworks-ai',
  'groq-sdk',
  'langchain',
  'llamaindex',
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
    'integrate\\.api\\.nvidia\\.com',
    'developer\\.amd\\.com\\.cn/radeon/api',
    'router\\.requesty\\.ai',
    'ai-gateway\\.vercel\\.sh',
    'api\\.llm7\\.io',
    'router\\.huggingface\\.co',
    'api-inference\\.modelscope\\.cn',
    'open\\.bigmodel\\.cn',
    'api\\.ollama\\.com',
    '[a-z0-9.-]*endpoints\\.kepler\\.ai\\.cloud\\.ovh\\.net',
    'api\\.kilo\\.ai',
    'opencode\\.ai/zen',
    'api\\.aionlabs\\.ai',
    'apihub\\.agnes-ai\\.com',
    'dashscope-intl\\.aliyuncs\\.com',
    'api\\.siliconflow\\.cn',
    'glhf\\.chat/api/openai',
    'api\\.ai21\\.com',
    'inference\\.api\\.nscale\\.com',
    'api\\.studio\\.nebius\\.com',
    '[a-z0-9.-]*openai\\.azure\\.com',
  ].join('|')})`,
  'iu',
);
const CLOUDFLARE_INFERENCE_ENDPOINT =
  /https?:\/\/api\.cloudflare\.com\/[^\s'"`]*\/ai(?:\/|\b)/iu;
const INFERENCE_SURFACE = /inference|chat.?completions|kaana|relay|alia.?provider/iu;
const FORBIDDEN_ROUTING_FIELDS = new Set([
  'provider',
  'providerid',
  'providername',
  'model',
  'modelid',
  'modelname',
  'deploymentid',
  'deploymentname',
  'routeid',
  'routename',
  'routingprofilename',
  'priority',
  'order',
]);
const ORDER_ROUTING_FALLBACK = /\.(?:find|findIndex|filter|sort|orderBy)\s*\(.{0,500}\b(?:provider|model|name|priority|order)\b/isu;
const COLLECTION_ROUTING_FALLBACK = /\b(?:deployments|routes|models|providers|candidates)\s*\.\s*(?:find|findIndex|filter|sort|orderBy)\s*\(/iu;
const FIRST_ROW_ROUTING_FALLBACK = /\b(?:deployments|routes|models|providers|candidates|rows)\s*\[\s*0\s*\]|\.(?:at|limit)\s*\(\s*(?:0|1)\s*\)|\bfindFirst\s*\(/iu;
const PROVIDER_STORAGE = /\b(?:provider|inference|model)[_-]?(?:keys?|credentials?|secrets?)\b|key-manager/iu;

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

function executableSource(artifact: Artifact): string {
  if (artifact.path.endsWith('.d.ts')) return '';
  return ts.transpileModule(artifact.source, {
    fileName: artifact.path,
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
      target: ts.ScriptTarget.ESNext,
    },
  }).outputText;
}

function hasForbiddenRoutingReference(artifact: Artifact): boolean {
  const sourceFile = ts.createSourceFile(
    artifact.path,
    artifact.source,
    ts.ScriptTarget.Latest,
    true,
  );
  let violation = false;

  function checkName(name: ts.Node): void {
    if (
      (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
      FORBIDDEN_ROUTING_FIELDS.has(name.text.replace(/[_-]/gu, '').toLowerCase())
    ) {
      violation = true;
    }
  }

  function visit(node: ts.Node): void {
    if (
      ts.isBindingElement(node) ||
      ts.isParameter(node) ||
      ts.isPropertyAccessExpression(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isShorthandPropertyAssignment(node) ||
      ts.isVariableDeclaration(node)
    ) {
      checkName(node.name);
    } else if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      checkName(node.argumentExpression);
    }

    if (!violation) ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violation;
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

  for (const artifact of [...configuration, ...manifests]) {
    if (providerEnvPattern.test(artifact.source) || internalInferenceEnvPattern.test(artifact.source)) {
      violations.push({ kind: 'provider_env', path: artifact.path });
    }
    if (
      DIRECT_INFERENCE_ENDPOINT.test(artifact.source) ||
      CLOUDFLARE_INFERENCE_ENDPOINT.test(artifact.source)
    ) {
      violations.push({ kind: 'direct_inference_endpoint', path: artifact.path });
    }
  }

  for (const artifact of runtime) {
    const source = executableSource(artifact);
    const imports = importedPackages(artifact.source).map(packageRoot);
    if (
      providerEnvPattern.test(source) ||
      internalInferenceEnvPattern.test(source) ||
      (artifact.path.endsWith('.d.ts') &&
        (providerEnvPattern.test(artifact.source) ||
          internalInferenceEnvPattern.test(artifact.source)))
    ) {
      violations.push({ kind: 'provider_env', path: artifact.path });
    }
    if (
      DIRECT_INFERENCE_ENDPOINT.test(source) ||
      CLOUDFLARE_INFERENCE_ENDPOINT.test(source)
    ) {
      violations.push({ kind: 'direct_inference_endpoint', path: artifact.path });
    }
    if (
      artifact.path.includes('/internal/providers/') ||
      PROVIDER_STORAGE.test(source)
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
        source,
      )
    ) {
      violations.push({ kind: 'provider_execution', path: artifact.path });
    }
    if (
      INFERENCE_SURFACE.test(`${artifact.path}\n${source}`) &&
      (hasForbiddenRoutingReference(artifact) ||
        ORDER_ROUTING_FALLBACK.test(source) ||
        COLLECTION_ROUTING_FALLBACK.test(source) ||
        FIRST_ROW_ROUTING_FALLBACK.test(source))
    ) {
      violations.push({ kind: 'name_or_order_routing', path: artifact.path });
    }
    if (
      /['"]\/(?:clarity\/search|v1\/chat\/completions|v1\/models)(?:['"/?]|$)/u.test(
        source,
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

  it('kills a direct Kaana endpoint exposed as TSX text', () => {
    expect(
      boundaryViolations(
        [
          {
            path: 'apps/app/components/inference-help.tsx',
            source: '<Text>https://kaana.ai/internal/v1/inference</Text>',
          },
        ],
        [],
        [],
      ),
    ).toContainEqual({
      kind: 'direct_inference_endpoint',
      path: 'apps/app/components/inference-help.tsx',
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

  it.each(['GEMINI_API_KEY', 'NVIDIA_API_KEY', 'HF_TOKEN', 'MODELSCOPE_API_KEY'])(
    'kills a provider credential in a manifest or build script: %s',
    (environmentName) => {
      expect(
        boundaryViolations(
          [],
          [],
          [
            {
              path: 'package.json',
              source: JSON.stringify({ scripts: { build: environmentName } }),
            },
          ],
        ),
      ).toContainEqual({ kind: 'provider_env', path: 'package.json' });
    },
  );

  it('kills direct inference endpoints in deploy configuration without blocking Cloudflare Pages', () => {
    expect(
      boundaryViolations(
        [],
        [
          {
            path: '.github/workflows/deploy.yml',
            source: 'https://api.cloudflare.com/client/v4/accounts/account/ai/run/model',
          },
        ],
        [],
      ),
    ).toContainEqual({
      kind: 'direct_inference_endpoint',
      path: '.github/workflows/deploy.yml',
    });
    expect(
      boundaryViolations(
        [],
        [
          {
            path: '.github/workflows/deploy.yml',
            source: 'https://api.cloudflare.com/client/v4/accounts/account/pages/projects/station',
          },
        ],
        [],
      ),
    ).toEqual([]);
  });

  it.each(['providerCredentials', 'inference_secrets', 'model_keys'])(
    'kills a renamed provider credential store: %s',
    (storageName) => {
      expect(
        boundaryViolations(
          [{ path: 'apps/api/src/db/schema/inference.ts', source: `pgTable('${storageName}')` }],
          [],
          [],
        ),
      ).toContainEqual({
        kind: 'provider_storage',
        path: 'apps/api/src/db/schema/inference.ts',
      });
    },
  );

  it.each([
    "const request = { provider: 'openai' };",
    "const request = { model: 'gpt-display-name' };",
    "const request = { routingProfileName: 'fast' };",
    'const request = { model };',
    "const request = { model_id: 'display-id' };",
    'interface InferenceRequest { model?: string }',
    'const selected = response.deploymentId;',
    'const request = { order: 1 };',
    'const selected = deployments.find((deployment) => deployment.name === wanted);',
    'const selected = deployments.find((deployment) => deployment.id === wanted);',
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

  it('does not treat historical source comments as executable inference wiring', () => {
    expect(
      boundaryViolations(
        [
          {
            path: 'apps/api/src/lib/inference-boundary.ts',
            source: [
              '// import OpenAI from \'openai\';',
              '// const request = { model: \'retired-name\' };',
              '/* fetch(\'https://kaana.ai/internal/v1/inference\'); */',
              '// OPENAI_API_KEY=retired',
              'export const workspaceFeatureEnabled = true;',
            ].join('\n'),
          },
        ],
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
      'apps/api/build.ts',
      'apps/api/drizzle.config.ts',
      'apps/app/app.json',
      'apps/app/eas.json',
      'bunfig.toml',
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
