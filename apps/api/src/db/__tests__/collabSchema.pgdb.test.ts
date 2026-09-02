/**
 * What the collab DDL ACTUALLY created, read out of the Postgres catalogue.
 *
 * Every assertion here is against `pg_constraint` / `pg_indexes` /
 * `information_schema`, never against the drizzle declaration. A declaration is
 * the input to generation; a column-level self-reference has been silently
 * dropped from both the migration and the snapshot in other Oxy ports, and the
 * declaration reads exactly the same either way.
 *
 * An index is the one thing whose absence no functional test can detect — a
 * sequential scan over a small table returns precisely the right rows — so the
 * index names are asserted here or nowhere.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRows } from '@oxyhq/db';
import { closeTestDb, getTestDb, type TestDatabase, testScope } from './testDatabase.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await getTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

const TABLES = [
  'comments',
  'share_links',
  'notifications',
  'push_tokens',
  'web_push_subscriptions',
] as const;

/**
 * The exact column set of each table.
 *
 * An exact list, not a subset check: a pgTable can OMIT a column its writer
 * writes and every other gate stays green — `tsc` does not object because the
 * insert simply never mentions it, and the table exists so no read errors.
 * Equally, a column added without a writer is dead weight nothing would report.
 */
const EXPECTED_COLUMNS: Record<(typeof TABLES)[number], string[]> = {
  comments: [
    'id',
    'workspace_id',
    'page_id',
    'block_id',
    'parent_comment_id',
    'author_id',
    'content_segments',
    'content_plain_text',
    'resolved_at',
    'edited_at',
    'created_at',
    'updated_at',
  ],
  share_links: [
    'id',
    'page_id',
    'token',
    'scope',
    'created_by',
    'expires_at',
    'revoked_at',
    'created_at',
    'updated_at',
  ],
  notifications: [
    'id',
    'oxy_user_id',
    'type',
    'title',
    'body',
    'data',
    'channels',
    'delivery_status',
    'status',
    'priority',
    'read_at',
    'created_at',
    'updated_at',
    'dismissed_reap_at',
  ],
  push_tokens: [
    'id',
    'oxy_user_id',
    'token',
    'device_id',
    'platform',
    'active',
    'last_used_at',
    'created_at',
    'updated_at',
  ],
  web_push_subscriptions: [
    'id',
    'oxy_user_id',
    'endpoint',
    'key_p_256dh',
    'key_auth',
    'active',
    'created_at',
    'updated_at',
  ],
};

async function columnsOf(table: string): Promise<string[]> {
  const rows = await executeRows<{ column_name: string }>(
    db,
    sql`select column_name from information_schema.columns
        where table_schema = 'public' and table_name = ${table}
        order by column_name`,
  );
  return rows.map((r) => r.column_name);
}

async function indexNamesOf(table: string): Promise<string[]> {
  const rows = await executeRows<{ indexname: string }>(
    db,
    sql`select indexname from pg_indexes where schemaname = 'public' and tablename = ${table}`,
  );
  return rows.map((r) => r.indexname);
}

async function constraintDefs(table: string): Promise<Record<string, string>> {
  const rows = await executeRows<{ conname: string; def: string }>(
    db,
    sql`select con.conname, pg_get_constraintdef(con.oid) as def
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where ns.nspname = 'public' and rel.relname = ${table}`,
  );
  return Object.fromEntries(rows.map((r) => [r.conname, r.def]));
}

