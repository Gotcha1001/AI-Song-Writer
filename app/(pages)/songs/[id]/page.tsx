// app/(pages)/songs/[id]/page.tsx   →   URL: /songs/<songId>
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Check, Pencil, Star } from "lucide-react";
import { toast } from "sonner";
import { BarEditor } from "@/app/components/songs/BarEditor";
import { ChordChart } from "@/app/components/songs/ChordChart";
import { MelodySheet } from "@/app/components/songs/MelodySheet";
import {
  FailedState,
  GeneratingState,
} from "@/app/components/songs/GeneratingState";
import { SongControls } from "@/app/components/songs/SongControls";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { LIMITS } from "@/convex/lib/songOptions";
import { usePersistentState } from "@/hooks/usePersistentState";
import { useSongPlayer } from "@/hooks/useSongPlayer";
import { useSong, useSongActions } from "@/hooks/useSongs";
import { useTranspose } from "@/hooks/useTranspose";
import { buildMelody } from "@/lib/melody";
import { formatSongText } from "@/lib/music";
import { downloadSongPdf } from "@/lib/songPdf";

import type { SongSection, SongSegment } from "@/lib/songTypes";
import { cn } from "@/lib/utils";
import {
  downloadMelodySheetPdf,
  downloadSongBundle,
  downloadSongMidi,
} from "@/lib/sondDownload";

const NO_SECTIONS: SongSection[] = [];

