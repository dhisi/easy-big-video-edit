import { useCallback, useRef } from "react";
import { Film, Music } from "lucide-react";

export type AudioClip = {
  name: string;
  /** Length of the audio file in seconds. */
  sourceDuration: number;
  /** Where the clip starts on the video timeline. */
  offset: number;
  /** Trim points inside the audio file. */
  inPoint: number;
  outPoint: number;
};

type Props = {
  duration: number;
  current: number;
  start: number;
  end: number;
  audio: AudioClip | null;
  onSeek: (time: number) => void;
  onTrim: (start: number, end: number) => void;
  onAudioChange: (clip: AudioClip) => void;
};

type Drag =
  | { kind: "start" | "end" | "playhead" }
  | { kind: "audio-move" | "audio-in" | "audio-out"; t0: number; clip: AudioClip };

const MIN = 0.1;

function formatTick(seconds: number) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export function Timeline({ duration, current, start, end, audio, onSeek, onTrim, onAudioChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const timeAt = useCallback(
    (clientX: number) => {
      const el = ref.current;
      if (!el || duration <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return ratio * duration;
    },
    [duration],
  );

  const apply = useCallback(
    (d: Drag, time: number) => {
      if (d.kind === "start") return onTrim(Math.min(time, end - MIN), end);
      if (d.kind === "end") return onTrim(start, Math.max(time, start + MIN));
      if (d.kind === "playhead") return onSeek(Math.min(Math.max(time, 0), duration));

      const c = d.clip;
      const delta = time - d.t0;
      const len = c.outPoint - c.inPoint;
      if (d.kind === "audio-move") {
        const offset = Math.min(Math.max(0, c.offset + delta), Math.max(0, duration - MIN));
        onAudioChange({ ...c, offset });
      } else if (d.kind === "audio-in") {
        // Move the left edge; the right edge stays put on the timeline.
        const minDelta = Math.max(-c.inPoint, -c.offset);
        const dd = Math.min(Math.max(delta, minDelta), len - MIN);
        onAudioChange({ ...c, inPoint: c.inPoint + dd, offset: c.offset + dd });
      } else {
        const outPoint = Math.min(c.sourceDuration, Math.max(c.inPoint + MIN, c.outPoint + delta));
        onAudioChange({ ...c, outPoint });
      }
    },
    [start, end, duration, onSeek, onTrim, onAudioChange],
  );

  const begin = (make: (t: number) => Drag) => (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    drag.current = make(timeAt(event.clientX));
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  };

  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);
  const ticks = Array.from({ length: 6 }, (_, i) => (duration * i) / 5);

  const move = (e: React.PointerEvent) => {
    if (drag.current) apply(drag.current, timeAt(e.clientX));
  };
  const stop = () => {
    drag.current = null;
  };

  const handle = (kind: "start" | "end", at: number) => (
    <div
      onPointerDown={begin(() => ({ kind }))}
      onPointerMove={move}
      onPointerUp={stop}
      className="absolute inset-y-0 z-20 -ml-3 flex w-6 cursor-ew-resize items-center justify-center"
      style={{ left: `${pct(at)}%` }}
    >
      <span className="h-9 w-1.5 rounded-full bg-accent" />
    </div>
  );

  return (
    <div className="flex gap-2 select-none">
      <div className="flex w-7 shrink-0 flex-col pt-5 text-muted-foreground">
        <div className="grid h-14 place-items-center"><Film className="h-4 w-4" /></div>
        <div className="mt-2 grid h-12 place-items-center"><Music className="h-4 w-4" /></div>
      </div>

      <div
        ref={ref}
        className="relative min-w-0 flex-1 touch-none"
        onPointerDown={(e) => {
          drag.current = { kind: "playhead" };
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          apply(drag.current, timeAt(e.clientX));
        }}
        onPointerMove={move}
        onPointerUp={stop}
        onPointerCancel={stop}
      >
        {/* Ruler */}
        <div className="relative h-5 font-mono text-[10px] text-muted-foreground">
          {ticks.map((t, i) => (
            <span
              key={i}
              className="absolute top-0"
              style={{ left: `${pct(t)}%`, transform: i === 0 ? "none" : i === 5 ? "translateX(-100%)" : "translateX(-50%)" }}
            >
              {formatTick(t)}
            </span>
          ))}
        </div>

        {/* Video track */}
        <div className="relative h-14 rounded-lg bg-secondary">
          <div
            className="absolute inset-y-0 rounded-lg bg-accent/15 ring-1 ring-accent/50"
            style={{ left: `${pct(start)}%`, right: `${100 - pct(end)}%` }}
          />
          {handle("start", start)}
          {handle("end", end)}
        </div>

        {/* Audio track */}
        <div className="relative mt-2 h-12 rounded-lg bg-secondary">
          {audio ? (
            <div
              onPointerDown={begin((t) => ({ kind: "audio-move", t0: t, clip: audio }))}
              onPointerMove={move}
              onPointerUp={stop}
              className="absolute inset-y-0 cursor-grab overflow-hidden rounded-lg bg-audio/25 ring-1 ring-audio/60 active:cursor-grabbing"
              style={{ left: `${pct(audio.offset)}%`, width: `${pct(audio.outPoint - audio.inPoint)}%` }}
              title="Drag to move · drag edges to trim"
            >
              <span className="pointer-events-none absolute inset-0 flex items-center truncate px-4 text-[11px] text-foreground">
                {audio.name}
              </span>
              <div
                onPointerDown={begin((t) => ({ kind: "audio-in", t0: t, clip: audio }))}
                onPointerMove={move}
                onPointerUp={stop}
                className="absolute inset-y-0 left-0 z-10 flex w-3 cursor-ew-resize items-center justify-center"
              >
                <span className="h-6 w-1 rounded-full bg-audio" />
              </div>
              <div
                onPointerDown={begin((t) => ({ kind: "audio-out", t0: t, clip: audio }))}
                onPointerMove={move}
                onPointerUp={stop}
                className="absolute inset-y-0 right-0 z-10 flex w-3 cursor-ew-resize items-center justify-center"
              >
                <span className="h-6 w-1 rounded-full bg-audio" />
              </div>
            </div>
          ) : (
            <span className="pointer-events-none absolute inset-0 flex items-center px-3 text-[11px] text-muted-foreground">
              Original sound
            </span>
          )}
        </div>

        {/* Playhead */}
        <div
          className="pointer-events-none absolute bottom-0 top-3 z-30 -ml-px w-0.5 rounded-full bg-foreground"
          style={{ left: `${pct(current)}%` }}
        >
          <span className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full bg-foreground" />
        </div>
      </div>
    </div>
  );
}
