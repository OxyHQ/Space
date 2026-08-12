/**
 * Smoke tests for the Phase 4 (Databases) building blocks. Mirrors the
 * shape of the other Phase smoke tests in this folder — exercises the
 * Zod schemas, the filter evaluator, and the formula evaluator without
 * mounting Express.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateFilter,
  filterGroupSchema,
} from '../../lib/databases/filters.js';
import { compareBySorts } from '../../lib/databases/sorts.js';
import {
  parsePropertyValue,
  serializeParsedValue,
} from '../../lib/databases/property-values.js';
import { evaluateFormulaExpression } from '../../lib/databases/formula.js';
import type { DatabaseProperty } from '../../db/schema/databases.js';

describe('parsePropertyValue', () => {
  it('parses text', () => {
    const parsed = parsePropertyValue('text', { text: 'hi' });
    expect(parsed?.kind).toBe('text');
    expect(serializeParsedValue(parsed!)).toEqual({ text: 'hi' });
  });

  it('parses checkbox', () => {
    const parsed = parsePropertyValue('checkbox', { checked: true });
    expect(serializeParsedValue(parsed!)).toEqual({ checked: true });
  });

  it('parses multi_select', () => {
    const parsed = parsePropertyValue('multi_select', { optionIds: ['a', 'b'] });
    expect(serializeParsedValue(parsed!)).toEqual({ optionIds: ['a', 'b'] });
  });

  it('rejects bad shape', () => {
    expect(() => parsePropertyValue('number', { foo: 1 })).toThrow();
  });

  it('returns null for server-derived types', () => {
    expect(parsePropertyValue('rollup', {})).toBeNull();
    expect(parsePropertyValue('formula', {})).toBeNull();
    expect(parsePropertyValue('created_time', {})).toBeNull();
  });
});

describe('filterGroupSchema', () => {
  it('parses a simple AND group', () => {
    const parsed = filterGroupSchema.parse({
      kind: 'group',
      combinator: 'and',
      filters: [
        { kind: 'condition', propertyId: 'p1', operator: 'is', value: 'x' },
      ],
    });
    expect(parsed.combinator).toBe('and');
    expect(parsed.filters.length).toBe(1);
  });

  it('rejects malformed input', () => {
    expect(() =>
      filterGroupSchema.parse({ kind: 'condition', propertyId: 'p1' }),
    ).toThrow();
  });
});

describe('evaluateFilter', () => {
  const properties: DatabaseProperty[] = [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'priority', name: 'Priority', type: 'select', config: { options: [] } },
    { id: 'done', name: 'Done', type: 'checkbox' },
  ];
  const byId = new Map(properties.map((p) => [p.id, p]));

  const row = (
    title: string,
    priority: string | null,
    done: boolean,
  ): {
    properties: Map<string, unknown>;
    title: string;
    ownerId?: string;
    createdAt?: Date;
    updatedAt?: Date;
  } => ({
    title,
    properties: new Map([
      ['priority', { optionId: priority }],
      ['done', { checked: done }],
    ]),
  });

  it('AND combinator', () => {
    const r = row('Task', 'high', true);
    const pass = evaluateFilter(
      {
        kind: 'group',
        combinator: 'and',
        filters: [
          { kind: 'condition', propertyId: 'done', operator: 'is', value: true },
          {
            kind: 'condition',
            propertyId: 'priority',
            operator: 'is',
            value: 'high',
          },
        ],
      },
      r,
      byId,
    );
    expect(pass).toBe(true);
  });

  it('OR combinator', () => {
    const r = row('Task', 'low', true);
    const pass = evaluateFilter(
      {
        kind: 'group',
        combinator: 'or',
        filters: [
          { kind: 'condition', propertyId: 'priority', operator: 'is', value: 'high' },
          { kind: 'condition', propertyId: 'done', operator: 'is', value: true },
        ],
      },
      r,
      byId,
    );
    expect(pass).toBe(true);
  });

  it('Text contains', () => {
    const r = row('Important task', null, false);
    const pass = evaluateFilter(
      {
        kind: 'group',
        combinator: 'and',
        filters: [
          {
            kind: 'condition',
            propertyId: 'name',
            operator: 'contains',
            value: 'IMP',
          },
        ],
      },
      r,
      byId,
    );
    expect(pass).toBe(true);
  });

  it('Empty group passes', () => {
    const r = row('Anything', null, false);
    const pass = evaluateFilter(
      { kind: 'group', combinator: 'and', filters: [] },
      r,
      byId,
    );
    expect(pass).toBe(true);
  });
});

describe('compareBySorts', () => {
  const properties: DatabaseProperty[] = [
    { id: 'name', name: 'Name', type: 'text' },
    { id: 'priority', name: 'Priority', type: 'number' },
  ];
  const byId = new Map(properties.map((p) => [p.id, p]));

  it('sorts by number ascending', () => {
    const rows = [
      {
        title: 'A',
        properties: new Map([['priority', { number: 3 }]]),
      },
      {
        title: 'B',
        properties: new Map([['priority', { number: 1 }]]),
      },
      {
        title: 'C',
        properties: new Map([['priority', { number: 2 }]]),
      },
    ];
    const compare = compareBySorts(
      [{ propertyId: 'priority', direction: 'asc' }],
      byId,
    );
    rows.sort(compare);
    expect(rows.map((r) => r.title)).toEqual(['B', 'C', 'A']);
  });

  it('sorts by name descending', () => {
    const rows = [
      { title: 'b', properties: new Map() },
      { title: 'a', properties: new Map() },
      { title: 'c', properties: new Map() },
    ];
    const compare = compareBySorts(
      [{ propertyId: 'name', direction: 'desc' }],
      byId,
    );
    rows.sort(compare);
    expect(rows.map((r) => r.title)).toEqual(['c', 'b', 'a']);
  });
});

describe('evaluateFormulaExpression', () => {
  it('handles simple arithmetic', () => {
    expect(evaluateFormulaExpression('=2+2')).toBe(4);
    expect(evaluateFormulaExpression('=2*3')).toBe(6);
    expect(evaluateFormulaExpression('=(1+2)*4')).toBe(12);
    expect(evaluateFormulaExpression('=10 / 4')).toBe(2.5);
  });

  it('handles string literals', () => {
    expect(evaluateFormulaExpression('="hi"')).toBe('hi');
  });

  it('returns null for unsupported input', () => {
    expect(evaluateFormulaExpression('=prop("name")')).toBeNull();
    expect(evaluateFormulaExpression('')).toBeNull();
  });

  it('handles division by zero gracefully', () => {
    expect(evaluateFormulaExpression('=10/0')).toBeNull();
  });
});
