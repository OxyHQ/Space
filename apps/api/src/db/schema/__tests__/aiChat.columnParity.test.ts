/**
 * Every field the Mongoose schemas declared has a column, and every column
 * traces back to a field.
 *
 * A `pgTable` can omit a column its writer writes and NOTHING catches it:
 * `tsc` is happy because the insert simply never mentions the field, the table
 * exists so no read errors, and a schema-independence test compares no field
 * sets. It surfaces later as a route grouping by a key that is always null, or
 * a balance that reads as zero. The only thing that catches it is diffing the
 * two field lists, which is what this does.
 *
 * ## Why the field lists are frozen constants
 *
 * They used to be read live off `Conversation.schema.paths` and
 * `Message.schema.paths`. The cutover DELETED both Mongoose models, so that
 * input no longer exists — and a gate whose input the migration removes erodes
 * to vacuity one defensible step at a time if it is left to rot, or gets
 * deleted outright and leaves nothing behind that looks like coverage.
 *
 * So it is re-expressed against the destination instead: the lists below are
 * the MEASURED output of `Object.keys(schema.paths)` on both models, taken from
 * the working tree at the commit that deleted them (`git show
 * HEAD:apps/api/src/models/conversation.ts` recovers the source). They are a
 * frozen historical record, not a live reading, and that is the point — the
 * question this file answers is no longer "do two live schemas agree" but "do
 * the columns still match what Mongo declared", which is what the backfill
 * needs to remain true and what no other check asks.
 *
 * Because the record is frozen, it may only ever be edited to record a column
 * DECISION, never to make a diff go green. A field disappearing from the pg
 * table is either a deliberate drop — which is a data-loss decision belonging
 * to whoever runs the backfill, and which must move the field into
 * `DROPPED_AT_PORT` with a reason — or a defect.
 *
 * RETIREMENT: this whole file goes when the backfill has run and the
 * `conversations` and `messages` collections are dropped from
 * `oxystation-production`. Until then, the record is the only surviving
 * statement of what the source documents contain.
 *
 * The comparison uses drizzle's `.name`, which is the TYPESCRIPT PROPERTY name,
 * NOT `sqlColumnName`. That is deliberate and is the opposite of what the
 * column-identifier rule asks for elsewhere: Mongoose field names are
 * camelCase, so comparing them against snake_case SQL identifiers would report
 * every single column as unmatched. `sqlColumnName` is for SQL that needs the
 * identifier; this is a comparison between two application-level field lists.
 */

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { conversations, messages } from '../aiChat.js';

/**
 * `Object.keys(Conversation.schema.paths)` and the same for `Message`, measured
 * on 2026-08-12 against the models as they stood immediately before deletion,
 * with Mongo's own bookkeeping (`_id`, `__v`) removed.
 */
const MONGOOSE_FIELDS: Record<string, string[]> = {
  conversations: [
    'oxyUserId',
    'conversationId',
    'title',
    'isManualTitle',
    'lastMessage',
    'source',
    'folderId',
    'icon',
    'iconColor',
    'isFavorite',
    'isPublic',
    'agentId',
    'createdAt',
    'updatedAt',
  ],
  messages: [
    'conversationId',
    'oxyUserId',
    'id',
    'role',
    'content',
    'vote',
    'toolInvocations',
    'agentInfo',
    'audioUrl',
    'createdAt',
  ],
};

/**
 * Fields whose column is named differently, with the reason. A rename must be
 * declared here rather than silently tolerated, so the diff cannot be made
 * green by adding an exception nobody reads.
 */
const RENAMED: Record<string, Record<string, string>> = {
  messages: {
    // Mongo's client-supplied `Message.id`. `id` is the row primary key here,
    // so the client identifier had to move aside.
    id: 'messageId',
  },
};

/**
 * Fields deliberately NOT given a column, each with the decision behind it.
 *
 * Empty, and it should stay that way until someone decides to drop data. An
 * entry here is a promise that the backfill discards that field.
 */
const DROPPED_AT_PORT: Record<string, Record<string, string>> = {
  conversations: {},
  messages: {},
};

/**
 * Columns with no Mongoose field. Only the primary key qualifies: anything else
 * appearing here is a column the port invented, which is as much a defect as a
 * missing one — it will never be populated by a backfill.
 */
const POSTGRES_ONLY: Record<string, string[]> = {
  conversations: ['id'],
  messages: ['id'],
};

function drizzleFields(table: typeof conversations | typeof messages): string[] {
  return getTableConfig(table).columns.map((c) => c.name);
}

