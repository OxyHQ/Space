/**
 * Formula evaluation — MVP scope.
 *
 * Only constant arithmetic expressions are evaluated in this pass — e.g.
 * `=2+2` or `=10*1.2`. Full reference / function evaluation is Phase 4.5.
 *
 * The grammar accepted here:
 *   expr   = term (("+"|"-") term)*
 *   term   = factor (("*"|"/") factor)*
 *   factor = ("+"|"-")? primary
 *   primary = NUMBER | "(" expr ")"
 *
 * Anything else (a property reference, a function call, etc.) returns
 * `null` — the frontend renders this as a soft "—" placeholder.
 */

export function evaluateFormulaExpression(expression: string): number | string | null {
  const expr = (expression ?? '').trim().replace(/^=/, '').trim();
  if (!expr) return null;

  // String literal shortcut: ="hello"
  const stringLiteral = expr.match(/^"([^"]*)"$/u);
  if (stringLiteral) return stringLiteral[1];

  try {
    const parser = new Parser(expr);
    const value = parser.parseExpression();
    parser.expectEnd();
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return value;
  } catch {
    return null;
  }
}

class Parser {
  private pos = 0;
  constructor(private readonly source: string) {}

  parseExpression(): number {
    let value = this.parseTerm();
    while (true) {
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === '+') {
        this.pos += 1;
        value += this.parseTerm();
      } else if (ch === '-') {
        this.pos += 1;
        value -= this.parseTerm();
      } else {
        break;
      }
    }
    return value;
  }

  private parseTerm(): number {
    let value = this.parseFactor();
    while (true) {
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === '*') {
        this.pos += 1;
        value *= this.parseFactor();
      } else if (ch === '/') {
        this.pos += 1;
        const divisor = this.parseFactor();
        if (divisor === 0) {
          throw new Error('Division by zero');
        }
        value /= divisor;
      } else {
        break;
      }
    }
    return value;
  }

  private parseFactor(): number {
    this.skipWhitespace();
    const ch = this.peek();
    if (ch === '+') {
      this.pos += 1;
      return this.parseFactor();
    }
    if (ch === '-') {
      this.pos += 1;
      return -this.parseFactor();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    this.skipWhitespace();
    const ch = this.peek();
    if (ch === '(') {
      this.pos += 1;
      const value = this.parseExpression();
      this.skipWhitespace();
      if (this.peek() !== ')') {
        throw new Error('Expected ")"');
      }
      this.pos += 1;
      return value;
    }
    return this.parseNumber();
  }

  private parseNumber(): number {
    this.skipWhitespace();
    const start = this.pos;
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos];
      if ((ch >= '0' && ch <= '9') || ch === '.') {
        this.pos += 1;
        continue;
      }
      break;
    }
    if (this.pos === start) {
      throw new Error('Expected number');
    }
    const slice = this.source.slice(start, this.pos);
    const value = Number(slice);
    if (!Number.isFinite(value)) {
      throw new Error('Invalid number');
    }
    return value;
  }

  expectEnd(): void {
    this.skipWhitespace();
    if (this.pos < this.source.length) {
      throw new Error('Unexpected trailing input');
    }
  }

  private peek(): string {
    return this.source[this.pos] ?? '';
  }

  private skipWhitespace(): void {
    while (this.pos < this.source.length && /\s/.test(this.source[this.pos] ?? '')) {
      this.pos += 1;
    }
  }
}
