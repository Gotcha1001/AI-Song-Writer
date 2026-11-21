// app/components/songs/SongControls.tsx
"use client";

import {
  Copy,
  FileDown,
  FileMusic,
  Minus,
  Music2,
  Music,
  Pause,
  Play,
  Plus,
  Repeat,
  RotateCcw,
  Save,
  Sparkles,
  Mic,
  Package,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { LIMITS } from "@/convex/lib/songOptions";
import type { useSongPlayer } from "@/hooks/useSongPlayer";
import { cn } from "@/lib/utils";

type Player = ReturnType<typeof useSongPlayer>;

interface SongControlsProps {
  player: Player;

  /** Transposing */
  keyLabel: string;
  steps: number;
  onUp: () => void;
  onDown: () => void;
  onResetTranspose: () => void;
  onSaveTranspose: () => void;
  saving: boolean;

  /** View options */
  barsPerRow: number;
  setBarsPerRow: (n: number) => void;
  textScale: number;
  setTextScale: (n: number) => void;
  showChords: boolean;
  setShowChords: (b: boolean) => void;
  showLyrics: boolean;
  setShowLyrics: (b: boolean) => void;
  view: "chart" | "melody";
  setView: (v: "chart" | "melody") => void;

  onCopy: () => void;
  onDownloadPdf: () => void;
  pdfBusy: boolean;
  /** Download the melody as sheet music (PDF). */
  onDownloadSheet: () => void;
  sheetBusy: boolean;
  /** Download the melody (and chords) as a MIDI file. */
  onDownloadMidi: () => void;
  midiBusy: boolean;
  /** Download everything together in one ZIP. */
  onDownloadAll: () => void;
  bundleBusy: boolean;
  onRegenerate: () => void;
  busy: boolean;
  /** Ask the AI for a different melody over the same words. */
  onNewMelody: () => void;
  melodyBusy: boolean;
}

function Group({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id} className="text-sm">
        {label}
      </Label>
    </div>
  );
}

