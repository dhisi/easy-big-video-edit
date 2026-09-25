import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Plus, Scissors, Trash2, Upload, ZoomIn, ZoomOut } from "lucide-react";
import { toast, Toaster } from "sonner";

import { Timeline, type AudioClip, type Selection, type VideoClip } from "@/components/Timeline";
import {
  readMediaDuration,
  readVideoInfo,
  startExport,
  supportsStreamingSave,
  type ExportHandle,
  type ExportQuality,
} from "@/lib/video-export";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Cutroom — Simple in-browser video trimmer" },
      {
        name: "description",
        content:
          "Trim long videos and swap the audio track right in your browser. Handles multi-hour, multi-gigabyte files and exports in original or 1080p quality.",
      },
      { property: "og:title", content: "Cutroom — Simple in-browser video trimmer" },
      {
        property: "og:description",
        content:
          "Trim long videos and swap the audio track right in your browser. Nothing is uploaded — even 20 GB files stay on your device.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Editor,
});

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

function formatSize(bytes: number) {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

const uid = () => Math.random().toString(36).slice(2, 10);

function Editor() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const exportRef = useRef<ExportHandle | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const wantPlay = useRef(false);

  const [videos, setVideos] = useState<VideoClip[]>([]);
  const [audios, setAudios] = useState<AudioClip[]>([]);
  const [active, setActive] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<Selection>(null);
  const [zoom, setZoom] = useState(1);
  const [keepOriginal, setKeepOriginal] = useState(true);
  const [quality, setQuality] = useState<ExportQuality>("original");
  const [progress, setProgress] = useState<number | null>(null);

  const starts = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const v of videos) {
      out.push(acc);
      acc += v.outPoint - v.inPoint;
    }
    return out;
  }, [videos]);
  const total = videos.reduce((s, v) => s + v.outPoint - v.inPoint, 0);

  const locate = useCallback(
    (t: number) => {
      for (let i = 0; i < videos.length; i++) {
        const len = videos[i]!.outPoint - videos[i]!.inPoint;
        if (t < starts[i]! + len || i === videos.length - 1) return { i, local: videos[i]!.inPoint + Math.min(len, Math.max(0, t - starts[i]!)) };
      }
      return { i: 0, local: 0 };
    },
    [videos, starts],
  );

  const addVideos = useCallback(async (files: FileList) => {
    for (const f of Array.from(files)) {
      try {
        const info = await readVideoInfo(f);
        if (!info.duration) throw new Error();
        setVideos((vs) => [
          ...vs,
          { id: uid(), file: f, url: URL.createObjectURL(f), name: f.name, duration: info.duration, width: info.width, height: info.height, inPoint: 0, outPoint: info.duration },
        ]);
      } catch {
        toast.error(`${f.name} couldn't be opened. Try MP4, MOV, WebM or MKV.`);
      }
    }
  }, []);

  const addAudios = useCallback(
    async (files: FileList) => {
      let at = current;
      for (const f of Array.from(files)) {
        try {
          const d = await readMediaDuration(f);
          if (!d) throw new Error();
          const clip: AudioClip = { id: uid(), file: f, url: URL.createObjectURL(f), name: f.name, sourceDuration: d, offset: at, inPoint: 0, outPoint: d };
          at += d;
          setAudios((as) => [...as, clip]);
        } catch {
          toast.error(`${f.name} couldn't be opened. Try MP3, M4A, WAV or OGG.`);
        }
      }
    },
    [current],
  );

  const seek = useCallback(
    (t: number) => {
      if (!videos.length) return;
      const { i, local } = locate(t);
      setCurrent(t);
      if (i !== active) {
        pendingSeek.current = local;
        wantPlay.current = playing;
        setActive(i);
      } else if (videoRef.current) {
        videoRef.current.currentTime = local;
      }
    },
    [videos.length, locate, active, playing],
  );

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      if (current >= total - 0.05) seek(0);
      void el.play();
    } else el.pause();
  }, [current, total, seek]);

  // Added audio playing at the current time, if any.
  const activeAudio = audios.find((a) => current >= a.offset && current < a.offset + a.outPoint - a.inPoint) ?? null;

  const syncAudio = useCallback(
    (t: number) => {
      const el = audioRef.current;
      if (!el) return;
      const a = audios.find((x) => t >= x.offset && t < x.offset + x.outPoint - x.inPoint);
      if (!a || !playing) {
        if (!el.paused) el.pause();
        return;
      }
      if (!el.src.endsWith(a.url)) el.src = a.url;
      const want = a.inPoint + (t - a.offset);
      if (Math.abs(el.currentTime - want) > 0.3) el.currentTime = want;
      if (el.paused) void el.play().catch(() => {});
    },
    [audios, playing],
  );

  useEffect(() => syncAudio(current), [playing, audios, syncAudio]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (active >= videos.length && videos.length) setActive(videos.length - 1);
  }, [videos.length, active]);

  const clip = videos[active] as VideoClip | undefined;

  const splitAtPlayhead = () => {
    if (selected?.kind === "audio") {
      const a = audios.find((x) => x.id === selected.id);
      if (!a) return;
      const cut = a.inPoint + (current - a.offset);
      if (cut <= a.inPoint + 0.1 || cut >= a.outPoint - 0.1) { toast("Move the playhead over the audio clip to split it."); return; }
      setAudios((as) =>
        as.flatMap((x) => (x.id === a.id ? [{ ...a, outPoint: cut }, { ...a, id: uid(), inPoint: cut, offset: current }] : [x])),
      );
      return;
    }
    const { i, local } = locate(current);
    const v = videos[i]!;
    if (!v || local <= v.inPoint + 0.1 || local >= v.outPoint - 0.1) return;
    setVideos((vs) => [...vs.slice(0, i), { ...v, outPoint: local }, { ...v, id: uid(), inPoint: local }, ...vs.slice(i + 1)]);
  };

  const deleteSelected = () => {
    if (!selected) return;
    if (selected.kind === "audio") setAudios((as) => as.filter((a) => a.id !== selected.id));
    else setVideos((vs) => vs.filter((v) => v.id !== selected.id));
    setSelected(null);
  };

  const runExport = useCallback(async () => {
    if (!videos.length) return;
    try {
      setProgress(0);
      const handle = await startExport({
        videos: videos.map((v) => ({ file: v.file, inPoint: v.inPoint, outPoint: v.outPoint })),
        audios: audios.map((a) => ({ file: a.file, offset: a.offset, inPoint: a.inPoint, outPoint: a.outPoint })),
        keepOriginalAudio: keepOriginal,
        quality,
        onProgress: setProgress,
      });
      exportRef.current = handle;
      const result = await handle.done;
      toast.success(result.savedToDisk ? "Saved to your chosen file." : `Downloaded ${result.fileName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "canceled") toast("Export canceled.");
      else if (!/abort/i.test(message)) toast.error(message || "Export failed.");
    } finally {
      exportRef.current = null;
      setProgress(null);
    }
  }, [videos, audios, keepOriginal, quality]);

  const toolBtn = "inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster position="top-center" theme="dark" />

      <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold tracking-tight">Cutroom</h1>
          <p className="truncate text-xs text-muted-foreground">
            {videos.length
              ? `${videos.length} clip${videos.length > 1 ? "s" : ""} · ${formatSize(videos.reduce((s, v) => s + v.file.size, 0))}`
              : "Simple video editing, entirely on your device"}
          </p>
        </div>
      </header>

      {!videos.length && (
        <main className="flex min-h-[calc(100vh-73px)] items-center justify-center px-5">
          <label className="flex w-full max-w-md cursor-pointer flex-col items-center gap-4 rounded-2xl border border-dashed border-border bg-card px-6 py-16 text-center transition-colors hover:border-accent">
            <Upload className="h-6 w-6 text-accent" />
            <div>
              <p className="text-sm font-medium">Choose videos</p>
              <p className="mt-1 text-xs text-muted-foreground">Nothing is uploaded. Multi-hour, multi-gigabyte files are fine.</p>
            </div>
            <input type="file" accept="video/*" multiple className="hidden" onChange={(e) => e.target.files && addVideos(e.target.files)} />
          </label>
        </main>
      )}

      {clip && (
        <main className="mx-auto max-w-5xl space-y-4 px-4 py-5">
          <div className="overflow-hidden rounded-2xl bg-black">
            <video
              ref={videoRef}
              src={clip.url}
              className="mx-auto max-h-[48vh] w-full object-contain"
              muted={!keepOriginal || Boolean(activeAudio)}
              onLoadedMetadata={(e) => {
                const el = e.currentTarget;
                el.currentTime = pendingSeek.current ?? clip.inPoint;
                pendingSeek.current = null;
                if (wantPlay.current) void el.play();
                wantPlay.current = false;
              }}
              onTimeUpdate={(e) => {
                const el = e.currentTarget;
                if (el.currentTime >= clip.outPoint - 0.03) {
                  if (active < videos.length - 1) {
                    wantPlay.current = !el.paused;
                    pendingSeek.current = videos[active + 1]!.inPoint;
                    setActive(active + 1);
                    setCurrent(starts[active + 1]!);
                  } else {
                    el.pause();
                    setCurrent(total);
                  }
                  return;
                }
                const t = starts[active]! + Math.max(0, el.currentTime - clip.inPoint);
                setCurrent(t);
                syncAudio(t);
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => {
                if (!wantPlay.current) setPlaying(false);
              }}
              onClick={togglePlay}
            />
            <audio ref={audioRef} preload="auto" />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={togglePlay}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground transition-opacity hover:opacity-90"
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </button>
            <span className="font-mono text-xs text-muted-foreground">
              {formatTime(current)} / {formatTime(total)}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button onClick={splitAtPlayhead} className={toolBtn}>
                <Scissors className="h-3.5 w-3.5" /> Split
              </button>
              <button onClick={deleteSelected} disabled={!selected} className={toolBtn}>
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
              <button onClick={() => setZoom((z) => Math.max(1, z / 2))} disabled={zoom <= 1} className={toolBtn} aria-label="Zoom out">
                <ZoomOut className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => setZoom((z) => Math.min(64, z * 2))} className={toolBtn} aria-label="Zoom in">
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <Timeline
            total={total}
            current={current}
            zoom={zoom}
            videos={videos}
            audios={audios}
            selected={selected}
            onSeek={seek}
            onSelect={setSelected}
            onVideoChange={(c) => setVideos((vs) => vs.map((v) => (v.id === c.id ? c : v)))}
            onVideoReorder={(from, to) =>
              setVideos((vs) => {
                const next = [...vs];
                const [m] = next.splice(from, 1);
                if (m) next.splice(to, 0, m);
                return next;
              })
            }
            onAudioChange={(c) => setAudios((as) => as.map((a) => (a.id === c.id ? c : a)))}
          />

          <div className="flex flex-wrap items-center gap-2">
            <label className={`${toolBtn} cursor-pointer`}>
              <Plus className="h-3.5 w-3.5" /> Video
              <input type="file" accept="video/*" multiple className="hidden" onChange={(e) => { if (e.target.files) void addVideos(e.target.files); e.target.value = ""; }} />
            </label>
            <label className={`${toolBtn} cursor-pointer`}>
              <Plus className="h-3.5 w-3.5" /> Audio
              <input type="file" accept="audio/*" multiple className="hidden" onChange={(e) => { if (e.target.files) void addAudios(e.target.files); e.target.value = ""; }} />
            </label>
            <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={keepOriginal} onChange={(e) => setKeepOriginal(e.target.checked)} className="accent-[var(--accent)]" />
              Original sound
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Drag clips to move them, drag their edges to trim. Select a clip and press Split to cut it at the playhead. Added audio replaces the original sound where it plays.
          </p>

          <section className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
            <span className="text-xs text-muted-foreground">Quality</span>
            <div className="grid grid-cols-2 gap-2">
              {(["original", "1080p"] as const).map((option) => (
                <button
                  key={option}
                  onClick={() => setQuality(option)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    quality === option ? "border-accent bg-accent/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {option === "original" ? "Original" : "1080p"}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-muted-foreground">
              {quality === "original" ? "No quality loss when clips come from the same camera." : "Re-encoded to 1080p."}
            </span>
          </section>

          {progress === null ? (
            <button onClick={runExport} className="w-full rounded-xl bg-accent py-3 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90">
              Export video
            </button>
          ) : (
            <div className="space-y-2 rounded-xl border border-border bg-card p-4">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Exporting… {Math.round(progress * 100)}%</span>
                <button onClick={() => exportRef.current?.cancel()} className="text-muted-foreground hover:text-foreground">
                  Cancel
                </button>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.max(2, progress * 100)}%` }} />
              </div>
            </div>
          )}

          <p className="pb-6 text-center text-[11px] text-muted-foreground">
            {typeof window !== "undefined" && !supportsStreamingSave()
              ? "This browser can't stream the result to disk, so very large exports may fail. Chrome or Edge is recommended."
              : "The export is written straight to the file you pick, so file size isn't limited by memory."}
          </p>
        </main>
      )}
    </div>
  );
}
