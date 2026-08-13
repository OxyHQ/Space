/**
 * Block content normalization — the per-type shapes `POST /api/pages/:pageId/blocks`
 * and `PATCH /api/blocks/:id` persist.
 *
 * These assertions used to run against a hand-written COPY of the Zod schemas,
 * rebuilt inline in this file because "the route module is large". That made
 * them a test of the copy: when the route moved off 24-hex ObjectIds and onto
 * `isLiveEntityId`, the copy kept its old regex and kept passing, asserting a
 * contract the shipped code no longer had. They now call the real
 * `normalizeContent`.
 */
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@oxyhq/db';
import { normalizeContent } from '../blocks.js';

describe('block content normalization', () => {
  it('validates image content', () => {
    const out = normalizeContent('image', {
      url: 'https://cdn/image.png',
      caption: 'cap',
    });
    expect(out.url).toBe('https://cdn/image.png');
    expect(out.caption).toBe('cap');
  });

  it('defaults video source to "other"', () => {
    const out = normalizeContent('video', { url: 'https://example.com/v.mp4' });
    expect(out.source).toBe('other');
  });

  it('rejects unknown video source', () => {
    expect(() => normalizeContent('video', { source: 'invalid' })).toThrow();
  });

  it('defaults file mime type', () => {
    const out = normalizeContent('file', {
      url: 'https://cdn/a.bin',
      name: 'a.bin',
      size: 12,
    });
    expect(out.mimeType).toBe('application/octet-stream');
  });

  it('only accepts 2/3/4 columns', () => {
    expect(normalizeContent('columns', { columnCount: 3 }).columnCount).toBe(3);
    expect(() => normalizeContent('columns', { columnCount: 5 })).toThrow();
  });

  it('defaults table rows/cols', () => {
    const out = normalizeContent('table', {});
    expect(out.rows).toBe(2);
    expect(out.cols).toBe(2);
    expect(out.withHeader).toBe(false);
  });

  it('accepts equation latex strings', () => {
    const out = normalizeContent('equation', { latex: '\\frac{a}{b}' });
    expect(out.latex).toBe('\\frac{a}{b}');
  });

  /**
   * The id contract, which is the reason this file stopped re-implementing the
   * schemas. `link_to_page` and `inline_database` carry an id of another row,
   * and `pages.id` is a uuid v7 now — so a 24-hex-only validator rejects every
   * link the editor can currently create. Reverting `entityIdSchema` to the old
   * regex fails the first of these three and nothing else in the suite.
   */
  describe('target ids', () => {
    it('accepts a uuid v7 page id on link_to_page', () => {
      const id = uuidv7();
      expect(normalizeContent('link_to_page', { pageId: id }).pageId).toBe(id);
    });

    it('accepts a 24-hex ObjectId, which a backfilled row still carries', () => {
      const id = '507f1f77bcf86cd799439011';
      expect(normalizeContent('link_to_page', { pageId: id }).pageId).toBe(id);
    });

    it('rejects an id of neither shape', () => {
      expect(() =>
        normalizeContent('link_to_page', { pageId: 'not-an-id' }),
      ).toThrow();
    });

    it('defaults an unpicked target to a sentinel that names no row', () => {
      // The UI replaces this the moment a target is chosen; it exists so the
      // type-changed-to-link_to_page path does not fail validation.
      expect(normalizeContent('link_to_page', {}).pageId).toBe(
        '000000000000000000000000',
      );
      expect(normalizeContent('inline_database', {}).databaseId).toBe(
        '000000000000000000000000',
      );
    });
  });
});
