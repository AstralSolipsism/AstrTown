export type SubscriptionMatcher = {
  subscribed: string[];
  matches: (eventType: string) => boolean;
};

export function createSubscriptionMatcher(subscribed: string[]): SubscriptionMatcher {
  const normalized = subscribed.length === 0 ? ['*'] : subscribed;
  const patterns = normalized.map((s) => s.trim()).filter(Boolean);

  function matches(eventType: string): boolean {
    if (patterns.includes('*')) return true;
    for (const p of patterns) {
      if (p === eventType) return true;
      if (p.endsWith('.*')) {
        const prefix = p.slice(0, -2);
        if (eventType.startsWith(prefix + '.')) return true;
      }
    }
    return false;
  }

  return { subscribed: patterns, matches };
}
