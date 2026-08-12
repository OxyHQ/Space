/**
 * The census behind "Agent, Skill and UserMemory are dead, so they are not
 * ported".
 *
 * A claim that nothing reaches three Mongoose models is a claim about ABSENCE,
 * and absence is what a broken scanner reports too. So every assertion here is
 * paired: the same scanner that finds zero references to the dead models must
 * find the known references to the live ones, and it must have read a
 * plausible number of files to do it. A scan that matched nothing at all would
 * fail the positive control and the floor before it could report the
 * comfortable answer.
 *
 * The spellings searched for are the ones an import-only census misses. Each
 * was found in the wild during earlier Oxy ports:
 *   1. `import { X } from '.../models/x.js'`      — static, incl. `import type`
 *   2. `await import('.../models/x.js')`          — dynamic; one exists at
 *                                                    lib/chat-lifecycle.ts:85
 *   3. `mongoose.models.X`                        — registry lookup, no import
 *   4. `mongoose.model('X')`                      — bare name string, no import
 *                                                    and no declaration
 *   5. the module's OTHER exports (constants, types) — importers that never
 *      touch the model and so survive a model-keyed census, then break the
 *      moment the module is deleted
 *   6. `vi.mock('.../models/x.js')` — a reference to the module PATH with no
 *      import anywhere. Found by this census after the first four spellings
 *      reported a clean zero: two of them name the dead modules. They are
 *      counted separately rather than excluded, because a pattern set that
 *      happens not to match the one shape that survives is a scanner narrowed
 *      to a convention until it reports clean.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../..', import.meta.url));

/** This file, which names every symbol it searches for. */
const CENSUS_FILE = join('db', 'schema', '__tests__', 'aiChat.deadModels.test.ts');

/**
 * Model modules this domain owns.
 *
 * `PORTED_MODELS` were live when this census was written and are now DELETED —
 * `routes/conversations.ts`, `lib/conversation-saver.ts`, `lib/chat-lifecycle.ts`
 * and `routes/v1/chat-completions.ts` go through `repositories/conversations.ts`
 * and `repositories/messages.ts`. They kept their own entry rather than being
 * merged into `DEAD_MODELS` because the two are different facts: the dead three
 * were never reached and still exist on disk, while these were reached by six
 * files and no longer exist at all.
 */
const PORTED_MODELS = { conversation: 'Conversation', message: 'Message' } as const;
const DEAD_MODELS = { agent: 'Agent', skill: 'Skill', 'user-memory': 'UserMemory' } as const;

/**
 * Non-model exports co-located in the dead modules. A file importing one of
 * these touches no model, so it is invisible to every model-keyed census — and
 * it still breaks when the module is deleted.
 */
const CO_LOCATED_EXPORTS = [
  'AGENT_ARCHETYPES',
  'getMemoryLimit',
  'MAX_MEMORIES_FREE',
  'MAX_MEMORIES_PRO',
  'MAX_MEMORIES_BUSINESS',
  'MAX_MEMORY_VALUE_LENGTH',
  'MAX_MEMORY_KEY_LENGTH',
  'MAX_CATEGORY_LENGTH',
  'STYLE_MIN_MESSAGES',
  'STYLE_LLM_REFINE_INTERVAL_MS',
  'STYLE_LLM_REFINE_MIN_MESSAGES',
  'STYLE_RAW_ROLLING_WINDOW',
  'IWritingStyleProfile',
  'IWritingStyleRaw',
  'IUserMemory',
  'IAgentPermissions',
  'IAgentSoul',
  'IArchetypeConfig',
  'AgentArchetype',
  'IAgent',
  'ISkill',
] as const;

/**
 * The whole point of stripping comments: a raw scan of `lib/user-context.ts`
 * reports a call site on `UserMemory` because the file's own doc comment names
 * it. A prose-contaminated census is at its most dangerous when it is used to
 * CORRECT someone, because a correction gets less scrutiny than a claim.
 *
 * Line comments are recognised only at the start of a trimmed line, so a `//`
 * inside a URL literal does not truncate the code after it.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

interface ScannedFile {
  path: string;
  code: string;
  raw: string;
}

function scanSource(): ScannedFile[] {
  const files: ScannedFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'drizzle') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      // `readFileSync` is used rather than grep on purpose: a NUL byte makes
      // grep report a present symbol as absent, with exit 1 and no output —
      // indistinguishable from a genuine absence.
      const raw = readFileSync(full, 'utf8');
      files.push({ path: relative(SRC, full), code: stripComments(raw), raw });
    }
  };
  walk(SRC);
  return files;
}

const FILES = scanSource();

/** Files that ARE the model module in question never count as consumers. */
function isOwnModule(path: string, basename: string): boolean {
  return path === join('models', `${basename}.ts`);
}

