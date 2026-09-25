import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Music, Pause, Play, Scissors, Upload, X } from "lucide-react";
import { toast, Toaster } from "sonner";

import { Timeline } from "@/components/Timeline";
import {
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

function Editor() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const exportRef = useRef<ExportHandle | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [info, setInfo] = useState<{ duration: number; width: number; height: number } | null>(null);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [quality, setQuality] = useState<ExportQuality>("original");
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const openVideo = useCallback(async (selected: File) => {
    try {
      const details = await readVideoInfo(selected);
      if (!details.duration) throw new Error("no duration");
      setFile(selected);
      setUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(selected);
      });
      setInfo(details);
      setStart(0);
      setEnd(details.duration);
      setCurrent(0);
      setAudioFile(null);
    } catch {
      toast.error("That file couldn't be opened. Try an MP4, MOV, WebM or MKV video.");
    }
  }, []);

  const seek = useCallback((time: number) => {
    setCurrent(time);
    if (videoRef.current) videoRef.current.currentTime = time;
  }, []);

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      if (el.currentTime < start || el.currentTime >= end) el.currentTime = start;
      void el.play();
    } else {
      el.pause();
    }
  }, [start, end]);

  const runExport = useCallback(async () => {
    if (!file) return;
    try {
      setProgress(0);
      const handle = await startExport({
        videoFile: file,
        audioFile,
        keepOriginalAudio: true,
        trimStart: start,
        trimEnd: end,
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
  }, [file, audioFile, start, end, quality]);

  const clipLength = Math.max(0, end - start);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster position="top-center" theme="dark" />

      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border px-5 py-4 sm:flex sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold tracking-tight">Cutroom</h1>
          <p className="truncate text-xs text-muted-foreground">
            {file ? `${file.name} · ${formatSize(file.size)}` : "Trim and re-score video, entirely on your device"}
          </p>
        </div>
        {file && (
          <label className="shrink-0 cursor-pointer rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground">
            Replace video
            <input
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && openVideo(e.target.files[0])}
            />
          </label>
        )}
      </header>

      {!file && (
        <main className="flex min-h-[calc(100vh-73px)] items-center justify-center px-5">
          <label className="flex w-full max-w-md cursor-pointer flex-col items-center gap-4 rounded-2xl border border-dashed border-border bg-card px-6 py-16 text-center transition-colors hover:border-accent">
            <Upload className="h-6 w-6 text-accent" />
            <div>
              <p className="text-sm font-medium">Choose a video</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Nothing is uploaded. Multi-hour, multi-gigabyte files are fine.
              </p>
            </div>
            <input
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && openVideo(e.target.files[0])}
            />
          </label>
        </main>
      )}

      {file && url && (
        <main className="mx-auto max-w-4xl space-y-5 px-5 py-6">
          <div className="overflow-hidden rounded-2xl bg-black">
            <video
              ref={videoRef}
              src={url}
              className="mx-auto max-h-[52vh] w-full object-contain"
              onTimeUpdate={(e) => {
                const el = e.currentTarget;
                if (el.currentTime > end) {
                  el.pause();
                  el.currentTime = end;
                }
                setCurrent(el.currentTime);
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onClick={togglePlay}
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <button
                onClick={togglePlay}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground transition-opacity hover:opacity-90"
                aria-label={playing ? "Pause" : "Play"}
              >
                {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </button>
              <span className="font-mono text-xs text-muted-foreground">
                {formatTime(current)} / {formatTime(info?.duration ?? 0)}
              </span>
              <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-xs text-accent">
                <Scissors className="h-3.5 w-3.5" />
                {formatTime(clipLength)}
              </span>
            </div>

            <Timeline
              duration={info?.duration ?? 0}
              current={current}
              start={start}
              end={end}
              onSeek={seek}
              onTrim={(s, e) => {
                setStart(s);
                setEnd(e);
                seek(Math.min(Math.max(current, s), e));
              }}
            />

            <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
              <button onClick={() => setStart(current)} className="hover:text-foreground">
                Start {formatTime(start)}
              </button>
              <button onClick={() => setEnd(current)} className="hover:text-foreground">
                End {formatTime(end)}
              </button>
            </div>
          </div>

          <section className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs font-medium text-muted-foreground">Audio</p>
              {audioFile ? (
                <div className="mt-3 flex items-center gap-2">
                  <Music className="h-4 w-4 shrink-0 text-accent" />
                  <span className="min-w-0 flex-1 truncate text-sm">{audioFile.name}</span>
                  <button
                    onClick={() => setAudioFile(null)}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label="Remove audio"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
                  <Music className="h-4 w-4" />
                  Add an audio track
                  <input
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={(e) => e.target.files?.[0] && setAudioFile(e.target.files[0])}
                  />
                </label>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground">
                {audioFile ? "Replaces the original sound." : "Keeps the original sound."}
              </p>
            </div>

            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs font-medium text-muted-foreground">Export quality</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {(["original", "1080p"] as const).map((option) => (
                  <button
                    key={option}
                    onClick={() => setQuality(option)}
                    className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                      quality === option
                        ? "border-accent bg-accent/15 text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {option === "original" ? "Original" : "1080p"}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {quality === "original"
                  ? info
                    ? `Copied without re-encoding · ${info.width}×${info.height}`
                    : "Copied without re-encoding"
                  : "Re-encoded to 1080p height"}
              </p>
            </div>
          </section>

          {progress === null ? (
            <button
              onClick={runExport}
              className="w-full rounded-xl bg-accent py-3 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
            >
              Export video
            </button>
          ) : (
            <div className="space-y-2 rounded-xl border border-border bg-card p-4">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Exporting… {Math.round(progress * 100)}%</span>
                <button
                  onClick={() => exportRef.current?.cancel()}
                  className="text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-200"
                  style={{ width: `${Math.max(2, progress * 100)}%` }}
                />
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
