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

/** Model modules this domain owns, by file basename and exported identifier. */
const LIVE_MODELS = { conversation: 'Conversation', message: 'Message' } as const;
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
function testDoublesFor(basename: string): string[] {
  const mocked = new RegExp(`vi\\.mock\\(\\s*['"][^'"]*models/${basename}\\.js['"]`);
  return FILES.filter((f) => !isOwnModule(f.path, basename) && mocked.test(f.code)).map(
    (f) => f.path,
  );
}

function referencesFor(basename: string, identifier: string): string[] {
  const staticImport = new RegExp(`from\\s+['"][^'"]*models/${basename}\\.js['"]`);
  const dynamicImport = new RegExp(`import\\(\\s*['"][^'"]*models/${basename}\\.js['"]\\s*\\)`);
  const registryLookup = new RegExp(`mongoose\\.models\\.${identifier}\\b`);
  const bareNameModel = new RegExp(`mongoose\\.model\\(\\s*['"]${identifier}['"]\\s*\\)`);

  return FILES.filter(
    (f) =>
      !isOwnModule(f.path, basename) &&
      (staticImport.test(f.code) ||
        dynamicImport.test(f.code) ||
        registryLookup.test(f.code) ||
        bareNameModel.test(f.code)),
  ).map((f) => f.path);
}

describe('AI chat model census', () => {
  /**
   * The floor. "Zero references" and "the walk read nothing" produce identical
   * output, and this is the only assertion that separates them.
   */
  it('read the source tree it claims to have searched', () => {
    expect(FILES.length).toBeGreaterThan(150);
    expect(FILES.map((f) => f.path)).toContain(join('models', 'conversation.ts'));
    expect(FILES.map((f) => f.path)).toContain(join('lib', 'user-context.ts'));
  });

  /**
   * The positive control, in the same currency as the measurement: the dead
   * models are declared absent by the very regexes that find the live models
   * here. If the spellings stopped matching, this fails instead of the absence
   * quietly becoming true.
   */
  describe('positive control — the live models are found', () => {
    it('finds every consumer of Conversation, including none that are missing', () => {
      expect(referencesFor('conversation', LIVE_MODELS.conversation).sort()).toEqual([
        // Not a runtime consumer: the parity test imports the model to read
        // `schema.paths` off it. It is listed rather than filtered out, because
        // an exemption for "test files" would also hide a real one.
        join('db', 'schema', '__tests__', 'aiChat.columnParity.test.ts'),
        join('lib', 'chat-lifecycle.ts'),
        join('lib', 'conversation-saver.ts'),
        join('routes', '__tests__', 'conversations.test.ts'),
        join('routes', 'conversations.ts'),
        join('routes', 'v1', 'chat-completions.ts'),
      ]);
    });

    it('finds the vi.mock spelling, which the other four patterns miss', () => {
      // Derived, not recalled: the first version of this census listed
      // chat-completions-timeout.test.ts as a Conversation consumer from
      // memory of a grep, and the measurement disagreed — `vi.mock` carries no
      // `from` and no `import(`, so none of the first four patterns see it.
      expect(testDoublesFor('conversation').sort()).toEqual([
        join('routes', '__tests__', 'conversations.test.ts'),
        join('routes', 'v1', '__tests__', 'chat-completions-timeout.test.ts'),
      ]);
      // The discriminating case: this suite mocks the module and does NOT
      // import it, so it is a reference the other four patterns cannot see.
      // (`conversations.test.ts` does both, which is why it appears in each
      // list and proves nothing on its own.)
      expect(referencesFor('conversation', LIVE_MODELS.conversation)).not.toContain(
        join('routes', 'v1', '__tests__', 'chat-completions-timeout.test.ts'),
      );
    });

    it('finds the dynamic import spelling, not just the static one', () => {
      // lib/chat-lifecycle.ts reaches Message ONLY through
      // `(await import('../models/message.js')).Message.exists(...)` — it has
      // no static import of it. If the dynamic pattern broke, this file would
      // drop out and the census would under-report by exactly the shape that
      // is hardest to find.
      const lifecycle = FILES.find((f) => f.path === join('lib', 'chat-lifecycle.ts'));
      expect(lifecycle?.code).toMatch(/import\(\s*'\.\.\/models\/message\.js'\s*\)/);
      expect(referencesFor('message', LIVE_MODELS.message)).toContain(
        join('lib', 'chat-lifecycle.ts'),
      );
    });
  });

  describe('the three dead models have no consumers', () => {
    for (const [basename, identifier] of Object.entries(DEAD_MODELS)) {
      it(`${identifier} is reached by no file, under any spelling`, () => {
        expect(referencesFor(basename, identifier)).toEqual([]);
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
      expect(testDoublesFor('skill')).toEqual([timeoutSuite]);
      expect(testDoublesFor('user-memory')).toEqual([timeoutSuite]);
      expect(testDoublesFor('agent')).toEqual([]);

      const subject = FILES.find((f) => f.path === join('routes', 'v1', 'chat-completions.ts'));
      expect(subject).toBeDefined();
      expect(subject!.code).not.toMatch(/models\/skill\.js/);
      expect(subject!.code).not.toMatch(/models\/user-memory\.js/);
      // Positive control on that pair of negatives: the same file DOES import
      // the one model it really uses, so "no match" is not "read nothing".
      expect(subject!.code).toMatch(/models\/conversation\.js/);
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