/**
 * A `vi.mock` of a module NOTHING imports never runs its factory: vitest
 * registers the double against the module graph, and a module the graph never
 * requests is never substituted. So these are stale scaffolding, not consumers
 * — but they are references, and deleting the module would leave them pointing
 * at nothing.
 */
function testDoublesIn(files: ScannedFile[], basename: string): string[] {
  const mocked = new RegExp(`vi\\.mock\\(\\s*['"][^'"]*models/${basename}\\.js['"]`);
  return files.filter((f) => !isOwnModule(f.path, basename) && mocked.test(f.code)).map(
    (f) => f.path,
  );
}

function referencesIn(files: ScannedFile[], basename: string, identifier: string): string[] {
  const staticImport = new RegExp(`from\\s+['"][^'"]*models/${basename}\\.js['"]`);
  const dynamicImport = new RegExp(`import\\(\\s*['"][^'"]*models/${basename}\\.js['"]\\s*\\)`);
  const registryLookup = new RegExp(`mongoose\\.models\\.${identifier}\\b`);
  const bareNameModel = new RegExp(`mongoose\\.model\\(\\s*['"]${identifier}['"]\\s*\\)`);

  return files.filter(
    (f) =>
      !isOwnModule(f.path, basename) &&
      (staticImport.test(f.code) ||
        dynamicImport.test(f.code) ||
        registryLookup.test(f.code) ||
        bareNameModel.test(f.code)),
  ).map((f) => f.path);
}

/**
 * A file as the walk would have produced it, from source text held here.
 *
 * The synthetic control below runs the real regexes, through the real comment
 * stripper, over files that do not exist on disk. That is what makes the
 * control outlive its subject: the previous version proved the spellings still
 * matched by finding `Conversation` and `Message`, and this cutover DELETED
 * both — a positive control that names production code has a shelf life equal
 * to that code's, and this one expired the moment its subject was ported.
 *
 * It shares the failure mode it is controlling for: same expressions, same
 * `stripComments`. It does NOT cover the WALK, which is why the floor asserting
 * `FILES` read the tree stays exactly where it was — the two assertions cover
 * different halves and neither substitutes for the other.
 */
function synthetic(path: string, raw: string): ScannedFile {
  return { path, code: stripComments(raw), raw };
}

