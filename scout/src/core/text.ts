/**
 * Text helpers shared across slots: news title normalization and the semantic near-duplicate SCORER. Both live
 * in `src/core/` (not in an adapter or the engine) so the news adapters (which fill `NewsPayload.titleNorm`)
 * and the alert budget's dedupe policy (which decides what to fold) compile against ONE implementation and
 * the engine never imports from `adapters/` (layering).
 *
 * Decision D28: "same release rewritten by five outlets = one event": Jaccard similarity over word 3-shingles
 * of the normalized title, plus an exact-URL shortcut. The threshold is policy (`news.dedupe.jaccard_threshold`,
 * default 0.6) and belongs to the caller; this module only scores.
 */
import { urlKey } from './ids.js';

/**
 * Normalize a headline for near-duplicate comparison: Unicode-folded (diacritics removed), lower-cased, `&` ->
 * `and`, a trailing ` - Publisher` / ` | Publisher` suffix dropped once (Google News appends the outlet), all
 * punctuation removed, whitespace collapsed. Pure and deterministic.
 *
 * @example
 * normalizeTitle('Build-A-Bear Raises FY Outlook - Reuters') // 'build a bear raises fy outlook'
 */
export function normalizeTitle(title: string): string {
  let t = title.normalize('NFKD').replace(/\p{M}+/gu, '');
  t = t.replace(/\s+[-–—|]\s+[^-–—|]{2,40}$/u, '');
  return t
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Word shingles of a NORMALIZED title; titles shorter than `size` words yield one shingle (all words). */
export function wordShingles(titleNorm: string, size = 3): Set<string> {
  const words = titleNorm === '' ? [] : titleNorm.split(' ');
  const out = new Set<string>();
  if (words.length === 0) return out;
  if (words.length <= size) {
    out.add(words.join(' '));
    return out;
  }
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(' '));
  return out;
}

/** Jaccard similarity of two sets (0 when both are empty). */
export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** What the scorer compares: a normalized title (see {@link normalizeTitle}) and, optionally, the item URL. */
export interface NearDuplicateInput {
  titleNorm: string;
  url?: string | undefined;
}

/**
 * Near-duplicate score in [0, 1]: 1 when both items carry the same folded URL (`urlKey`), otherwise the Jaccard
 * similarity of word 3-shingles of the normalized titles. Symmetric. The caller compares it to
 * `news.dedupe.jaccard_threshold` and applies the time window.
 */
export type NearDuplicateScorer = (a: NearDuplicateInput, b: NearDuplicateInput) => number;

export const scoreNearDuplicate: NearDuplicateScorer = (a, b) => {
  if (a.url !== undefined && b.url !== undefined && a.url !== '' && b.url !== '') {
    if (urlKey(a.url) === urlKey(b.url)) return 1;
  }
  return jaccard(wordShingles(a.titleNorm), wordShingles(b.titleNorm));
};
