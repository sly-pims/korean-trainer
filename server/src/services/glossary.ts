import { ContentPack } from '../schema/content.js';

/**
 * §8.1 validation rule: every glossary surface must actually occur in the
 * passage text (exact substring). Entries that don't match are dropped rather
 * than failing the whole pack, so a slightly-off LLM output still works.
 */
export function filterGlossaryByPassage(pack: ContentPack): ContentPack {
  const kept = pack.glossary.filter((g) => pack.passage_target.includes(g.surface));
  if (kept.length !== pack.glossary.length) {
    const dropped = pack.glossary.filter((g) => !pack.passage_target.includes(g.surface)).map((g) => g.surface);
    console.warn(`[glossary] dropped ${dropped.length} surfaces not found in passage: ${dropped.join(', ')}`);
  }
  return { ...pack, glossary: kept };
}