// app/components/songs/SongForm.tsx
"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  GENRES,
  KEY_OPTIONS,
  LENGTH_OPTIONS,
  LIMITS,
  MOOD_SUGGESTIONS,
  TIME_SIGNATURES,
  type LengthKey,
} from "@/convex/lib/songOptions";
import { useSongActions } from "@/hooks/useSongs";
import { cn } from "@/lib/utils";

function Tile({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "rounded-lg border px-3 py-2 text-left text-sm transition",
        selected
          ? "border-cyan-400 bg-cyan-500/15 shadow-[0_0_14px_-4px_var(--accent-400)]"
          : "border-border hover:border-cyan-400/50 hover:bg-cyan-500/5",
      )}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor} className="text-sm font-bold">
        {label}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function SongForm() {
  const router = useRouter();
  const { create } = useSongActions();

  const [topic, setTopic] = useState("");
  const [mood, setMood] = useState("Hopeful");
  const [genre, setGenre] = useState<string>("Pop");
  const [language, setLanguage] = useState("English");
  const [lengthKey, setLengthKey] = useState<LengthKey>("standard");
  const [key, setKey] = useState("auto");
  const [autoTempo, setAutoTempo] = useState(true);
  const [tempo, setTempo] = useState(95);
  const [beatsPerBar, setBeatsPerBar] = useState<3 | 4>(4);
  const [chordStyle, setChordStyle] = useState<"simple" | "rich">("simple");
  const [submitting, setSubmitting] = useState(false);

  const ready =
    topic.trim().length >= LIMITS.topicMin && mood.trim().length > 0;

  const submit = async () => {
    if (!ready || submitting) return;
    setSubmitting(true);
    const id = await create({
      topic,
      mood,
      genre,
      language,
      lengthKey,
      key: key === "auto" ? undefined : key,
      tempo: autoTempo ? undefined : tempo,
      beatsPerBar,
      chordStyle,
    });
    if (id) router.push(`/songs/${id}`);
    else setSubmitting(false);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Field
        label="What is the song about?"
        htmlFor="topic"
        hint={`${topic.length}/${LIMITS.topicMax}`}
      >
        <Textarea
          id="topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          maxLength={LIMITS.topicMax}
          rows={4}
          placeholder="e.g. Leaving my home town in Durban at sunrise, with a guitar and no plan…"
        />
      </Field>

      <Field label="Mood" htmlFor="mood">
        <Input
          id="mood"
          value={mood}
          onChange={(e) => setMood(e.target.value)}
          maxLength={LIMITS.moodMax}
        />
        <div className="flex flex-wrap gap-1.5 pt-1">
          {MOOD_SUGGESTIONS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMood(m)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition",
                mood === m
                  ? "border-fuchsia-400 bg-fuchsia-500/15"
                  : "border-border hover:border-fuchsia-400/50",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </Field>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field label="Genre / style">
          <Select value={genre} onValueChange={setGenre}>
            <SelectTrigger className="w-full" aria-label="Genre">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GENRES.map((g) => (
                <SelectItem key={g} value={g}>
                  {g}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Lyrics language" htmlFor="language">
          <Input
            id="language"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            maxLength={LIMITS.languageMax}
          />
        </Field>
      </div>

      <Field label="Length">
        <div className="grid gap-2 sm:grid-cols-3">
          {LENGTH_OPTIONS.map((o) => (
            <Tile
              key={o.key}
              selected={lengthKey === o.key}
              onClick={() => setLengthKey(o.key)}
            >
              <span className="block font-bold">
                {o.label} · {o.bars} bars
              </span>
              <span className="text-xs text-muted-foreground">{o.blurb}</span>
            </Tile>
          ))}
        </div>
      </Field>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field label="Key">
          <Select value={key} onValueChange={setKey}>
            <SelectTrigger className="w-full" aria-label="Key">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Let the AI choose</SelectItem>
              {KEY_OPTIONS.map((k) => (
                <SelectItem key={k} value={k}>
                  {k.endsWith("m") ? `${k.slice(0, -1)} minor` : `${k} major`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Time signature">
          <div className="flex gap-2">
            {TIME_SIGNATURES.map((t) => (
              <Tile
                key={t.label}
                selected={beatsPerBar === t.beats}
                onClick={() => setBeatsPerBar(t.beats)}
              >
                <span className="font-mono font-bold">{t.label}</span>
              </Tile>
            ))}
          </div>
        </Field>
      </div>

      <Field label="Tempo">
        <div className="flex items-center gap-3">
          <Switch
            id="auto-tempo"
            checked={autoTempo}
            onCheckedChange={setAutoTempo}
          />
          <Label htmlFor="auto-tempo" className="text-sm">
            Let the AI choose
          </Label>
        </div>
        {!autoTempo && (
          <div className="flex items-center gap-4 pt-2">
            <Slider
              value={[tempo]}
              min={50}
              max={180}
              step={1}
              onValueChange={([n]) => setTempo(n)}
              aria-label="Tempo"
            />
            <span className="w-20 shrink-0 text-right font-mono text-sm">
              {tempo} BPM
            </span>
          </div>
        )}
      </Field>

      <Field label="Chords">
        <div className="grid gap-2 sm:grid-cols-2">
          <Tile
            selected={chordStyle === "simple"}
            onClick={() => setChordStyle("simple")}
          >
            <span className="block font-bold">Simple</span>
            <span className="text-xs text-muted-foreground">
              Mostly triads. Easy to play.
            </span>
          </Tile>
          <Tile
            selected={chordStyle === "rich"}
            onClick={() => setChordStyle("rich")}
          >
            <span className="block font-bold">Rich</span>
            <span className="text-xs text-muted-foreground">
              7ths, 9ths, sus and slash chords.
            </span>
          </Tile>
        </div>
      </Field>

      <Button
        size="lg"
        className="w-full"
        onClick={submit}
        disabled={!ready || submitting}
      >
        {submitting ? <Loader2 className="animate-spin" /> : <Sparkles />}
        {submitting ? "Starting…" : "Write my song"}
      </Button>
    </div>
  );
}
