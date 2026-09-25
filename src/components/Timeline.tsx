import { useCallback, useRef } from "react";
import { Film, Music } from "lucide-react";

export type VideoClip = {
  id: string;
  file: File;
  url: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  inPoint: number;
  outPoint: number;
};

export type AudioClip = {
  id: string;
  file: File;
  url: string;
  name: string;
  sourceDuration: number;
  /** Where the clip starts on the timeline. */
  offset: number;
  inPoint: number;
  outPoint: number;
};

export type Selection = { kind: "video" | "audio"; id: string } | null;

type Props = {
  total: number;
  current: number;
  zoom: number;
  videos: VideoClip[];
  audios: AudioClip[];
  selected: Selection;
  onSeek: (time: number) => void;
  onSelect: (sel: Selection) => void;
  onVideoChange: (clip: VideoClip) => void;
  onVideoReorder: (from: number, to: number) => void;
  onAudioChange: (clip: AudioClip) => void;
};

type Drag =
  | { kind: "playhead" }
  | { kind: "v-in" | "v-out"; x0: number; pps: number; clip: VideoClip }
  | { kind: "v-move"; x0: number; id: string; moved: boolean }
  | { kind: "a-move" | "a-in" | "a-out"; x0: number; pps: number; clip: AudioClip };

const MIN = 0.2;

