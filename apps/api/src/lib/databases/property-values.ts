import { z } from 'zod';
import type { DatabasePropertyType } from '../../models/database.js';

/**
 * Validates and normalizes a per-property value payload against its
 * declared property type. Each property type owns one shape — values that
 * don't match the shape are rejected at the route boundary.
 *
 * Server-derived types (`rollup`, `formula`, `created_*`, `last_edited_*`)
 * cannot be set by clients — they return `null` here, signalling the
 * caller to skip writing the field.
 */
const textValueSchema = z.object({ text: z.string().max(50_000) });
const numberValueSchema = z.object({ number: z.number().finite().nullable() });
const selectValueSchema = z.object({ optionId: z.string().nullable() });
const multiSelectValueSchema = z.object({ optionIds: z.array(z.string()) });
const statusValueSchema = z.object({ optionId: z.string().nullable() });
const dateValueSchema = z.object({
  start: z.string().datetime().nullable(),
  end: z.string().datetime().nullable().optional(),
  includeTime: z.boolean().optional(),
});
const personValueSchema = z.object({ userIds: z.array(z.string()) });
const filesValueSchema = z.object({
  files: z.array(
    z.object({
      name: z.string(),
      url: z.string().url(),
    }),
  ),
});
const checkboxValueSchema = z.object({ checked: z.boolean() });
const urlValueSchema = z.object({ value: z.string().max(2000) });
const emailValueSchema = z.object({ value: z.string().max(320) });
const phoneValueSchema = z.object({ value: z.string().max(64) });
const relationValueSchema = z.object({
  pageIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/u)),
});

export type ParsedPropertyValue =
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number | null }
  | { kind: 'select'; optionId: string | null }
  | { kind: 'multi_select'; optionIds: string[] }
  | { kind: 'status'; optionId: string | null }
  | {
      kind: 'date';
      start: string | null;
      end: string | null;
      includeTime: boolean;
    }
  | { kind: 'person'; userIds: string[] }
  | { kind: 'files'; files: Array<{ name: string; url: string }> }
  | { kind: 'checkbox'; checked: boolean }
  | { kind: 'url'; value: string }
  | { kind: 'email'; value: string }
  | { kind: 'phone'; value: string }
  | { kind: 'relation'; pageIds: string[] };

/**
 * Parse a single property write. Throws ZodError on shape mismatch.
 * Returns `null` for property types whose values are server-derived and
 * cannot be authored by clients.
 */
export function parsePropertyValue(
  type: DatabasePropertyType,
  raw: unknown,
): ParsedPropertyValue | null {
  switch (type) {
    case 'text': {
      const parsed = textValueSchema.parse(raw);
      return { kind: 'text', text: parsed.text };
    }
    case 'number': {
      const parsed = numberValueSchema.parse(raw);
      return { kind: 'number', number: parsed.number };
    }
    case 'select': {
      const parsed = selectValueSchema.parse(raw);
      return { kind: 'select', optionId: parsed.optionId };
    }
    case 'multi_select': {
      const parsed = multiSelectValueSchema.parse(raw);
      return { kind: 'multi_select', optionIds: parsed.optionIds };
    }
    case 'status': {
      const parsed = statusValueSchema.parse(raw);
      return { kind: 'status', optionId: parsed.optionId };
    }
    case 'date': {
      const parsed = dateValueSchema.parse(raw);
      return {
        kind: 'date',
        start: parsed.start,
        end: parsed.end ?? null,
        includeTime: parsed.includeTime ?? false,
      };
    }
    case 'person': {
      const parsed = personValueSchema.parse(raw);
      return { kind: 'person', userIds: parsed.userIds };
    }
    case 'files': {
      const parsed = filesValueSchema.parse(raw);
      const files = parsed.files.map((f) => ({ name: f.name, url: f.url }));
      return { kind: 'files', files };
    }
    case 'checkbox': {
      const parsed = checkboxValueSchema.parse(raw);
      return { kind: 'checkbox', checked: parsed.checked };
    }
    case 'url': {
      const parsed = urlValueSchema.parse(raw);
      return { kind: 'url', value: parsed.value };
    }
    case 'email': {
      const parsed = emailValueSchema.parse(raw);
      return { kind: 'email', value: parsed.value };
    }
    case 'phone': {
      const parsed = phoneValueSchema.parse(raw);
      return { kind: 'phone', value: parsed.value };
    }
    case 'relation': {
      const parsed = relationValueSchema.parse(raw);
      return { kind: 'relation', pageIds: parsed.pageIds };
    }
    case 'rollup':
    case 'formula':
    case 'created_time':
    case 'last_edited_time':
    case 'created_by':
    case 'last_edited_by':
      return null;
  }
}

/**
 * Convert a parsed property value into the JSON shape stored on the Page.
 * Server-derived types never reach this path — they are computed lazily on
 * read (see `resolveDerivedProperty`).
 */
export function serializeParsedValue(value: ParsedPropertyValue): unknown {
  switch (value.kind) {
    case 'text':
      return { text: value.text };
    case 'number':
      return { number: value.number };
    case 'select':
      return { optionId: value.optionId };
    case 'multi_select':
      return { optionIds: value.optionIds };
    case 'status':
      return { optionId: value.optionId };
    case 'date':
      return {
        start: value.start,
        end: value.end,
        includeTime: value.includeTime,
      };
    case 'person':
      return { userIds: value.userIds };
    case 'files':
      return { files: value.files };
    case 'checkbox':
      return { checked: value.checked };
    case 'url':
    case 'email':
    case 'phone':
      return { value: value.value };
    case 'relation':
      return { pageIds: value.pageIds };
  }
}
