// convex/lib/syllables.ts
// Splits lyrics into singable syllables. Pure functions with no imports, so the
// Convex AI code and the React sheet/player share exactly the same split.

/* -------------------------------- syllables -------------------------------- */

const V = "aeiouyàáâãäåèéêëìíîïòóôõöùúûüæœ";
const isVowel = (ch: string) => V.includes(ch.toLowerCase());

/** Split one word into singable syllables (a good-enough rule of thumb). */
export function syllabify(word: string): string[] {
  const w = word;
  // vowel groups; "y" at the start of a word is a consonant
  const groups: { s: number; e: number }[] = [];
  let i = 0;
  while (i < w.length) {
    const c = w[i];
    const vowel = isVowel(c) && !(i === 0 && c.toLowerCase() === "y");
    if (vowel) {
      let j = i;
      while (j < w.length && isVowel(w[j])) j++;
      groups.push({ s: i, e: j });
      i = j;
    } else i++;
  }
  if (groups.length <= 1) return [w];

  const lower = w.toLowerCase().replace(/[^a-z]+$/, "");
  const last = groups[groups.length - 1];
  const endsInLetters = lower.length;
  // silent final "e" (made, love) but not "le" (table) or a lone "e" word
  if (
    last.e - last.s === 1 &&
    lower.endsWith("e") &&
    last.e >= endsInLetters &&
    !/[^aeiouy]le$/.test(lower) &&
    !isVowel(lower[lower.length - 2] ?? "a")
  ) {
    groups.pop();
  } else if (
    // silent "ed" (walked, loved) but not after t / d (wanted, needed)
    /[^aeiouytd]ed$/.test(lower) &&
    last.e - last.s === 1
  ) {
    groups.pop();
  }
  if (groups.length <= 1) return [w];

  const cuts: number[] = [];
  for (let g = 0; g < groups.length - 1; g++) {
    const between = groups[g + 1].s - groups[g].e;
    let cut = groups[g].e + (between <= 1 ? 0 : Math.floor(between / 2));
    // keep the suffix "-ing" whole: walk-ing, think-ing, sing-ing
    // (a doubled consonant still splits in the middle: run-ning)
    if (g === groups.length - 2 && between >= 2) {
      const tail = lower.slice(groups[g + 1].s);
      const cluster = lower.slice(groups[g].e, groups[g + 1].s);
      if (/^ing$/.test(tail) && !/^(.)\1$/.test(cluster)) cut = groups[g + 1].s;
    }
    cuts.push(cut);
  }
  const out: string[] = [];
  let from = 0;
  for (const c of cuts) {
    out.push(w.slice(from, c));
    from = c;
  }
  out.push(w.slice(from));
  return out.filter((x) => x.length > 0);
}

export interface Syllable {
  text: string;
  /** More of the same word follows (draw a hyphen under the lyric). */
  joinNext: boolean;
}

/** All the syllables sung in one bar, in order. */
export function barSyllables(segments: { lyric: string }[]): Syllable[] {
  const out: Syllable[] = [];
  for (const seg of segments) {
    const tokens = seg.lyric
      .split(/\s+/)
      .filter((t) => /[\p{L}\p{N}]/u.test(t));
    for (const raw of tokens) {
      const cont = raw.endsWith("-");
      const token = cont ? raw.slice(0, -1) : raw;
      const parts = syllabify(token);
      parts.forEach((text, i) =>
        out.push({ text, joinNext: i < parts.length - 1 || cont }),
      );
    }
  }
  return out;
}

/**
 * A bar can hold at most `units` notes (one per sixteenth). If the lyric has
 * more syllables than that, the extra tail is merged into the last note.
 */
export function capSyllables(syl: Syllable[], units: number): Syllable[] {
  if (syl.length <= units) return syl;
  const head = syl.slice(0, units - 1);
  const tail = syl.slice(units - 1);
  return [
    ...head,
    {
      text: tail.map((s) => s.text).join(""),
      joinNext: tail[tail.length - 1].joinNext,
    },
  ];
}
