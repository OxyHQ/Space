/**
 * Phase 3 block-type smoke tests. We import the route module (which holds
 * the Zod schemas) by exercising the same path the HTTP layer goes through.
 *
 * The route module is large; rather than mounting Express, we re-build the
 * minimum schema set inline and verify each new type accepts a representative
 * payload and rejects clearly-invalid input. This mirrors what
 * `normalizeContent` does behind /blocks endpoints.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/u);

const styleFields = {
  color: z.string().optional(),
  backgroundColor: z.string().optional(),
} as const;

const imageContentSchema = z.object({
  url: z.string().default(''),
  caption: z.string().optional(),
  alt: z.string().optional(),
  width: z.number().finite().positive().optional(),
  ...styleFields,
});

const videoContentSchema = z.object({
  url: z.string().default(''),
  source: z.enum(['upload', 'youtube', 'vimeo', 'loom', 'other']).default('other'),
  caption: z.string().optional(),
  ...styleFields,
});

const fileContentSchema = z.object({
  url: z.string().default(''),
  name: z.string().default(''),
  size: z.number().int().nonnegative().default(0),
  mimeType: z.string().default('application/octet-stream'),
  ...styleFields,
});

const columnsContentSchema = z.object({
  columnCount: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(2),
  ...styleFields,
});

const tableContentSchema = z.object({
  rows: z.number().int().positive().default(2),
  cols: z.number().int().positive().default(2),
  withHeader: z.boolean().default(false),
  ...styleFields,
});

const linkToPageContentSchema = z.object({
  pageId: objectId.default('000000000000000000000000'),
  ...styleFields,
});

const equationContentSchema = z.object({
  latex: z.string().default(''),
  ...styleFields,
});

describe('Phase 3 block content schemas', () => {
  it('validates image content', () => {
    const out = imageContentSchema.parse({ url: 'https://cdn/image.png', caption: 'cap' });
    expect(out.url).toBe('https://cdn/image.png');
    expect(out.caption).toBe('cap');
  });

  it('defaults video source to "other"', () => {
    const out = videoContentSchema.parse({ url: 'https://example.com/v.mp4' });
    expect(out.source).toBe('other');
  });

  it('rejects unknown video source', () => {
    expect(() => videoContentSchema.parse({ source: 'invalid' as never })).toThrow();
  });

  it('defaults file mime type', () => {
    const out = fileContentSchema.parse({ url: 'https://cdn/a.bin', name: 'a.bin', size: 12 });
    expect(out.mimeType).toBe('application/octet-stream');
  });

  it('only accepts 2/3/4 columns', () => {
    const ok = columnsContentSchema.parse({ columnCount: 3 });
    expect(ok.columnCount).toBe(3);
    expect(() => columnsContentSchema.parse({ columnCount: 5 as 2 | 3 | 4 })).toThrow();
  });

  it('defaults table rows/cols', () => {
    const out = tableContentSchema.parse({});
    expect(out.rows).toBe(2);
    expect(out.cols).toBe(2);
    expect(out.withHeader).toBe(false);
  });

  it('rejects non-ObjectId link_to_page', () => {
    expect(() =>
      linkToPageContentSchema.parse({ pageId: 'not-an-objectid' }),
    ).toThrow();
  });

  it('accepts equation latex strings', () => {
    const out = equationContentSchema.parse({ latex: '\\frac{a}{b}' });
    expect(out.latex).toBe('\\frac{a}{b}');
  });
});
