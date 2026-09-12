// Patterns used by user-defined facilities.
//
// Callsign patterns (which positions belong to a facility):
//   *        matches any run of characters, including none: DC_*, IAD_*_TWR, *_FSS
//   no *     matches that prefix, or the exact callsign: PCT → PCT_APP, PCT_N_DEP; DCA_GND → DCA_GND
//
// Facility-code patterns (which VATSpy facilities a facility includes):
//   *        wildcard: ZB* covers ZBPE, ZBAA; KZ* covers every US ARTCC
//   no *     exact code: EGPX, KZDC, EGTT-S

export interface CompiledPattern {
  pattern: string;
  re: RegExp;
  /** Number of literal characters; when several patterns match, the most specific wins. */
  specificity: number;
}

export type PatternKind = 'callsign' | 'code';

export const normalizePattern = (p: string) => p.trim().toUpperCase();

/** Callsign characters plus `*`, with at least one literal character. */
export function isValidPattern(p: string): boolean {
  return /^[A-Z0-9_*]+$/.test(p) && /[A-Z0-9]/.test(p);
}

/** A facility code: a VATSpy code (KZDC, EGTT-S) or any custom one (VATPRC, VATSSA). */
export function isValidFacilityCode(code: string): boolean {
  return /^[A-Z0-9][A-Z0-9_-]{0,23}$/.test(code);
}

/** VATSpy facility codes can also contain `-` (EGTT-S, KZNY-BDA). */
export function isValidCodePattern(p: string): boolean {
  return /^[A-Z0-9_*-]+$/.test(p) && /[A-Z0-9]/.test(p);
}

/** Split a comma/space/semicolon separated list, normalising and de-duplicating. */
export function parsePatternList(text: string, kind: PatternKind = 'callsign'): { patterns: string[]; invalid: string[] } {
  const valid = kind === 'code' ? isValidCodePattern : isValidPattern;
  const patterns: string[] = [];
  const invalid: string[] = [];
  for (const token of text.split(/[\s,;]+/).map(normalizePattern).filter(Boolean)) {
    if (!valid(token)) invalid.push(token);
    else if (!patterns.includes(token)) patterns.push(token);
  }
  return { patterns, invalid };
}

// Valid patterns contain no regex-significant characters other than `*` (`-` is literal outside a class).
const specificity = (pattern: string) => pattern.replace(/\*/g, '').length;

export function compilePattern(pattern: string): CompiledPattern {
  const body = pattern.includes('*') ? pattern.split('*').join('.*') : `${pattern}(?:_.*)?`;
  return { pattern, re: new RegExp(`^${body}$`), specificity: specificity(pattern) };
}

export function compileCodePattern(pattern: string): CompiledPattern {
  return { pattern, re: new RegExp(`^${pattern.split('*').join('.*')}$`), specificity: specificity(pattern) };
}