describe('AI chat model census', () => {
  /**
   * The floor. "Zero references" and "the walk read nothing" produce identical
   * output, and this is the only assertion that separates them.
   */
  it('read the source tree it claims to have searched', () => {
    expect(FILES.length).toBeGreaterThan(150);
    // Anchors chosen to outlive the port. This assertion named
    // `models/conversation.ts` until the cutover deleted it — and it FAILED,
    // correctly, which is the only reason the walk floor is worth having. The
    // schema and the three models still on disk are what this census is about,
    // so they go last of anything here.
    expect(FILES.map((f) => f.path)).toContain(join('db', 'schema', 'aiChat.ts'));
    expect(FILES.map((f) => f.path)).toContain(join('models', 'agent.ts'));
    expect(FILES.map((f) => f.path)).toContain(join('lib', 'user-context.ts'));
  });

  /**
   * The positive control, in the same currency as the measurement: the dead
   * models are declared absent by the very regexes that find the live models
   * here. If the spellings stopped matching, this fails instead of the absence
   * quietly becoming true.
   */
  /**
   * The positive control, in the same currency as the measurement and with no
   * subject that can be retired out from under it. Every spelling the census
   * claims to detect is exercised against a file written here; each must be
   * found, and a file that only NAMES the identifier in prose must not be.
   */
  describe('positive control — every spelling is still detected', () => {
    const cases: Array<{ shape: string; raw: string }> = [
      { shape: 'static import', raw: `import { Widget } from '../models/widget.js';` },
      { shape: 'static type import', raw: `import type { Widget } from '../models/widget.js';` },
      { shape: 'dynamic import', raw: `const { Widget } = await import('../models/widget.js');` },
      {
        shape: 'dynamic import, .then form',
        raw: `void import('../models/widget.js').then(({ Widget }) => Widget);`,
      },
      { shape: 'registry lookup', raw: `const W = mongoose.models.Widget;` },
      { shape: 'bare name string', raw: `const W = mongoose.model('Widget');` },
    ];

    it.each(cases)('finds a consumer written as a $shape', ({ shape, raw }) => {
      const files = [synthetic(join('lib', 'probe.ts'), raw)];
      expect(referencesIn(files, 'widget', 'Widget'), shape).toEqual([join('lib', 'probe.ts')]);
    });

    it('finds the vi.mock spelling, which the other patterns miss', () => {
      const raw = `vi.mock('../../models/widget.js', () => ({ Widget: {} }));`;
      const files = [synthetic(join('routes', '__tests__', 'probe.test.ts'), raw)];
      expect(testDoublesIn(files, 'widget')).toEqual([
        join('routes', '__tests__', 'probe.test.ts'),
      ]);
      // The discriminating half: `vi.mock` carries no `from` and no `import(`,
      // so a file that ONLY mocks is invisible to `referencesIn`. Without this,
      // the two functions could collapse into one and nothing would notice.
      expect(referencesIn(files, 'widget', 'Widget')).toEqual([]);
    });

    it('does not count a file that only names the model in prose', () => {
      const raw = [
        '/** Widget was removed. mongoose.models.Widget is gone. */',
        `// import { Widget } from '../models/widget.js';`,
        'export const unrelated = 1;',
      ].join('\n');
      const files = [synthetic(join('lib', 'prose.ts'), raw)];
      expect(referencesIn(files, 'widget', 'Widget')).toEqual([]);
      // Vacuity guard on that negative: the stripper must have left the code.
      expect(files[0].code).toContain('export const unrelated');
    });
  });

  /**
   * What this cutover established. `PORTED_MODELS` had six consumers between
   * them — including one reachable ONLY through
   * `(await import('../models/message.js')).Message.exists(...)`, the spelling
   * no static import census sees — and now have none, because the modules are
   * gone.
   */
  describe('the ported models are gone, and nothing reaches them', () => {
    for (const [basename, identifier] of Object.entries(PORTED_MODELS)) {
      it(`${identifier} has no module and no consumer`, () => {
        expect(FILES.map((f) => f.path)).not.toContain(join('models', `${basename}.ts`));
        expect(referencesIn(FILES, basename, identifier)).toEqual([]);
        expect(testDoublesIn(FILES, basename)).toEqual([]);
      });
    }

    /**
     * The replacement is reached, so "no references" is a port rather than a
     * deletion. Without this, ripping the four call sites out entirely would
     * pass every assertion above.
     */
    it('the four rewired files import the repositories instead', () => {
      for (const path of [
        join('routes', 'conversations.ts'),
        join('lib', 'conversation-saver.ts'),
        join('lib', 'chat-lifecycle.ts'),
        join('routes', 'v1', 'chat-completions.ts'),
      ]) {
        const file = FILES.find((f) => f.path === path);
        expect(file, `${path} is missing`).toBeDefined();
        expect(file?.code, `${path} does not reach the chat repositories`).toMatch(
          /repositories\/(conversations|messages)\.js/,
        );
      }
    });
  });

  describe('the three dead models have no consumers', () => {
    for (const [basename, identifier] of Object.entries(DEAD_MODELS)) {
      it(`${identifier} is reached by no file, under any spelling`, () => {
        expect(referencesIn(FILES, basename, identifier)).toEqual([]);
      });
    }

    /**
     * The residual: a file that imports a model and appears to call nothing on
     * it is where a census's miss shows up. Here it is inverted — no file
     * imports these at all, so the residual is the set of files naming the
     * identifier in CODE without importing it. Anything appearing here would
     * be a registry lookup or a stale reference the other patterns missed.
     */
    it('no file names a dead model identifier in code without importing it', () => {
      for (const [basename, identifier] of Object.entries(DEAD_MODELS)) {
        const naming = FILES.filter(
          (f) =>
            !isOwnModule(f.path, basename) &&
            new RegExp(`\\b${identifier}\\s*\\.\\s*[a-zA-Z_]`).test(f.code),
        ).map((f) => f.path);
        expect(naming, `${identifier} named in code outside its own module`).toEqual([]);
      }
    });

    it('no file imports the constants and types co-located with the dead models', () => {
      for (const symbol of CO_LOCATED_EXPORTS) {
        const importers = FILES.filter(
          (f) =>
            !f.path.startsWith(join('models', '')) &&
            // This census names every symbol it looks for, so without this it
            // finds itself and reports each one as a live consumer — a file's
            // own prose about a marker inflating the count it takes.
            f.path !== CENSUS_FILE &&
            new RegExp(`\\b${symbol}\\b`).test(f.code),
        ).map((f) => f.path);
        expect(importers, `${symbol} is used outside models/`).toEqual([]);
      }
    });

    /**
     * The one thing that DOES still name the dead modules, stated exactly
     * rather than excluded by a convenient pattern.
     *
     * Both are `vi.mock` calls in a suite for `routes/v1/chat-completions.ts`,
     * left behind when the Clarity pruning removed the imports they doubled.
     * They are inert: vitest substitutes a module only when something requests
     * it, and the module under test imports neither. The second assertion is
     * what makes that claim checkable — if `chat-completions.ts` ever imports
     * one of them again, these stop being stale scaffolding and this fails.
     */
    it('names the stale test doubles, and shows the module under test imports neither', () => {
      const timeoutSuite = join('routes', 'v1', '__tests__', 'chat-completions-timeout.test.ts');
      expect(testDoublesIn(FILES, 'skill')).toEqual([timeoutSuite]);
      expect(testDoublesIn(FILES, 'user-memory')).toEqual([timeoutSuite]);
      expect(testDoublesIn(FILES, 'agent')).toEqual([]);

      const subject = FILES.find((f) => f.path === join('routes', 'v1', 'chat-completions.ts'));
      expect(subject).toBeDefined();
      expect(subject?.code).not.toMatch(/models\/skill\.js/);
      expect(subject?.code).not.toMatch(/models\/user-memory\.js/);
      // Positive control on that pair of negatives, repointed: it used to name
      // `models/conversation.js`, which the cutover deleted — the same
      // shelf-life problem the synthetic control above exists to avoid. The
      // import that replaced it does the same job, and this one retires only
      // when the title update stops going through the repository.
      expect(subject?.code).toMatch(/repositories\/conversations\.js/);
    });
  });

  /**
   * The comment stripper earns its place on a measured case, not a synthetic
   * one: this exact file made a raw scan report a UserMemory call site that
   * does not exist.
   */
  describe('comment stripping — control on the instrument itself', () => {
    it('removes the prose in user-context.ts that a raw scan reads as a call site', () => {
      const file = FILES.find((f) => f.path === join('lib', 'user-context.ts'));
      expect(file).toBeDefined();

      // The raw text DOES contain the shape a naive census counts.
      expect(file!.raw).toMatch(/UserMemory\s*\./);
      // After stripping, it does not — and the file still has its code.
      expect(file!.code).not.toMatch(/UserMemory/);
      expect(file!.code).toContain('export async function buildUserContext');
    });

    it('does not truncate code at a // inside a string literal', () => {
      expect(stripComments(`const u = 'https://example.invalid/a'; const keep = 1;`)).toContain(
        'keep',
      );
    });
  });

  /**
   * The callers were not merely removed — they were replaced by stubs that say
   * so. These three lines are the affirmative evidence that the absence is
   * deliberate rather than an accident of the scan, and they are asserted so
   * that reviving any of them fails this census instead of silently
   * contradicting the schema file's header.
   */
  describe('the stubs that replaced the callers still say the models are gone', () => {
    it('chat.service.ts records the Skill and Agent removals', () => {
      const service = FILES.find((f) => f.path === join('services', 'chat.service.ts'));
      expect(service?.raw).toContain('Skill loading was removed during Clarity pruning');
      expect(service?.raw).toContain('Agent prompt loading was removed during Clarity pruning');
      expect(service?.code).toContain('export async function loadSkillPrompt');
      expect(service?.code).toContain('return null;');
    });

    it('user-context.ts records the UserMemory removal', () => {
      const ctx = FILES.find((f) => f.path === join('lib', 'user-context.ts'));
      expect(ctx?.raw).toContain('User memory was removed during Clarity pruning');
    });
  });
});
