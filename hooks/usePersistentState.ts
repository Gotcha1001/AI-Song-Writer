// hooks/usePersistentState.ts
"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T;

const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

/**
 * Like useState, but remembered in localStorage (per browser).
 * Safe for SSR: the server and first paint use `initial`.
 * Pass primitive values only (string / number / boolean).
 */
export function usePersistentState<T extends string | number | boolean>(
  key: string,
  initial: T,
): [Widen<T>, (value: Widen<T>) => void] {
  type V = Widen<T>;
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    () => null,
  );

  const value = useMemo<V>(() => {
    if (raw === null) return initial as V;
    try {
      return JSON.parse(raw) as V;
    } catch {
      return initial as V;
    }
  }, [raw, initial]);

  const set = useCallback(
    (next: V) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* private mode etc. */
      }
      listeners.forEach((l) => l());
    },
    [key],
  );

  return [value, set];
}
