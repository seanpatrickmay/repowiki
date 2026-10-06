/** Words too common to tell pages apart. */
const STOP_WORDS = new Set(
  "a an and are as at be by do does for from has how in is it its of on or that the this to was what when where which who why with".split(
    " ",
  ),
);

/**
 * Search terms: camelCase and snake_case split into words, accents stripped, lowercase, one- and
 * stop-words dropped, and a plural "s" (or "ies") cut, so "Signals" finds "signal".
 */
export function terms(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map((word) =>
      word.endsWith("ies") && word.length > 4
        ? `${word.slice(0, -3)}y`
        : word.endsWith("s") && !word.endsWith("ss") && word.length > 3
          ? word.slice(0, -1)
          : word,
    );
}

/** A searchable document: its id and the text of each weighted field. */
export interface SearchDoc<F extends string = SearchField> {
  id: string;
  fields: Readonly<Record<F, string>>;
}

export type SearchField = "title" | "aliases" | "lead" | "body";

/** How much a match in each field counts: a title match beats a mention in the body. */
const BOOST: Readonly<Record<SearchField, number>> = { title: 3, aliases: 2, lead: 1.5, body: 1 };
const K1 = 1.2;
const B = 0.75;

export interface SearchIndex {
  /** Ids of the best matches for `query`, best first, ties by id; at most `limit`. */
  search(query: string, limit: number): string[];
}

/**
 * BM25F over the documents' fields: a small, deterministic ranking with no dependency. `boost`
 * names the fields and how much a match in each counts; only the page search's own documents may
 * leave it out, for the page search's.
 */
export function searchIndex(docs: readonly SearchDoc<SearchField>[]): SearchIndex;
export function searchIndex<F extends string>(
  docs: readonly SearchDoc<F>[],
  boost: Readonly<Record<F, number>>,
): SearchIndex;
export function searchIndex<F extends string>(
  docs: readonly SearchDoc<F>[],
  given?: Readonly<Record<F, number>>,
): SearchIndex {
  // Only the first overload omits the boost, and its fields are the page search's own.
  const boost = given ?? (BOOST as Readonly<Record<string, number>> as Readonly<Record<F, number>>);
  const fields = Object.keys(boost) as F[];
  const counted = docs.map((doc) => {
    const tf = new Map<string, Map<F, number>>();
    const lengths = {} as Record<F, number>;
    for (const field of fields) {
      const words = terms(doc.fields[field]);
      lengths[field] = words.length;
      for (const word of words) {
        const byField = tf.get(word) ?? new Map<F, number>();
        byField.set(field, (byField.get(field) ?? 0) + 1);
        tf.set(word, byField);
      }
    }
    return { id: doc.id, tf, lengths };
  });
  const average = Object.fromEntries(
    fields.map((f) => [f, counted.reduce((n, d) => n + d.lengths[f], 0) / (counted.length || 1)]),
  ) as Record<F, number>;
  const df = new Map<string, number>();
  for (const doc of counted)
    for (const word of doc.tf.keys()) df.set(word, (df.get(word) ?? 0) + 1);
  const n = counted.length;
  return {
    search(query, limit) {
      const words = [...new Set(terms(query))];
      const scored = counted.flatMap((doc) => {
        let score = 0;
        for (const word of words) {
          const byField = doc.tf.get(word);
          if (byField === undefined) continue;
          let weighted = 0;
          for (const [field, count] of byField) {
            const norm = 1 - B + B * (doc.lengths[field] / (average[field] || 1));
            weighted += (boost[field] * count) / norm;
          }
          const d = df.get(word) ?? 0;
          const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
          score += (idf * (weighted * (K1 + 1))) / (weighted + K1);
        }
        return score > 0 ? [{ id: doc.id, score }] : [];
      });
      scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return scored.slice(0, Math.max(0, Math.trunc(limit))).map((s) => s.id);
    },
  };
}
