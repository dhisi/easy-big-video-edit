import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type ConversionVideoOptions,
} from "mediabunny";

export type ExportQuality = "original" | "1080p";

export type ExportOptions = {
  videoFile: File;
  audioFile: File | null;
  /** Placement of the audio file on the video timeline. */
  audioClip?: { offset: number; inPoint: number; outPoint: number } | null;
  keepOriginalAudio: boolean;
  trimStart: number;
  trimEnd: number;
  quality: ExportQuality;
  onProgress?: (progress: number) => void;
};

export type ExportHandle = {
  done: Promise<{ savedToDisk: boolean; fileName: string }>;
  cancel: () => void;
};

type SavePicker = (opts: unknown) => Promise<FileSystemFileHandle>;

function suggestedName(name: string) {
  const base = name.replace(/\.[^.]+$/, "");
  return `${base}-edited.mp4`;
}

export function supportsStreamingSave() {
  return typeof window !== "undefined" && "showSaveFilePicker" in window;
}

/** Reads media lazily and writes the result straight to disk, so file size is not limited by memory. */
export async function startExport(options: ExportOptions): Promise<ExportHandle> {
  const fileName = suggestedName(options.videoFile.name);

  let writable: FileSystemWritableFileStream | null = null;
  if (supportsStreamingSave()) {
    const picker = (window as unknown as { showSaveFilePicker: SavePicker }).showSaveFilePicker;
    const handle = await picker({
      suggestedName: fileName,
      types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
    });
    writable = await handle.createWritable();
  }

  const target = writable
    ? new StreamTarget(
        new WritableStream({
          async write(chunk: { data: Uint8Array<ArrayBuffer>; position: number }) {
            await writable!.write({
              type: "write",
              position: chunk.position,
              data: chunk.data as unknown as BufferSource,
            });
          },
        }),
        { chunked: true },
      )
    : new BufferTarget();

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: writable ? false : "in-memory" }),
    target,
  });

  const videoInput = new Input({
    source: new BlobSource(options.videoFile),
    formats: ALL_FORMATS,
  });

  const video: ConversionVideoOptions = options.quality === "1080p" ? { height: 1080 } : {};
  const clipDuration = Math.max(0.05, options.trimEnd - options.trimStart);

  const videoConversion = await Conversion.init({
    input: videoInput,
    output,
    video,
    audio: { discard: Boolean(options.audioFile) || !options.keepOriginalAudio },
    trim: { start: options.trimStart, end: options.trimEnd },
    composable: true,
  });

  let audioConversion: Conversion | null = null;
  const clip = options.audioClip;
  if (options.audioFile && clip) {
    // Portion of the audio clip that overlaps the exported video range (in video time).
    const clipEnd = clip.offset + (clip.outPoint - clip.inPoint);
    const from = Math.max(options.trimStart, clip.offset);
    const to = Math.min(options.trimEnd, clipEnd, options.trimStart + clipDuration);
    if (to - from > 0.05) {
      const audioInput = new Input({
        source: new BlobSource(options.audioFile),
        formats: ALL_FORMATS,
      });
      const delay = from - options.trimStart;
      audioConversion = await Conversion.init({
        input: audioInput,
        output,
        video: { discard: true },
        audio:
          delay > 0.001
            ? {
                process: (sample) => {
                  sample.setTimestamp(sample.timestamp + delay);
                  return sample;
                },
              }
            : {},
        trim: { start: clip.inPoint + (from - clip.offset), end: clip.inPoint + (to - clip.offset) },
        composable: true,
      });
    }
  }

  let videoProgress = 0;
  let audioProgress = 0;
  const report = () => {
    const total = audioConversion ? (videoProgress * 0.9 + audioProgress * 0.1) : videoProgress;
    options.onProgress?.(Math.min(1, total));
  };
  videoConversion.onProgress = (p) => {
    videoProgress = p;
    report();
  };
  if (audioConversion) {
    audioConversion.onProgress = (p) => {
      audioProgress = p;
      report();
    };
  }

  let canceled = false;

  const done = (async () => {
    try {
      await output.start();
      await Promise.all([
        videoConversion.execute(),
        audioConversion ? audioConversion.execute() : Promise.resolve(),
      ]);
      await output.finalize();

      if (writable) {
        await writable.close();
      } else {
        const buffer = (output.target as BufferTarget).buffer;
        if (!buffer) throw new Error("Export produced no data");
        const url = URL.createObjectURL(new Blob([buffer], { type: "video/mp4" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
      options.onProgress?.(1);
      return { savedToDisk: Boolean(writable), fileName };
    } catch (error) {
      try {
        await writable?.abort();
      } catch {
        /* ignore */
      }
      if (canceled) throw new Error("canceled");
      throw error;
    }
  })();

  return {
    done,
    cancel: () => {
      canceled = true;
      void videoConversion.cancel();
      void audioConversion?.cancel();
    },
  };
}

export async function readVideoInfo(file: File) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const duration = await input.computeDuration();
  const track = await input.getPrimaryVideoTrack();
  return {
    duration,
    width: track?.displayWidth ?? 0,
    height: track?.displayHeight ?? 0,
  };
}

export async function readMediaDuration(file: File) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  return input.computeDuration();
}
