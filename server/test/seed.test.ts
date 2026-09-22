import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContentPackSchema } from '../src/schema/content.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const seedPath = path.resolve(here, '..', '..', 'seed', 'passages.json');

function loadSeeds(): unknown[] {
  return JSON.parse(fs.readFileSync(seedPath, 'utf8'));
}

describe('seed bank validation (§9)', () => {
  const seeds = loadSeeds();

  it('has at least 5 passages per level for levels 1-3', () => {
    const counts: Record<number, number> = {};
    for (const raw of seeds) {
      const pack = ContentPackSchema.safeParse(raw);
      if (!pack.success) continue;
      counts[pack.data.level] = (counts[pack.data.level] ?? 0) + 1;
    }
    for (const level of [1, 2, 3]) {
      expect(counts[level] ?? 0).toBeGreaterThanOrEqual(5);
    }
  });

  it('every seed entry validates against the §8.1 schema', () => {
    for (const raw of seeds) {
      const parsed = ContentPackSchema.safeParse(raw);
      expect(parsed.success, parsed.success ? undefined : parsed.error.message).toBe(true);
      if (parsed.success) {
        const pack = parsed.data;
        expect(pack.questions).toHaveLength(3);
        for (const q of pack.questions) {
          expect(q.choices).toHaveLength(4);
          expect(q.answer_index).toBeGreaterThanOrEqual(0);
          expect(q.answer_index).toBeLessThan(4);
        }
        expect(pack.glossary.length).toBeGreaterThan(0);
        expect(pack.sentences.length).toBeGreaterThanOrEqual(3);
        expect(pack.sentences.length).toBeLessThanOrEqual(5);
      }
    }
  });

  it('every glossary surface appears in the passage (§8.1)', () => {
    let failures = 0;
    for (const raw of seeds) {
      const parsed = ContentPackSchema.safeParse(raw);
      if (!parsed.success) continue;
      const pack = parsed.data;
      for (const g of pack.glossary) {
        if (!pack.passage_ko.includes(g.surface)) {
          failures++;
          console.warn(`surface not in passage: "${g.surface}" in "${pack.title_ko}"`);
        }
      }
    }
    expect(failures).toBe(0);
  });

  it('dictation sentences appear verbatim in the passage', () => {
    let failures = 0;
    for (const raw of seeds) {
      const parsed = ContentPackSchema.safeParse(raw);
      if (!parsed.success) continue;
      const pack = parsed.data;
      for (const s of pack.sentences) {
        if (!pack.passage_ko.includes(s.ko)) {
          failures++;
          console.warn(`sentence not in passage: "${s.ko}" in "${pack.title_ko}"`);
        }
      }
    }
    expect(failures).toBe(0);
  });
});