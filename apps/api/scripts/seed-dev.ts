#!/usr/bin/env bun
/**
 * Seed a local development database with something worth looking at.
 *
 * DEVELOPMENT ONLY. It refuses to run unless `DATABASE_URL` names a database
 * whose name ends in `_dev`, because the whole point of a seed is that it
 * writes rows nobody asked for — and the one thing worse than an empty demo is
 * a demo that landed in a database somebody was using.
 *
 * Everything goes through the repositories rather than raw SQL, so seeding
 * exercises the same code path the API does. A seed that inserted straight
 * into the tables could succeed against a schema the application cannot
 * actually read.
 */

import { closeDb, getDb } from '../src/db/client.js';
import { createBlock } from '../src/repositories/blocks.js';
import { createComment } from '../src/repositories/comments.js';
import { insertDatabase, insertDatabaseView } from '../src/repositories/databases.js';
import { createPage } from '../src/repositories/pages.js';
import {
  addMemberIfAbsent,
  createPersonalWorkspaceIfAbsent,
  createWorkspace,
} from '../src/repositories/workspaces.js';

/** The Oxy account this seed hands ownership to. */
const OWNER_ID = process.env.SEED_OWNER_ID;

function requireDevDatabase(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required.');
  const name = url.split('/').pop()?.split('?')[0] ?? '';
  if (!name.endsWith('_dev')) {
    throw new Error(
      `Refusing to seed "${name}": this script writes rows nobody asked for, so it only ` +
        'runs against a database whose name ends in _dev.',
    );
  }
  return name;
}

