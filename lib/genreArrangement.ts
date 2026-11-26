/**
 * Genre families used by the player. Kept as a small pure helper so the
 * arrangement vocabulary is documented and reusable.
 */
export type ArrangementFamily =
  | "latin"
  | "acoustic"
  | "rock"
  | "jazz"
  | "ambient"
  | "dance"
  | "pop";

export function getArrangementFamily(genre: string): ArrangementFamily {
  if (/latin|salsa|regga|bossa/i.test(genre)) return "latin";
  if (/country|bluegrass|folk/i.test(genre)) return "acoustic";
  if (/rock|metal|punk|alternative/i.test(genre)) return "rock";
  if (/jazz|swing|blues/i.test(genre)) return "jazz";
  if (/ambient|cinematic|classical|soundtrack/i.test(genre)) return "ambient";
  if (/dance|edm|electro|house|techno/i.test(genre)) return "dance";
  return "pop";
}
