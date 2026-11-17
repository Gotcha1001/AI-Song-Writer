// hooks/useTranspose.ts
"use client";

import { useCallback, useMemo, useState } from "react";
import { transposeKey, transposeSections } from "@/lib/music";
import type { SongSection } from "@/lib/songTypes";

/** View-only transposing: the saved song is untouched until you press Save. */
export function useTranspose(sections: SongSection[], key: string) {
  const [steps, setSteps] = useState(0);

  const shifted = useMemo(
    () => transposeSections(sections, key, steps),
    [sections, key, steps],
  );
  const shiftedKey = useMemo(() => transposeKey(key, steps), [key, steps]);

  const up = useCallback(() => setSteps((s) => Math.min(11, s + 1)), []);
  const down = useCallback(() => setSteps((s) => Math.max(-11, s - 1)), []);
  const reset = useCallback(() => setSteps(0), []);

  return { steps, up, down, reset, sections: shifted, key: shiftedKey };
}