async function main(): Promise<void> {
  const database = requireDevDatabase();
  if (!OWNER_ID) {
    throw new Error('SEED_OWNER_ID is required — the Oxy user id that will own the seeded rows.');
  }

  const db = getDb();
  console.log(`Seeding ${database} for owner ${OWNER_ID}`);

  // The personal workspace uses the same idempotent path the auth middleware
  // does, so running this twice does not create a second one.
  const personal =
    (await createPersonalWorkspaceIfAbsent(db, { name: "Nate's Workspace", ownerId: OWNER_ID })) ??
    null;
  if (personal) {
    await addMemberIfAbsent(db, {
      workspaceId: personal.id,
      userId: OWNER_ID,
      role: 'owner',
      invitedBy: null,
    });
    console.log(`  personal workspace ${personal.id}`);
  } else {
    console.log('  personal workspace already existed — left alone');
  }

  const team = await createWorkspace(db, {
    name: 'Oxy Station Demo',
    icon: '🛰️',
    ownerId: OWNER_ID,
    isPersonal: false,
  });
  await addMemberIfAbsent(db, {
    workspaceId: team.id,
    userId: OWNER_ID,
    role: 'owner',
    invitedBy: null,
  });
  console.log(`  team workspace ${team.id}`);

  const workspaceId = team.id;

  // ── A document with real block variety ────────────────────────────────────
  const welcome = await createPage(db, {
    workspaceId,
    ownerId: OWNER_ID,
    title: 'Welcome to Oxy Station',
    icon: '👋',
    order: 0,
  });

  const blocks: { type: string; content: Record<string, unknown> }[] = [
    { type: 'heading_1', content: { text: 'Welcome to Oxy Station' } },
    {
      type: 'paragraph',
      content: {
        text: 'This workspace was seeded locally. Everything you see is served from PostgreSQL.',
      },
    },
    { type: 'heading_2', content: { text: 'What works' } },
    { type: 'bulleted_list_item', content: { text: 'Pages, sub-pages and the sidebar tree' } },
    { type: 'bulleted_list_item', content: { text: 'Blocks: headings, lists, todos, code, quotes' } },
    { type: 'bulleted_list_item', content: { text: 'Databases with typed properties and views' } },
    { type: 'bulleted_list_item', content: { text: 'Comments, including threads and mentions' } },
    { type: 'todo', content: { text: 'Open a page and edit a block', checked: true } },
    { type: 'todo', content: { text: 'Add a row to the Tasks database', checked: false } },
    { type: 'todo', content: { text: 'Resolve a comment thread', checked: false } },
    { type: 'heading_2', content: { text: 'Under the hood' } },
    {
      type: 'code',
      content: {
        text: 'select count(*) from pages;\nselect count(*) from blocks;',
        language: 'sql',
      },
    },
    {
      type: 'quote',
      content: { text: 'No Mongoose anywhere: the API reads and writes PostgreSQL only.' },
    },
    { type: 'divider', content: {} },
  ];

  let order = 0;
  for (const block of blocks) {
    await createBlock(db, {
      pageId: welcome.id,
      type: block.type as never,
      content: block.content as never,
      order: order += 1000,
    });
  }
  console.log(`  page "${welcome.title}" with ${blocks.length} blocks`);

  // ── A sub-page, so the tree has depth ─────────────────────────────────────
  const child = await createPage(db, {
    workspaceId,
    ownerId: OWNER_ID,
    parentId: welcome.id,
    title: 'Release notes',
    icon: '📝',
    order: 0,
  });
  await createBlock(db, {
    pageId: child.id,
    type: 'paragraph' as never,
    content: { text: 'The API moved from MongoDB to PostgreSQL. Nothing reads Mongo any more.' } as never,
    order: 1000,
  });
  console.log(`  sub-page "${child.title}"`);

  // ── A database with typed properties, rows and a view ─────────────────────
  const tasks = await insertDatabase(db, {
    workspaceId,
    name: 'Tasks',
    icon: '✅',
    cover: null,
    ownerId: OWNER_ID,
    isInline: false,
    parentPageId: null,
    archived: false,
    propertiesSchema: {
      properties: [
        { id: 'name', name: 'Task', type: 'text' },
        {
          id: 'status',
          name: 'Status',
          type: 'select',
          options: [
            { id: 'todo', name: 'To do', color: 'gray' },
            { id: 'doing', name: 'In progress', color: 'blue' },
            { id: 'done', name: 'Done', color: 'green' },
          ],
        },
        { id: 'done', name: 'Complete', type: 'checkbox' },
      ],
    } as never,
  });

  await insertDatabaseView(db, {
    databaseId: tasks.id,
    name: 'All tasks',
    type: 'table',
    isDefault: true,
    filters: { operator: 'and', conditions: [] } as never,
    sorts: [],
    groupBy: null,
    hiddenProperties: [],
    frozenProperties: [],
    pageSize: 50,
    config: {} as never,
    order: 0,
  });

  const rows = [
    { title: 'Ship the PostgreSQL migration', status: 'done', done: true },
    { title: 'Seed a demo workspace', status: 'done', done: true },
    { title: 'Try the block editor', status: 'doing', done: false },
    { title: 'Invite a teammate', status: 'todo', done: false },
  ];
  let rowOrder = 0;
  for (const row of rows) {
    await createPage(db, {
      workspaceId,
      ownerId: OWNER_ID,
      databaseId: tasks.id,
      title: row.title,
      order: rowOrder += 1000,
      properties: {
        name: { text: row.title },
        status: { select: row.status },
        done: { checked: row.done },
      } as never,
    });
  }
  console.log(`  database "${tasks.name}" with ${rows.length} rows`);

  // ── A comment thread ──────────────────────────────────────────────────────
  const root = await createComment(db, {
    workspaceId,
    pageId: welcome.id,
    blockId: null,
    parentCommentId: null,
    authorId: OWNER_ID,
    content: {
      segments: [{ type: 'text', text: 'Seeded thread — try resolving this.' }],
      plainText: 'Seeded thread — try resolving this.',
    } as never,
  });
  await createComment(db, {
    workspaceId,
    pageId: welcome.id,
    blockId: null,
    parentCommentId: root.id,
    authorId: OWNER_ID,
    content: {
      segments: [{ type: 'text', text: 'And this is a reply on the same thread.' }],
      plainText: 'And this is a reply on the same thread.',
    } as never,
  });
  console.log('  comment thread with one reply');

  console.log('\nSeed complete.');
}

main().then(
  async () => {
    await closeDb();
    process.exit(0);
  },
  async (error: unknown) => {
    console.error(error);
    await closeDb();
    process.exit(1);
  },
);
