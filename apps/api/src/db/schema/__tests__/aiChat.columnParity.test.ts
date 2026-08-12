/**
 * Every field the Mongoose schemas declare has a column, and every column
 * traces back to a field.
 *
 * A `pgTable` can omit a column its writer writes and NOTHING catches it:
 * `tsc` is happy because the insert simply never mentions the field, the table
 * exists so no read errors, and a schema-independence test compares no field
 * sets. It surfaces later as a route grouping by a key that is always null, or
 * a balance that reads as zero. The only thing that catches it is diffing the
 * two field lists, which is what this does.
 *
 * The field list comes from `schema.paths` on the real Mongoose models rather
 * than from a parse of their source: a regex over a schema literal is a second
 * implementation of Mongoose's own parser, and it gets nested and shorthand
 * declarations wrong in the permissive direction — reporting a field as absent
 * from the source rather than absent from the table.
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
import { Conversation } from '../../../models/conversation.js';
import { Message } from '../../../models/message.js';
import { conversations, messages } from '../aiChat.js';

/** Mongo bookkeeping with no counterpart: `id` is the uuidv7 primary key. */
const MONGO_INTERNAL = new Set(['_id', '__v']);

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
 * Columns with no Mongoose field. Only the primary key qualifies: anything else
 * appearing here is a column the port invented, which is as much a defect as a
 * missing one — it will never be populated by a backfill.
 */
const POSTGRES_ONLY: Record<string, string[]> = {
  conversations: ['id'],
  messages: ['id'],
};

function mongoFields(schema: { paths: Record<string, unknown> }): string[] {
  return Object.keys(schema.paths).filter((p) => !MONGO_INTERNAL.has(p));
}

function drizzleFields(table: typeof conversations | typeof messages): string[] {
  return getTableConfig(table).columns.map((c) => c.name);
}

describe.each([
  { name: 'conversations', model: Conversation, table: conversations },
  { name: 'messages', model: Message, table: messages },
])('$name — writer/column parity', ({ name, model, table }) => {
  const fields = mongoFields(model.schema);
  const columns = drizzleFields(table);
  const renamed = RENAMED[name] ?? {};

  /**
   * The floor. Two empty lists are equal, so a `schema.paths` that came back
   * empty — a model that failed to compile, a moved import — would make every
   * assertion below pass while measuring nothing.
   */
  it('read both field lists', () => {
    expect(fields.length).toBeGreaterThan(5);
    expect(columns.length).toBeGreaterThan(5);
  });

  it('has a column for every Mongoose field', () => {
    const missing = fields.filter((f) => !columns.includes(renamed[f] ?? f));
    expect(missing, `fields with no column in ${name}`).toEqual([]);
  });

  it('has a Mongoose field for every column', () => {
    const expected = new Set([
      ...fields.map((f) => renamed[f] ?? f),
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
});

/**
 * The rename is the one thing a reader is most likely to "tidy up", because
 * `messageId` looks redundant beside `id`. Stating both halves means a future
 * simplification fails here rather than at the vote route, which would 404 on
 * every request with no error in the log.
 */
describe('the messages id rename', () => {
  it('keeps the client id and the row id as separate columns', () => {
    const columns = drizzleFields(messages);
    expect(columns).toContain('id');
    expect(columns).toContain('messageId');
    expect(mongoFields(Message.schema)).toContain('id');
    expect(mongoFields(Message.schema)).not.toContain('messageId');
  });
});
