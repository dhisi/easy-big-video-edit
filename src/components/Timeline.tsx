import { useCallback, useRef } from "react";

type Props = {
  duration: number;
  current: number;
  start: number;
  end: number;
  onSeek: (time: number) => void;
  onTrim: (start: number, end: number) => void;
};

type Handle = "start" | "end" | "playhead";

export function Timeline({ duration, current, start, end, onSeek, onTrim }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef<Handle | null>(null);

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
    (handle: Handle, time: number) => {
      if (handle === "start") onTrim(Math.min(time, end - 0.1), end);
      else if (handle === "end") onTrim(start, Math.max(time, start + 0.1));
      else onSeek(Math.min(Math.max(time, start), end));
    },
    [start, end, onSeek, onTrim],
  );

  const beginDrag = (handle: Handle) => (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragging.current = handle;
    (event.target as Element).setPointerCapture(event.pointerId);
  };

  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);

  return (
    <div
      ref={ref}
      className="relative h-20 w-full touch-none select-none rounded-xl bg-secondary"
      onPointerDown={(e) => {
        if (dragging.current) return;
        apply("playhead", timeAt(e.clientX));
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        apply(dragging.current, timeAt(e.clientX));
      }}
      onPointerUp={() => {
        dragging.current = null;
      }}
      onPointerCancel={() => {
        dragging.current = null;
      }}
    >
      <div
        className="absolute inset-y-0 rounded-xl bg-accent/15 ring-1 ring-accent/50"
        style={{ left: `${pct(start)}%`, right: `${100 - pct(end)}%` }}
      />

      <div
        onPointerDown={beginDrag("start")}
        className="absolute inset-y-0 z-20 -ml-3 flex w-6 cursor-ew-resize items-center justify-center"
        style={{ left: `${pct(start)}%` }}
      >
        <span className="h-12 w-1.5 rounded-full bg-accent" />
      </div>
      <div
        onPointerDown={beginDrag("end")}
        className="absolute inset-y-0 z-20 -ml-3 flex w-6 cursor-ew-resize items-center justify-center"
        style={{ left: `${pct(end)}%` }}
      >
        <span className="h-12 w-1.5 rounded-full bg-accent" />
      </div>

      <div
        onPointerDown={beginDrag("playhead")}
        className="absolute inset-y-0 z-10 -ml-2 w-4 cursor-grab"
        style={{ left: `${pct(current)}%` }}
      >
        <span className="absolute inset-y-2 left-1.5 w-0.5 rounded-full bg-foreground" />
      </div>
    </div>
  );
}