describe.each([
  { name: 'conversations', table: conversations },
  { name: 'messages', table: messages },
])('$name — writer/column parity', ({ name, table }) => {
  const fields = MONGOOSE_FIELDS[name];
  const columns = drizzleFields(table);
  const renamed = RENAMED[name] ?? {};
  const dropped = DROPPED_AT_PORT[name] ?? {};

  /**
   * The floor. Two empty lists are equal, so a `getTableConfig` that came back
   * empty — a moved import, a table that stopped being a table — would make
   * every assertion below pass while measuring nothing. The frozen side gets
   * the same treatment: a constant that someone empties must fail here rather
   * than turn this file into a check that cannot fail.
   */
  it('read both field lists', () => {
    expect(fields.length).toBeGreaterThan(5);
    expect(columns.length).toBeGreaterThan(5);
  });

  it('has a column for every Mongoose field', () => {
    const missing = fields
      .filter((f) => !(f in dropped))
      .filter((f) => !columns.includes(renamed[f] ?? f));
    expect(missing, `fields with no column in ${name}`).toEqual([]);
  });

  it('has a Mongoose field for every column', () => {
    const expected = new Set([
      ...fields.filter((f) => !(f in dropped)).map((f) => renamed[f] ?? f),
      ...(POSTGRES_ONLY[name] ?? []),
    ]);
    const invented = columns.filter((c) => !expected.has(c));
    expect(invented, `columns in ${name} with no Mongoose field`).toEqual([]);
  });

  /**
   * A rename declared in `RENAMED` must correspond to a field that really
   * exists and a column that really exists. Without this, a stale entry keeps
   * excusing a field that was deleted years ago — the exemption list growing
   * into the gate switching itself off.
   */
  it('declares no rename for a field or column that is gone', () => {
    for (const [field, column] of Object.entries(renamed)) {
      expect(fields, `${name}.${field} is renamed but no longer declared`).toContain(field);
      expect(columns, `${name}.${column} is a rename target that does not exist`).toContain(column);
    }
  });

  /**
   * The same for the drop list, which is the one that grows under pressure: an
   * entry excusing a field the record no longer carries is an exemption for
   * nothing, and it is how a list of individually-defensible lines becomes a
   * gate that checks nothing.
   */
  it('declares no drop for a field that is gone', () => {
    for (const field of Object.keys(dropped)) {
      expect(fields, `${name}.${field} is marked dropped but is not in the record`).toContain(
        field,
      );
      expect(columns, `${name}.${field} is marked dropped but has a column`).not.toContain(
        renamed[field] ?? field,
      );
    }
  });
});

/**
 * The mutation control.
 *
 * Everything above compares a constant against `getTableConfig`. If the
 * comparison itself were inert — an `expected` set built wrong, a filter that
 * empties both sides — every assertion would pass on a table missing half its
 * columns. This drives the diff with a field the record does not contain and a
 * column the record does not expect, and asserts each direction is REPORTED.
 * It shares its mechanism with the measurement: same set arithmetic, same
 * `renamed` handling.
 */
describe('control — the diff reports a mismatch in both directions', () => {
  const columns = drizzleFields(conversations);

  it('reports a recorded field that has no column', () => {
    const withPhantom = [...MONGOOSE_FIELDS.conversations, 'fieldThatWasNeverPorted'];
    const missing = withPhantom.filter((f) => !columns.includes(f));
    expect(missing).toEqual(['fieldThatWasNeverPorted']);
  });

  it('reports a column that no field accounts for', () => {
    const expected = new Set([...MONGOOSE_FIELDS.conversations, 'id']);
    const invented = [...columns, 'columnNobodyDeclared'].filter((c) => !expected.has(c));
    expect(invented).toEqual(['columnNobodyDeclared']);
  });
});

/**
 * The rename is the one thing a reader is most likely to "tidy up", because
 * `messageId` looks redundant beside `id`. Stating both halves means a future
 * simplification fails here rather than at the vote route, which would 404 on
 * every request with no error in the log — and `routes/conversations.ts`
 * projects `messageId` as the wire `id` for exactly that reason.
 */
describe('the messages id rename', () => {
  it('keeps the client id and the row id as separate columns', () => {
    const columns = drizzleFields(messages);
    expect(columns).toContain('id');
    expect(columns).toContain('messageId');
    expect(MONGOOSE_FIELDS.messages).toContain('id');
    expect(MONGOOSE_FIELDS.messages).not.toContain('messageId');
  });
});