export default function SongPage() {
  const { id } = useParams<{ id: string }>();
  const song = useSong(id);
  const actions = useSongActions();

  const t = useTranspose(song?.sections ?? NO_SECTIONS, song?.key ?? "C");
  // The tune is composed by the AI from the lyrics + chords and saved on the song.
  // Bars it didn't compose (older songs, edited lyrics) get a built-in fallback.
  const melody = useMemo(
    () =>
      song && t.sections.length
        ? buildMelody(
            t.sections,
            t.key,
            song.beatsPerBar,
            song._id,
            song.melody,
            {
              genre: song.genre,
              tempo: song.tempo,
              language: song.language,
            },
          )
        : null,
    [song, t.sections, t.key],
  );
  const player = useSongPlayer({
    sections: t.sections,
    defaultTempo: song?.tempo ?? 90,
    beatsPerBar: song?.beatsPerBar ?? 4,
    melody,
    extraInstruments: song?.extraInstruments ?? [],
    genre: song?.genre ?? "pop",
  });

  // Remembered per browser.
  const [barsPerRow, setBarsPerRow] = usePersistentState("sw:barsPerRow", 4);
  const [textScale, setTextScale] = usePersistentState("sw:textScale", 1);
  const [showChords, setShowChords] = usePersistentState("sw:showChords", true);
  const [showLyrics, setShowLyrics] = usePersistentState("sw:showLyrics", true);
  const [viewRaw, setView] = usePersistentState("sw:view", "chart");
  const view: "chart" | "melody" = viewRaw === "melody" ? "melody" : "chart";

  const [editing, setEditing] = useState<{ si: number; bi: number } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [midiBusy, setMidiBusy] = useState(false);
  const [bundleBusy, setBundleBusy] = useState(false);
  const [melodyAsking, setMelodyAsking] = useState(false);

  if (song === undefined) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (song === null) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-16 text-center">
        <p className="text-xl font-bold">Song not found</p>
        <p className="text-muted-foreground">
          It may have been deleted, or it belongs to another account.
        </p>
        <Button asChild>
          <Link href="/songs">Back to my songs</Link>
        </Button>
      </div>
    );
  }

  const ready = song.status === "ready";
  const transposed = t.steps !== 0;

  const commitTitle = async () => {
    const next = titleDraft?.trim();
    setTitleDraft(null);
    if (next && next !== song.title) await actions.rename(song._id, next);
  };

  const saveBar = async (segments: SongSegment[]) => {
    if (!editing) return;
    const sections = song.sections.map((s, si) =>
      si !== editing.si
        ? s
        : {
            ...s,
            bars: s.bars.map((b, bi) => (bi !== editing.bi ? b : { segments })),
          },
    );
    setSaving(true);
    const ok = await actions.saveContent({ songId: song._id, sections });
    setSaving(false);
    if (ok) setEditing(null);
  };

  const saveTranspose = async () => {
    setSaving(true);
    const ok = await actions.saveContent({
      songId: song._id,
      sections: t.sections,
      key: t.key,
    });
    setSaving(false);
    if (ok) t.reset();
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(
        formatSongText(song.title, t.key, player.bpm, t.sections, barsPerRow),
      );
      toast.success(
        "Copied. Paste it into a monospaced font to keep the chords lined up.",
      );
    } catch {
      toast.error("Couldn't copy — your browser blocked it.");
    }
  };

  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      await downloadSongPdf({
        title: song.title,
        key: t.key,
        tempo: player.bpm,
        beatsPerBar: song.beatsPerBar,
        subtitle: `${song.genre} · ${song.mood}`,
        sections: t.sections,
        barsPerRow,
        showChords,
        showLyrics,
        textScale,
      });
    } catch {
      toast.error("Couldn't make the PDF. Please try again.");
    } finally {
      setPdfBusy(false);
    }
  };

  const warnIfPlaceholder = () => {
    if (melodyAsking || song.melodyStatus === "composing") {
      toast.message(
        "The AI is still composing, so this download has the placeholder tune.",
      );
    }
  };

  /** Settings for the PDF, exactly as shown on screen. */
  const pdfOptions = () => ({
    title: song.title,
    key: t.key,
    tempo: player.bpm,
    beatsPerBar: song.beatsPerBar,
    subtitle: `${song.genre} · ${song.mood}`,
    sections: t.sections,
    barsPerRow,
    showChords,
    showLyrics,
    textScale,
  });

  /** Settings for the melody sheet PDF, matching the on-screen sheet. */
  const sheetOptions = (m: NonNullable<typeof melody>) => ({
    title: song.title,
    key: t.key,
    tempo: player.bpm,
    beatsPerBar: song.beatsPerBar,
    subtitle: `${song.genre} · ${song.mood}`,
    melody: m,
    sections: t.sections,
    barsPerRow,
    showChords,
  });

  const downloadSheet = async () => {
    if (!melody) return;
    setSheetBusy(true);
    try {
      warnIfPlaceholder();
      await downloadMelodySheetPdf(sheetOptions(melody));
    } catch {
      toast.error("Couldn't make the melody sheet. Please try again.");
    } finally {
      setSheetBusy(false);
    }
  };

  const downloadMidi = () => {
    if (!melody) return;
    setMidiBusy(true);
    try {
      warnIfPlaceholder();
      downloadSongMidi({
        title: song.title,
        bpm: player.bpm,
        melody,
      });
    } catch {
      toast.error("Couldn't make the MIDI file. Please try again.");
    } finally {
      setMidiBusy(false);
    }
  };

  const downloadAll = async () => {
    if (!melody) return;
    setBundleBusy(true);
    try {
      warnIfPlaceholder();
      await downloadSongBundle(pdfOptions(), sheetOptions(melody), {
        title: song.title,
        bpm: player.bpm,
        melody,
      });
    } catch {
      toast.error("Couldn't make the download. Please try again.");
    } finally {
      setBundleBusy(false);
    }
  };

  const retry = async () => {
    setRetrying(true);
    await actions.regenerate(song._id);
    setRetrying(false);
  };

  const newMelody = async () => {
    player.stop();
    setMelodyAsking(true);
    await actions.regenerateMelody(song._id);
    setMelodyAsking(false);
  };

  const composing = melodyAsking || song.melodyStatus === "composing";

  const editingBar = editing
    ? song.sections[editing.si]?.bars[editing.bi]
    : undefined;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {titleDraft === null ? (
            <>
              <h1 className="text-3xl font-black tracking-tight">
                {song.title}
              </h1>
              {ready && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Rename song"
                  className="print:hidden"
                  onClick={() => setTitleDraft(song.title)}
                >
                  <Pencil />
                </Button>
              )}
            </>
          ) : (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void commitTitle();
              }}
            >
              <Input
                autoFocus
                value={titleDraft}
                maxLength={LIMITS.titleMax}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void commitTitle()}
                aria-label="Song title"
                className="h-11 w-72 max-w-full text-xl font-bold"
              />
              <Button type="submit" size="icon" aria-label="Save title">
                <Check />
              </Button>
            </form>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              song.isFavorite ? "Remove from favourites" : "Add to favourites"
            }
            aria-pressed={song.isFavorite}
            className="print:hidden"
            onClick={() => void actions.setFavorite(song._id, !song.isFavorite)}
          >
            <Star
              className={cn(song.isFavorite && "fill-current text-yellow-400")}
            />
          </Button>
        </div>

        {ready && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">Key {t.key}</Badge>
            <Badge variant="outline">{player.bpm} BPM</Badge>
            <Badge variant="outline">{song.beatsPerBar}/4</Badge>
            <Badge variant="secondary">{song.genre}</Badge>
            <Badge variant="secondary">{song.mood}</Badge>
            <span className="text-sm text-muted-foreground">
              · {song.topic}
            </span>
          </div>
        )}
      </header>

      {song.status === "generating" && <GeneratingState topic={song.topic} />}
      {song.status === "failed" && (
        <FailedState
          error={song.error}
          busy={retrying}
          onRetry={() => void retry()}
        />
      )}

      {ready && (
        <>
          <SongControls
            player={player}
            keyLabel={t.key}
            steps={t.steps}
            onUp={t.up}
            onDown={t.down}
            onResetTranspose={t.reset}
            onSaveTranspose={() => void saveTranspose()}
            saving={saving}
            barsPerRow={barsPerRow}
            setBarsPerRow={setBarsPerRow}
            textScale={textScale}
            setTextScale={setTextScale}
            showChords={showChords}
            setShowChords={setShowChords}
            showLyrics={showLyrics}
            setShowLyrics={setShowLyrics}
            view={view}
            setView={setView}
            onCopy={() => void copyText()}
            onDownloadPdf={() => void downloadPdf()}
            pdfBusy={pdfBusy}
            onDownloadSheet={() => void downloadSheet()}
            sheetBusy={sheetBusy}
            onDownloadMidi={downloadMidi}
            midiBusy={midiBusy}
            onDownloadAll={() => void downloadAll()}
            bundleBusy={bundleBusy}
            onRegenerate={() => setConfirmRegen(true)}
            busy={retrying}
            onNewMelody={() => void newMelody()}
            melodyBusy={melodyAsking}
          />

          {composing ? (
            <p className="rounded-lg border border-cyan-500/25 bg-card px-4 py-3 text-sm text-muted-foreground print:hidden">
              The AI is composing a melody for your lyrics. What you see and
              hear now is a placeholder tune, and it will be replaced as soon as
              the new melody is ready.
            </p>
          ) : song.melodyStatus === "failed" ? (
            <p className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-card px-4 py-3 text-sm print:hidden">
              <span>{song.melodyError ?? "Couldn't compose the melody."}</span>
              <Button size="sm" onClick={() => void newMelody()}>
                Try again
              </Button>
            </p>
          ) : !song.melodyStatus ? (
            <p className="flex flex-wrap items-center gap-3 rounded-lg border border-cyan-500/25 bg-card px-4 py-3 text-sm text-muted-foreground print:hidden">
              <span>
                This song&apos;s tune was made by simple rules. Let the AI
                compose a real melody from the lyrics instead.
              </span>
              <Button size="sm" onClick={() => void newMelody()}>
                Compose with AI
              </Button>
            </p>
          ) : null}

          {view === "melody" && melody ? (
            <MelodySheet
              melody={melody}
              sections={t.sections}
              barsPerRow={barsPerRow}
              showChords={showChords}
              currentIndex={player.currentIndex}
              onBarClick={(i) => player.playFrom(i)}
            />
          ) : (
            <ChordChart
              sections={t.sections}
              barsPerRow={barsPerRow}
              showChords={showChords}
              showLyrics={showLyrics}
              textScale={textScale}
              currentIndex={player.currentIndex}
              onBarClick={(i) => player.playFrom(i)}
              onEditBar={
                transposed ? undefined : (si, bi) => setEditing({ si, bi })
              }
            />
          )}
        </>
      )}

      {editing && editingBar && (
        <BarEditor
          key={`${editing.si}-${editing.bi}`}
          title={`${song.sections[editing.si].name} · bar ${editing.bi + 1}`}
          bar={editingBar}
          saving={saving}
          onSave={(segments) => void saveBar(segments)}
          onClose={() => setEditing(null)}
        />
      )}

      <AlertDialog open={confirmRegen} onOpenChange={setConfirmRegen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Write this song again?</AlertDialogTitle>
            <AlertDialogDescription>
              The AI will write a new version from the same brief. Your edits to
              this version will be replaced.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep this one</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                player.stop();
                t.reset();
                void retry();
              }}
            >
              Write it again
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
