// src/modules/merchant-rules/categorizer.ts
// Pure matching logic for merchant rules: used by the import pipeline and unit-tested in isolation.

export interface RuleLike {
  pattern: string;
  categoryId: string;
  normalizedName: string | null;
}

export interface CategorizationResult {
  categoryId: string;
  merchantName: string | null;
}

/**
 * Returns the first matching rule's outcome. `rules` must already be ordered by priority (high first).
 * Matching is a case-insensitive substring test on purpose: rules are user-supplied, and a regex
 * engine would expose the API to catastrophic-backtracking (ReDoS) input.
 */
export function categorize(description: string, rules: readonly RuleLike[]): CategorizationResult | null {
  const haystack = description.toLowerCase();
  for (const rule of rules) {
    const needle = rule.pattern.trim().toLowerCase();
    if (needle && haystack.includes(needle)) {
      return { categoryId: rule.categoryId, merchantName: rule.normalizedName };
    }
  }
  return null;
}