function tick(seconds: number) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function Timeline(props: Props) {
  const { total, current, zoom, videos, audios, selected, onSeek, onSelect } = props;
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const span = Math.max(total, audios.reduce((m, a) => Math.max(m, a.offset + a.outPoint - a.inPoint), 0), 1);
  const pct = (t: number) => (t / span) * 100;

  const timeAt = useCallback(
    (clientX: number) => {
      const el = ref.current;
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * span;
    },
    [span],
  );
  const pps = () => (ref.current?.getBoundingClientRect().width ?? 1) / span;

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "playhead") return onSeek(Math.min(timeAt(e.clientX), total));
    if (d.kind === "v-move") {
      if (!d.moved && Math.abs(e.clientX - d.x0) < 6) return;
      d.moved = true;
      const t = timeAt(e.clientX);
      const from = videos.findIndex((v) => v.id === d.id);
      let acc = 0;
      let to = videos.length - 1;
      for (let i = 0; i < videos.length; i++) {
        acc += videos[i].outPoint - videos[i].inPoint;
        if (t < acc) {
          to = i;
          break;
        }
      }
      if (from !== to && from >= 0) props.onVideoReorder(from, to);
      return;
    }
    const delta = (e.clientX - d.x0) / d.pps;
    if (d.kind === "v-in") {
      const c = d.clip as VideoClip;
      props.onVideoChange({ ...c, inPoint: Math.min(Math.max(0, c.inPoint + delta), c.outPoint - MIN) });
    } else if (d.kind === "v-out") {
      const c = d.clip as VideoClip;
      props.onVideoChange({ ...c, outPoint: Math.max(Math.min(c.duration, c.outPoint + delta), c.inPoint + MIN) });
    } else {
      const c = d.clip as AudioClip;
      const len = c.outPoint - c.inPoint;
      if (d.kind === "a-move") {
        props.onAudioChange({ ...c, offset: Math.max(0, c.offset + delta) });
      } else if (d.kind === "a-in") {
        const dd = Math.min(Math.max(delta, -c.inPoint, -c.offset), len - MIN);
        props.onAudioChange({ ...c, inPoint: c.inPoint + dd, offset: c.offset + dd });
      } else {
        props.onAudioChange({ ...c, outPoint: Math.min(c.sourceDuration, Math.max(c.inPoint + MIN, c.outPoint + delta)) });
      }
    }
  };
  const stop = () => {
    drag.current = null;
  };

  const start = (make: (x: number) => Drag, sel?: Selection) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (sel) onSelect(sel);
    drag.current = make(e.clientX);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const edge = (side: "left" | "right", onDown: (e: React.PointerEvent) => void, color: string) => (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={stop}
      className={`absolute inset-y-0 ${side === "left" ? "left-0" : "right-0"} z-10 flex w-3 cursor-ew-resize items-center justify-center`}
    >
      <span className={`h-6 w-1 rounded-full ${color}`} />
    </div>
  );

  const ticks = Array.from({ length: Math.max(2, Math.round(5 * zoom)) + 1 }, (_, i, arr) => (span * i) / (arr.length - 1));
  let acc = 0;

  return (
    <div className="flex gap-2 select-none">
      <div className="flex w-6 shrink-0 flex-col pt-5 text-muted-foreground">
        <div className="grid h-14 place-items-center"><Film className="h-4 w-4" /></div>
        <div className="mt-2 grid h-12 place-items-center"><Music className="h-4 w-4" /></div>
      </div>

      <div className="min-w-0 flex-1 overflow-x-auto pb-2">
        <div
          ref={ref}
          className="relative touch-none"
          style={{ width: `${zoom * 100}%` }}
          onPointerDown={(e) => {
            onSelect(null);
            drag.current = { kind: "playhead" };
            (e.currentTarget as Element).setPointerCapture(e.pointerId);
            onSeek(Math.min(timeAt(e.clientX), total));
          }}
          onPointerMove={onMove}
          onPointerUp={stop}
          onPointerCancel={stop}
        >
          <div className="relative h-5 font-mono text-[10px] text-muted-foreground">
            {ticks.map((t, i) => (
              <span
                key={i}
                className="absolute top-0 whitespace-nowrap"
                style={{ left: `${pct(t)}%`, transform: i === 0 ? "none" : i === ticks.length - 1 ? "translateX(-100%)" : "translateX(-50%)" }}
              >
                {tick(t)}
              </span>
            ))}
          </div>

          <div className="relative h-14 rounded-lg bg-secondary">
            {videos.map((v) => {
              const left = acc;
              const len = v.outPoint - v.inPoint;
              acc += len;
              const isSel = selected?.kind === "video" && selected.id === v.id;
              return (
                <div
                  key={v.id}
                  onPointerDown={start((x) => ({ kind: "v-move", x0: x, id: v.id, moved: false }), { kind: "video", id: v.id })}
                  onPointerMove={onMove}
                  onPointerUp={stop}
                  className={`absolute inset-y-0 cursor-grab overflow-hidden rounded-lg border-x border-background bg-accent/20 ring-inset ${isSel ? "ring-2 ring-accent" : "ring-1 ring-accent/40"}`}
                  style={{ left: `${pct(left)}%`, width: `${pct(len)}%` }}
                >
                  <span className="pointer-events-none absolute inset-0 flex items-center truncate px-4 text-[11px]">{v.name}</span>
                  {edge("left", start((x) => ({ kind: "v-in", x0: x, pps: pps(), clip: v }), { kind: "video", id: v.id }), "bg-accent")}
                  {edge("right", start((x) => ({ kind: "v-out", x0: x, pps: pps(), clip: v }), { kind: "video", id: v.id }), "bg-accent")}
                </div>
              );
            })}
          </div>

          <div className="relative mt-2 h-12 rounded-lg bg-secondary">
            {audios.length === 0 && (
              <span className="pointer-events-none absolute inset-0 flex items-center px-3 text-[11px] text-muted-foreground">
                Original sound
              </span>
            )}
            {audios.map((a) => {
              const isSel = selected?.kind === "audio" && selected.id === a.id;
              return (
                <div
                  key={a.id}
                  onPointerDown={start((x) => ({ kind: "a-move", x0: x, pps: pps(), clip: a }), { kind: "audio", id: a.id })}
                  onPointerMove={onMove}
                  onPointerUp={stop}
                  className={`absolute inset-y-0 cursor-grab overflow-hidden rounded-lg bg-audio/25 ring-inset ${isSel ? "ring-2 ring-audio" : "ring-1 ring-audio/50"}`}
                  style={{ left: `${pct(a.offset)}%`, width: `${pct(a.outPoint - a.inPoint)}%` }}
                >
                  <span className="pointer-events-none absolute inset-0 flex items-center truncate px-4 text-[11px]">{a.name}</span>
                  {edge("left", start((x) => ({ kind: "a-in", x0: x, pps: pps(), clip: a }), { kind: "audio", id: a.id }), "bg-audio")}
                  {edge("right", start((x) => ({ kind: "a-out", x0: x, pps: pps(), clip: a }), { kind: "audio", id: a.id }), "bg-audio")}
                </div>
              );
            })}
          </div>

          <div className="pointer-events-none absolute bottom-0 top-3 z-30 -ml-px w-0.5 bg-foreground" style={{ left: `${pct(current)}%` }}>
            <span className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full bg-foreground" />
          </div>
        </div>
      </div>
    </div>
  );
}
