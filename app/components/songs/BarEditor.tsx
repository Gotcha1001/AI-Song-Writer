// app/components/songs/BarEditor.tsx
"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CHORD_RE, LIMITS } from "@/convex/lib/songOptions";
import type { SongBar, SongSegment } from "@/lib/songTypes";

interface Row {
  chord: string;
  lyric: string;
}

interface BarEditorProps {
  title: string; // e.g. "Verse 1 · bar 3"
  bar: SongBar;
  saving?: boolean;
  onSave: (segments: SongSegment[]) => void;
  onClose: () => void;
}

/** Render with a `key` so it resets for each bar you open. */
export function BarEditor({
  title,
  bar,
  saving,
  onSave,
  onClose,
}: BarEditorProps) {
  const [rows, setRows] = useState<Row[]>(
    bar.segments.map((s) => ({ chord: s.chord ?? "", lyric: s.lyric })),
  );

  const invalid = rows.map(
    (r) => r.chord.trim() !== "" && !CHORD_RE.test(r.chord.trim()),
  );
  const canSave = rows.length > 0 && !invalid.some(Boolean);

  const update = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const save = () => {
    onSave(
      rows.map((r) => {
        const chord = r.chord.trim();
        return chord ? { chord, lyric: r.lyric } : { lyric: r.lyric };
      }),
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Each row is one chord and the words sung from it. End a row with a
            hyphen if the word carries on in the next row.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={row.chord}
                onChange={(e) => update(i, { chord: e.target.value })}
                placeholder="Chord"
                aria-label={`Chord ${i + 1}`}
                aria-invalid={invalid[i]}
                className="w-24 font-mono font-bold"
                maxLength={14}
              />
              <Input
                value={row.lyric}
                onChange={(e) => update(i, { lyric: e.target.value })}
                placeholder="Lyric (blank = instrumental)"
                aria-label={`Lyric ${i + 1}`}
                maxLength={LIMITS.lyricMax}
                className="flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove chord"
                disabled={rows.length === 1}
                onClick={() =>
                  setRows((rs) => rs.filter((_, idx) => idx !== i))
                }
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={rows.length >= LIMITS.maxSegmentsPerBar}
            onClick={() => setRows((rs) => [...rs, { chord: "", lyric: "" }])}
          >
            <Plus /> Add chord
          </Button>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave || saving}>
            Save bar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