describe('collab schema', () => {
  it('every table exists', async () => {
    const rows = await executeRows<{ table_name: string }>(
      db,
      sql`select table_name from information_schema.tables
          where table_schema = 'public' and table_name = any(${sql.param([...TABLES])})`,
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([...TABLES].sort());
  });

  it.each(TABLES)('%s has exactly the expected columns', async (table) => {
    expect(await columnsOf(table)).toEqual([...EXPECTED_COLUMNS[table]].sort());
  });

  describe('foreign keys', () => {
    /**
     * The self-reference, checked against the catalogue because a column-level
     * one can vanish from the generated SQL without a word. Mutation-tested by
     * deleting the `foreignKey(...)` block and re-pushing: the constraint
     * disappears and this fails.
     */
    it('comments.parent_comment_id cascades to comments.id', async () => {
      const defs = await constraintDefs('comments');
      expect(defs.comments_parent_comment_id_fk).toBe(
        'FOREIGN KEY (parent_comment_id) REFERENCES comments(id) ON DELETE CASCADE',
      );
    });

    it('comments.workspace_id cascades to workspaces.id', async () => {
      const defs = await constraintDefs('comments');
      expect(defs.comments_workspace_id_workspaces_id_fk).toBe(
        'FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE',
      );
    });

    /**
     * The page and block references, and their DIFFERENT delete actions.
     *
     * This asymmetry is the single most consequential decision in this schema,
     * so it is asserted on the constraint definition rather than left to the
     * declaration. A hard-deleted page takes its comments (they were
     * unreachable through either list query anyway); a deleted BLOCK must not,
     * because `DELETE /blocks/:id` is an ordinary editing action that leaves
     * the page standing, and the page comment list selects on `page_id` — so a
     * cascade here would silently destroy comment threads every time someone
     * removed a paragraph.
     */
    it('comments.page_id cascades from pages', async () => {
      const defs = await constraintDefs('comments');
      expect(defs.comments_page_id_pages_id_fk).toBe(
        'FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE',
      );
    });

    it('comments.block_id NULLS rather than cascading', async () => {
      const defs = await constraintDefs('comments');
      expect(defs.comments_block_id_blocks_id_fk).toBe(
        'FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE SET NULL',
      );
    });

    it('share_links.page_id cascades from pages', async () => {
      const defs = await constraintDefs('share_links');
      expect(defs.share_links_page_id_pages_id_fk).toBe(
        'FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE',
      );
    });
  });

  describe('indexes', () => {
    it.each([
      ['comments', 'comments_page_resolved_created_idx'],
      ['comments', 'comments_block_resolved_created_idx'],
      ['comments', 'comments_parent_created_idx'],
      ['comments', 'comments_workspace_idx'],
      ['comments', 'comments_author_idx'],
      ['share_links', 'share_links_token_key'],
      ['share_links', 'share_links_page_revoked_created_idx'],
      ['notifications', 'notifications_user_status_created_idx'],
      ['notifications', 'notifications_user_unread_idx'],
      ['notifications', 'notifications_dismissed_reap_idx'],
      ['push_tokens', 'push_tokens_user_token_key'],
      ['push_tokens', 'push_tokens_token_idx'],
      ['web_push_subscriptions', 'web_push_subscriptions_user_endpoint_key'],
    ])('%s carries %s', async (table, index) => {
      expect(await indexNamesOf(table)).toContain(index);
    });

    it('the unread index keeps its partial predicate', async () => {
      const rows = await executeRows<{ indexdef: string }>(
        db,
        sql`select indexdef from pg_indexes
            where schemaname = 'public' and indexname = 'notifications_user_unread_idx'`,
      );
      expect(rows[0]?.indexdef).toContain(
        "WHERE (status = ANY (ARRAY['pending'::text, 'sent'::text]))",
      );
    });

    it('the sweep index keeps its partial predicate', async () => {
      const rows = await executeRows<{ indexdef: string }>(
        db,
        sql`select indexdef from pg_indexes
            where schemaname = 'public' and indexname = 'notifications_dismissed_reap_idx'`,
      );
      expect(rows[0]?.indexdef).toContain('WHERE (dismissed_reap_at IS NOT NULL)');
    });
  });

  describe('dismissed_reap_at', () => {
    /**
     * The generated column IS the TTL predicate. If its expression is ever
     * simplified to a plain `created_at`, the sweep starts deleting read and
     * pending notifications 90 days old and nothing else in this suite would
     * notice — the sweep test's negative control is the other half of this.
     */
    it('is generated from status and created_at', async () => {
      const rows = await executeRows<{ generation_expression: string; is_generated: string }>(
        db,
        sql`select is_generated, generation_expression from information_schema.columns
            where table_schema = 'public' and table_name = 'notifications'
              and column_name = 'dismissed_reap_at'`,
      );
      expect(rows[0]?.is_generated).toBe('ALWAYS');
      const expression = rows[0]?.generation_expression.replace(/\s+/gu, ' ') ?? '';
      expect(expression).toContain("WHEN (status = 'dismissed'::text) THEN created_at");
    });

    it('cannot be written directly', async () => {
      const scope = testScope('gencol');
      await expect(
        executeRows(
          db,
          sql`insert into notifications
                (id, oxy_user_id, type, title, body, status, priority, dismissed_reap_at)
              values (${scope}, ${scope}, 'mention', 't', 'b', 'dismissed', 'normal', now())`,
        ),
      ).rejects.toThrow();
    });
  });

  describe('check constraints', () => {
    it.each([
      ['comments', 'comments_segments_is_array'],
      ['share_links', 'share_links_scope'],
      ['notifications', 'notifications_type'],
      ['notifications', 'notifications_status'],
      ['notifications', 'notifications_priority'],
      ['notifications', 'notifications_channels'],
      ['notifications', 'notifications_delivery_status_is_object'],
      ['push_tokens', 'push_tokens_platform'],
    ])('%s carries %s', async (table, constraint) => {
      expect(Object.keys(await constraintDefs(table))).toContain(constraint);
    });

    /**
     * No CHECK renders a bound parameter. A value interpolated into a
     * `check()` becomes the literal `$1` in generated DDL and fails at APPLY
     * time; here the DDL is already applied, so the failure would instead be a
     * constraint that means something other than it reads.
     */
    it('no check constraint contains a bind placeholder', async () => {
      let checked = 0;
      for (const table of TABLES) {
        for (const [name, def] of Object.entries(await constraintDefs(table))) {
          if (!def.startsWith('CHECK')) continue;
          checked += 1;
          expect(def, `${name} carries a bind placeholder`).not.toMatch(/\$\d/u);
        }
      }
      // Vacuity floor: "no placeholders" is also what reading zero constraints says.
      expect(checked).toBeGreaterThanOrEqual(8);
    });
  });
});