export function SongControls(p: SongControlsProps) {
  const { player } = p;
  const transposed = p.steps !== 0;

  return (
    <div className="grid gap-6 rounded-xl border border-cyan-500/25 bg-card p-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_0.8fr_1fr_1.25fr] print:hidden">
      <Group title="Play along">
        <div className="flex items-center gap-2">
          <Button
            onClick={() =>
              player.playing ? player.stop() : player.playFrom(0)
            }
            aria-label={player.playing ? "Stop" : "Play from the top"}
          >
            {player.playing ? <Pause /> : <Play />}
            {player.playing ? "Stop" : "Play"}
          </Button>
          <Button
            variant={player.loop ? "default" : "outline"}
            size="icon"
            aria-label="Loop"
            aria-pressed={player.loop}
            onClick={() => player.setLoop(!player.loop)}
          >
            <Repeat />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="bpm" className="text-sm">
            BPM
          </Label>
          <Input
            id="bpm"
            type="number"
            inputMode="numeric"
            min={LIMITS.minTempo}
            max={LIMITS.maxTempo}
            value={player.bpm}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) {
                player.setBpm(
                  Math.min(
                    LIMITS.maxTempo,
                    Math.max(LIMITS.minTempo, Math.round(n)),
                  ),
                );
              }
            }}
            className="w-20 font-mono"
          />
        </div>
        <Toggle
          id="snd-chords"
          label="Chord sound"
          checked={player.chordsOn}
          onChange={player.setChordsOn}
        />
        <Toggle
          id="snd-click"
          label="Metronome"
          checked={player.clickOn}
          onChange={player.setClickOn}
        />
        <Toggle
          id="snd-drums"
          label="Drum beat"
          checked={player.drumsOn}
          onChange={player.setDrumsOn}
        />
        <p className="text-xs text-muted-foreground">
          Tap any bar to start from there.
        </p>
      </Group>

      <Group title="Piano & voice">
        <Toggle
          id="snd-pedal"
          label="Sustain pedal"
          checked={player.pedalOn}
          onChange={player.setPedalOn}
        />
        <div>
          <p className="mb-1 text-sm">Piano style</p>
          <div className="flex gap-1">
            {(
              [
                ["chords", "Chords"],
                ["arpeggio", "Arpeggio"],
              ] as const
            ).map(([k, label]) => (
              <Button
                key={k}
                size="xs"
                variant={player.pianoStyle === k ? "default" : "outline"}
                aria-pressed={player.pianoStyle === k}
                onClick={() => player.setPianoStyle(k)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
        <Toggle
          id="snd-sing"
          label="Sing the melody"
          checked={player.singOn}
          onChange={player.setSingOn}
        />
        <Toggle
          id="snd-speak"
          label="Read lyrics aloud"
          checked={player.speakOn}
          onChange={player.setSpeakOn}
        />
        {player.speakOn && (
          <select
            aria-label="Voice"
            value={player.voiceURI}
            onChange={(e) => player.setVoiceURI(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
          >
            <option value="">Default voice</option>
            {player.voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        )}
        <p className="text-xs text-muted-foreground">
          The sung melody is a synth voice. Browsers can&apos;t truly sing, so
          the reading voice speaks the words in time.
        </p>
      </Group>

      <Group title="Transpose">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label="Down a semitone"
            onClick={p.onDown}
          >
            <Minus />
          </Button>
          <div className="min-w-16 text-center">
            <p className="font-mono text-xl font-black leading-none">
              {p.keyLabel}
            </p>
            <p className="font-mono text-xs text-muted-foreground">
              {p.steps > 0 ? `+${p.steps}` : p.steps}
            </p>
          </div>
          <Button
            variant="outline"
            size="icon"
            aria-label="Up a semitone"
            onClick={p.onUp}
          >
            <Plus />
          </Button>
        </div>
        {transposed && (
          <div className="flex flex-wrap gap-2">
            <Button size="xs" onClick={p.onSaveTranspose} disabled={p.saving}>
              <Save /> Save in this key
            </Button>
            <Button size="xs" variant="ghost" onClick={p.onResetTranspose}>
              <RotateCcw /> Reset
            </Button>
          </div>
        )}
        {transposed && (
          <p className="text-xs text-muted-foreground">
            Save or reset to edit bars again.
          </p>
        )}
      </Group>

      <Group title="View">
        <div className="flex gap-1 w-full flex-col gap-2">
          <Button
            size="xs"
            variant={p.view === "chart" ? "default" : "outline"}
            aria-pressed={p.view === "chart"}
            onClick={() => p.setView("chart")}
          >
            <Music /> Chord chart
          </Button>
          <Button
            size="xs"
            variant={p.view === "melody" ? "default" : "outline"}
            aria-pressed={p.view === "melody"}
            onClick={() => p.setView("melody")}
          >
            <Mic /> Melody sheet
          </Button>
        </div>
        <Toggle
          id="v-chords"
          label="Chords"
          checked={p.showChords}
          onChange={p.setShowChords}
        />
        <Toggle
          id="v-lyrics"
          label="Lyrics"
          checked={p.showLyrics}
          onChange={p.setShowLyrics}
        />
        <div>
          <p className="mb-1 text-sm">Bars per row</p>
          <div className="flex gap-1">
            {[1, 2, 3, 4].map((n) => (
              <Button
                key={n}
                size="icon-sm"
                variant={p.barsPerRow === n ? "default" : "outline"}
                aria-pressed={p.barsPerRow === n}
                onClick={() => p.setBarsPerRow(n)}
              >
                {n}
              </Button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-sm">Text size</p>
          <Slider
            value={[p.textScale]}
            min={0.8}
            max={1.6}
            step={0.1}
            onValueChange={([n]) => p.setTextScale(n)}
            aria-label="Text size"
          />
        </div>
      </Group>

      <Group title="Song">
        <div className="flex flex-col items-stretch gap-2 [&>button]:w-full [&>button]:justify-start">
          <Button size="sm" onClick={p.onDownloadPdf} disabled={p.pdfBusy}>
            <FileDown /> {p.pdfBusy ? "Making PDF…" : "Lyrics & chords (PDF)"}
          </Button>
          <Button
            size="sm"
            onClick={p.onDownloadSheet}
            disabled={p.sheetBusy}
            title="The melody as printable sheet music, with chords and the lyric under each note"
          >
            <Music2 /> {p.sheetBusy ? "Making PDF…" : "Melody sheet (PDF)"}
          </Button>
          <Button
            size="sm"
            onClick={p.onDownloadMidi}
            disabled={p.midiBusy}
            title="The sung melody with lyrics attached, plus a piano chord track. Opens in any music app or DAW."
          >
            <FileMusic /> {p.midiBusy ? "Making MIDI…" : "Melody (MIDI)"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={p.onDownloadAll}
            disabled={p.bundleBusy}
            title="Lyrics & chords (PDF), melody sheet (PDF) and melody (MIDI) in one ZIP"
          >
            <Package /> {p.bundleBusy ? "Packing…" : "Download all (ZIP)"}
          </Button>
          <Button variant="outline" size="sm" onClick={p.onCopy}>
            <Copy /> Copy as text
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={p.onRegenerate}
            disabled={p.busy}
          >
            <Sparkles /> Write it again
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={p.onNewMelody}
            disabled={p.melodyBusy}
          >
            <Wand2 /> {p.melodyBusy ? "Composing…" : "New melody"}
          </Button>
        </div>
      </Group>
    </div>
  );
}
