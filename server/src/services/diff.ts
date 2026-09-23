export type DiffOpType = 'equal' | 'delete' | 'insert';

export interface DiffOp {
  type: DiffOpType;
  text: string;
}

// NFC-normalize and drop spaces/punctuation/symbols before comparing.
// Keeps Hangul syllables, jamo, letters, and digits.
export function normalizeForCompare(s: string): string {
  return s.normalize('NFC').replace(/[\s\p{P}\p{S}]+/gu, '');
}

// Tokenize a string into array elements (characters; for Hangul these are syllables).
export function splitTokens(s: string): string[] {
  return [...s.normalize('NFC')];
}

/**
 * Classic LCS-based diff over token arrays.
 * 'delete' = only in `a` (original / target)
 * 'insert' = only in `b` (typed / recognized)
 * 'equal'  = present in both, matched
 */
export function diffTokens(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // LCS lengths
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'delete', text: a[i] });
      i++;
    } else {
      ops.push({ type: 'insert', text: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: 'delete', text: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: 'insert', text: b[j] });
    j++;
  }
  return ops;
}

/** Merge consecutive operations of the same type into segments for display. */
export function groupOps(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last && last.type === op.type) last.text += op.text;
    else out.push({ type: op.type, text: op.text });
  }
  return out;
}

/** Percent of tokens matched, 0-100. */
export function matchPercent(aLen: number, bLen: number, equalLen: number): number {
  const max = Math.max(aLen, bLen);
  if (max === 0) return 100;
  return Math.round((equalLen / max) * 100);
}

export interface CharDiffResult {
  matched: number;
  ops: DiffOp[];
  segments: DiffOp[];
  percent: number;
}

/** Diff two raw strings: normalize (NFC, ignore spaces/punctuation), compare token-wise. */
export function compareStrings(aRaw: string, bRaw: string): CharDiffResult {
  const a = splitTokens(normalizeForCompare(aRaw));
  const b = splitTokens(normalizeForCompare(bRaw));
  const ops = diffTokens(a, b);
  const matched = ops.filter((o) => o.type === 'equal').length;
  return {
    matched,
    ops,
    segments: groupOps(ops),
    percent: matchPercent(a.length, b.length, matched),
  };
}

/**
 * Read-aloud score: how much of the TARGET you actually said
 * (matched / target length), tolerant of extra words that come from
 * hesitation, filler, or speech-recognizer noise. In contrast to
 * compareStrings it does NOT punish a longer transcript, so honest
 * attempts don't swing between 70 and 100% on recognition jitter.
 */
export function compareReadAloud(aRaw: string, bRaw: string): CharDiffResult {
  const a = splitTokens(normalizeForCompare(aRaw));
  const b = splitTokens(normalizeForCompare(bRaw));
  const ops = diffTokens(a, b);
  const matched = ops.filter((o) => o.type === 'equal').length;
  const percent = a.length === 0 ? 0 : Math.min(100, Math.round((matched / a.length) * 100));
  return { matched, ops, segments: groupOps(ops), percent };
}