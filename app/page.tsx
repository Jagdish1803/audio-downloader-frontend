"use client";

import { useState, useRef, useCallback } from "react";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";
const MAX_URLS = 20;

// Domains supported by yt-dlp (common ones — catches 99% of user inputs)
const SUPPORTED_HOSTS = [
  "youtube.com", "youtu.be",
  "twitter.com", "x.com",
  "instagram.com",
  "tiktok.com",
  "facebook.com", "fb.watch",
  "soundcloud.com",
  "vimeo.com",
  "dailymotion.com",
  "twitch.tv",
  "reddit.com",
  "bilibili.com",
  "nicovideo.jp",
  "rumble.com",
  "odysee.com",
  "streamable.com",
  "mixcloud.com",
  "bandcamp.com",
];

function validateUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null; // empty — no error shown
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return "Not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "URL must start with http:// or https://";
  }
  const host = url.hostname.replace(/^www\./, "");
  const supported = SUPPORTED_HOSTS.some((h) => host === h || host.endsWith("." + h));
  if (!supported) {
    return "Unsupported site — paste a link from YouTube, Instagram, TikTok, etc.";
  }
  return null; // valid
}

type ItemStatus = "idle" | "loading" | "done" | "error";
type AppPhase  = "input" | "previewing" | "downloading" | "finished";

interface UrlItem {
  id: string;
  url: string;
  status: ItemStatus;
  filename?: string;
  error?: string;
  // title preview (debounced while typing)
  title?: string;
  titleLoading?: boolean;
  // extracted info (shown before download)
  infoTitle?: string;
  infoDuration?: string;
  infoFilesize?: string | null;
  infoLoading?: boolean;
  infoError?: string;
  // object URL for the downloaded blob (single-file flow)
  blobUrl?: string;
  blobName?: string;
}

function uid() {
  return Math.random().toString(36).slice(2);
}

function StatusPill({ item }: { item: UrlItem }) {
  if (item.status === "idle") return null;
  if (item.status === "loading")
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-white/50 shrink-0">
        <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        Extracting
      </span>
    );
  if (item.status === "done")
    return (
      <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 shrink-0">
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        Done
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 text-xs font-semibold text-red-400 shrink-0" title={item.error}>
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
      Failed
    </span>
  );
}

export default function Home() {
  const [items, setItems] = useState<UrlItem[]>([{ id: uid(), url: "", status: "idle" }]);
  const [phase, setPhase] = useState<AppPhase>("input");
  const abortRef = useRef<AbortController | null>(null);
  const titleTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const isLoading    = phase === "downloading";
  const isPreviewing = phase === "previewing";
  const isFinished   = phase === "finished";
  const filledUrls   = items.filter((i) => i.url.trim());
  const isBatch      = filledUrls.length > 1;
  const hasInvalidUrl = items.some((i) => i.url.trim() && validateUrl(i.url) !== null);
  // True while at least one item is loading its info
  const anyInfoLoading = items.some((i) => i.infoLoading);

  function updateItem(id: string, patch: Partial<UrlItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function addRow() {
    if (items.length >= MAX_URLS) return;
    setItems((prev) => [...prev, { id: uid(), url: "", status: "idle" }]);
  }

  function removeRow(id: string) {
    const t = titleTimers.current.get(id);
    if (t) clearTimeout(t);
    titleTimers.current.delete(id);
    setItems((prev) => (prev.length === 1 ? prev : prev.filter((it) => it.id !== id)));
  }

  function handleUrlChange(id: string, value: string) {
    updateItem(id, { url: value, status: "idle", error: undefined, filename: undefined, title: undefined, titleLoading: false });
    const t = titleTimers.current.get(id);
    if (t) clearTimeout(t);
    titleTimers.current.delete(id);
    if (value.trim() && validateUrl(value) === null) {
      titleTimers.current.set(
        id,
        setTimeout(() => {
          fetchTitle(id, value);
          titleTimers.current.delete(id);
        }, 700)
      );
    }
  }

  async function fetchTitle(id: string, url: string) {
    updateItem(id, { titleLoading: true, title: undefined });
    try {
      const res = await fetch(`${BACKEND_URL}/api/title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (!res.ok) { updateItem(id, { titleLoading: false }); return; }
      const data = await res.json();
      updateItem(id, { title: data.title, titleLoading: false });
    } catch {
      updateItem(id, { titleLoading: false });
    }
  }

  function resetAll() {
    setItems([{ id: uid(), url: "", status: "idle" }]);
    setPhase("input");
  }

  /** Fetch /api/info for one item and store results */
  const extractInfo = useCallback(async (item: UrlItem, signal: AbortSignal) => {
    updateItem(item.id, { infoLoading: true, infoError: undefined, infoTitle: undefined });
    try {
      const res = await fetch(`${BACKEND_URL}/api/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: item.url.trim() }),
        signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not fetch info.");
      }
      const data = await res.json();
      updateItem(item.id, {
        infoLoading: false,
        infoTitle: data.title,
        infoDuration: data.duration,
        infoFilesize: data.filesize,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        updateItem(item.id, { infoLoading: false });
        return;
      }
      updateItem(item.id, {
        infoLoading: false,
        infoError: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Actually download one item and store blob URL (no auto-trigger) */
  const downloadSingle = useCallback(async (item: UrlItem, signal: AbortSignal) => {
    updateItem(item.id, { status: "loading", blobUrl: undefined, blobName: undefined });
    try {
      const res = await fetch(`${BACKEND_URL}/api/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: item.url.trim() }),
        signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Download failed.");
      }
      const disposition = res.headers.get("Content-Disposition") || "";
      const match =
        disposition.match(/filename\*=UTF-8''([^;]+)/) ||
        disposition.match(/filename="([^"]+)"/);
      const filename = match ? decodeURIComponent(match[1]) : "audio.mp3";
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      updateItem(item.id, { status: "done", filename, blobUrl, blobName: filename });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        updateItem(item.id, { status: "idle" });
        return;
      }
      updateItem(item.id, {
        status: "error",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Phase 1: fetch info for all active URLs */
  async function handleExtract(e: React.FormEvent) {
    e.preventDefault();
    if (hasInvalidUrl) return;
    const active = items.filter((i) => i.url.trim());
    if (active.length === 0) return;

    setPhase("previewing");
    // reset any old info
    setItems((prev) =>
      prev.map((it) =>
        it.url.trim()
          ? { ...it, infoTitle: undefined, infoError: undefined, infoLoading: true, status: "idle" as ItemStatus }
          : it
      )
    );

    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    await Promise.all(active.map((it) => extractInfo(it, signal)));
  }

  /** Phase 2: trigger actual downloads */
  async function handleDownload() {
    const active = items.filter((i) => i.url.trim());
    if (active.length === 0) return;

    setPhase("downloading");
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    if (active.length === 1) {
      await downloadSingle(active[0], signal);
    } else {
      try {
        setItems((prev) =>
          prev.map((it) => (it.url.trim() ? { ...it, status: "loading" as ItemStatus } : it))
        );
        const res = await fetch(`${BACKEND_URL}/api/download/batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls: active.map((i) => i.url.trim()) }),
          signal,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Batch download failed.");
        }
        const blob = await res.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "audio-bundle.zip";
        a.click();
        URL.revokeObjectURL(a.href);
        setItems((prev) =>
          prev.map((it) => (it.url.trim() ? { ...it, status: "done" as ItemStatus } : it))
        );
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          setItems((prev) => prev.map((it) => ({ ...it, status: "idle" as ItemStatus })));
          setPhase("input");
          return;
        }
        setItems((prev) =>
          prev.map((it) =>
            it.url.trim()
              ? { ...it, status: "error" as ItemStatus, error: err instanceof Error ? err.message : "Unknown error" }
              : it
          )
        );
      }
    }

    setPhase("finished");
  }

  function handleCancel() {
    abortRef.current?.abort();
    setItems((prev) => prev.map((it) => ({ ...it, status: "idle" as ItemStatus, infoLoading: false })));
    setPhase("input");
  }

  return (
    <div className="flex flex-col min-h-screen bg-black text-white">

      {/* ── Header ── */}
      <header className="sticky top-0 z-10 bg-black/95 backdrop-blur-sm border-b border-white/[0.06] px-5 pt-12 pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Logo mark */}
            <div className="w-9 h-9 rounded-xl bg-white flex items-center justify-center shrink-0">
              <svg className="w-4.5 h-4.5 text-black" style={{width:18,height:18}} fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z"/>
              </svg>
            </div>
            <div>
              <h1 className="text-[17px] font-bold tracking-tight leading-none text-white">
                Audio Extractor
              </h1>
              <p className="text-[12px] text-white/40 mt-0.5 leading-none">
                Video URL → MP3
              </p>
            </div>
          </div>
          {isFinished && (
            <button
              type="button"
              onClick={resetAll}
              className="text-[13px] font-semibold text-white/60 active:text-white transition-colors px-1 py-1"
            >
              Clear all
            </button>
          )}
        </div>
      </header>

      {/* ── Scrollable body ── */}
      <main className="flex-1 px-4 pt-5 pb-2">
        <form id="dl-form" onSubmit={handleExtract} className="flex flex-col gap-3">

          {/* URL cards */}
          {items.map((item, idx) => (
            <div
              key={item.id}
              className="rounded-2xl bg-[#111] border border-white/[0.08] overflow-hidden"
            >
              {/* Card top bar */}
              <div className="flex items-center justify-between px-4 pt-3 pb-2">
                <span className="text-[11px] font-bold uppercase tracking-widest text-white/30">
                  {items.length === 1 ? "Video URL" : `Track ${idx + 1}`}
                </span>
                <div className="flex items-center gap-3">
                  <StatusPill item={item} />
                  <button
                    type="button"
                    onClick={() => removeRow(item.id)}
                    disabled={isLoading || items.length === 1}
                    aria-label="Remove"
                    className="w-6 h-6 flex items-center justify-center rounded-full bg-white/[0.07] text-white/40 active:bg-white/[0.15] disabled:opacity-20 transition"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
              {/* Input */}
              <div className="px-4 pb-4">
                <input
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  value={item.url}
                  onChange={(e) => handleUrlChange(item.id, e.target.value)}
                  placeholder="Paste your video URL here"
                  disabled={isLoading}
                  className={`w-full bg-[#1a1a1a] border rounded-xl px-4 py-3.5 text-base text-white placeholder-white/25 focus:outline-none focus:bg-[#222] disabled:opacity-40 transition-all ${
                    item.url.trim() && validateUrl(item.url)
                      ? "border-red-500/60 focus:border-red-400"
                      : "border-white/[0.1] focus:border-white/40"
                  }`}
                />
                {/* Inline validation error */}
                {item.url.trim() && validateUrl(item.url) && (
                  <p className="mt-2 flex items-center gap-1.5 text-[12px] text-red-400 leading-snug">
                    <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12A9 9 0 113 12a9 9 0 0118 0z" />
                    </svg>
                    {validateUrl(item.url)}
                  </p>
                )}
                {/* Song title preview (while in input phase) */}
                {!isPreviewing && !isFinished && !isLoading && item.url.trim() && !validateUrl(item.url) && (
                  <>
                    {item.titleLoading && (
                      <p className="mt-2 flex items-center gap-1.5 text-[12px] text-white/30">
                        <svg className="animate-spin w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                        </svg>
                        Fetching title…
                      </p>
                    )}
                    {item.title && !item.titleLoading && (
                      <p className="mt-2 flex items-center gap-1.5 text-[12px] text-white/50 font-medium truncate">
                        <svg className="w-3 h-3 shrink-0 text-white/30" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z"/>
                        </svg>
                        {item.title}
                      </p>
                    )}
                  </>
                )}

                {/* Info preview card (after Extract Info tapped) */}
                {(isPreviewing || isLoading || isFinished) && item.url.trim() && !validateUrl(item.url) && (
                  <div className="mt-3 rounded-xl bg-[#1a1a1a] border border-white/[0.07] overflow-hidden">
                    {item.infoLoading ? (
                      <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-white/30">
                        <svg className="animate-spin w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                        </svg>
                        Fetching info…
                      </div>
                    ) : item.infoError ? (
                      <div className="px-4 py-3 text-[12px] text-red-400">{item.infoError}</div>
                    ) : (
                      <>
                        <div className="px-4 pt-3 pb-2">
                          <p className="text-[13px] font-semibold text-white leading-snug line-clamp-2">
                            {item.infoTitle || item.title || "—"}
                          </p>
                          <div className="flex items-center gap-3 mt-1.5">
                            {item.infoDuration && item.infoDuration !== "0:00" && item.infoDuration !== "NA" && (
                              <span className="flex items-center gap-1 text-[11px] text-white/40">
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <circle cx="12" cy="12" r="10" /><path strokeLinecap="round" d="M12 6v6l4 2" />
                                </svg>
                                {item.infoDuration}
                              </span>
                            )}
                            {item.infoFilesize && (
                              <span className="flex items-center gap-1 text-[11px] text-white/40">
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                                </svg>
                                ~{item.infoFilesize}
                              </span>
                            )}
                            <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/[0.07] text-white/40 font-medium">MP3</span>
                          </div>
                        </div>
                        {/* Per-item save button (single mode only) */}
                        {!isBatch && (
                          item.status === "done" && item.blobUrl ? (
                            <a
                              href={item.blobUrl}
                              download={item.blobName}
                              className="flex items-center justify-center gap-2 mx-3 mb-3 h-10 rounded-xl bg-white text-black text-[13px] font-bold active:opacity-80 transition-opacity"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                              </svg>
                              Save MP3
                            </a>
                          ) : item.status === "loading" ? (
                            <div className="flex items-center justify-center gap-2 mx-3 mb-3 h-10 rounded-xl bg-white/[0.06] text-white/30 text-[13px]">
                              <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                              </svg>
                              Preparing…
                            </div>
                          ) : item.status === "error" ? (
                            <p className="mx-3 mb-3 text-[12px] text-red-400">{item.error}</p>
                          ) : null
                        )}
                        {isBatch && item.status === "done" && <p className="mx-3 mb-3 text-[12px] text-emerald-400">✓ Done</p>}
                        {isBatch && item.status === "error" && <p className="mx-3 mb-3 text-[12px] text-red-400">{item.error}</p>}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Add link — only in input phase */}
          {!isPreviewing && !isLoading && !isFinished && items.length < MAX_URLS && (
            <button
              type="button"
              onClick={addRow}
              className="w-full h-13 flex items-center justify-center gap-2 rounded-2xl border border-dashed border-white/[0.15] text-[13px] font-medium text-white/40 active:bg-white/[0.04] active:text-white/60 transition-all"
              style={{height: 52}}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Add another link
              {items.length > 1 && (
                <span className="text-white/25 text-[11px]">{items.length}/{MAX_URLS}</span>
              )}
            </button>
          )}

          {/* Success banner (batch finished) */}
          {isFinished && isBatch && (
            <div className="flex items-center gap-3 rounded-2xl bg-emerald-950/60 border border-emerald-800/50 px-4 py-4">
              <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="text-[13px] font-semibold text-emerald-400 leading-none">{filledUrls.length} tracks downloaded</p>
                <p className="text-[11px] text-emerald-700 mt-1">Saved as audio-bundle.zip</p>
              </div>
            </div>
          )}

          {/* Footer */}
          <p className="text-center text-[11px] text-white/20 pt-2 leading-relaxed">
            YouTube · Twitter/X · Instagram · TikTok &amp;{" "}
            <a
              href="https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-white/35 underline active:text-white/60"
            >
              1000+ more sites
            </a>
          </p>

          {/* Spacer for fixed footer */}
          <div className="h-28" />
        </form>
      </main>

      {/* ── Fixed bottom bar ── */}
      <div className="fixed bottom-0 inset-x-0 z-20 px-4 pt-3 bg-gradient-to-t from-black via-black/95 to-transparent pb-safe">
        <div className="flex gap-2.5 pb-4">

          {/* STATE: input → show Extract Info button */}
          {phase === "input" && (
            <button
              type="submit"
              form="dl-form"
              disabled={filledUrls.length === 0 || hasInvalidUrl}
              className="flex-1 flex items-center justify-center gap-2 h-14 rounded-2xl font-bold text-[15px] tracking-tight transition-all"
              style={{
                background: filledUrls.length === 0 || hasInvalidUrl ? "rgba(255,255,255,0.08)" : "#ffffff",
                color:      filledUrls.length === 0 || hasInvalidUrl ? "rgba(255,255,255,0.25)" : "#000000",
              }}
            >
              <svg className="w-4.5 h-4.5" style={{width:18,height:18}} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Extract Info
            </button>
          )}

          {/* STATE: previewing → show Download button */}
          {phase === "previewing" && (
            <>
              <button
                type="button"
                onClick={handleDownload}
                disabled={anyInfoLoading}
                className="flex-1 flex items-center justify-center gap-2 h-14 rounded-2xl font-bold text-[15px] tracking-tight transition-all"
                style={{
                  background: anyInfoLoading ? "rgba(255,255,255,0.08)" : "#ffffff",
                  color:      anyInfoLoading ? "rgba(255,255,255,0.25)" : "#000000",
                }}
              >
                {anyInfoLoading ? (
                  <>
                    <svg className="animate-spin w-4.5 h-4.5" style={{width:18,height:18}} fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    Fetching info…
                  </>
                ) : (
                  <>
                    <svg className="w-4.5 h-4.5" style={{width:18,height:18}} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    {isBatch ? `Download ${filledUrls.length} tracks as ZIP` : "Download MP3"}
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => setPhase("input")}
                disabled={anyInfoLoading}
                className="h-14 px-5 rounded-2xl bg-white/[0.08] text-[13px] font-semibold text-white/60 active:bg-white/[0.14] transition-all disabled:opacity-30"
              >
                Back
              </button>
            </>
          )}

          {/* STATE: downloading */}
          {phase === "downloading" && (
            <>
              <button
                type="button"
                disabled
                className="flex-1 flex items-center justify-center gap-2 h-14 rounded-2xl font-bold text-[15px] tracking-tight"
                style={{ background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.25)" }}
              >
                <svg className="animate-spin w-4.5 h-4.5" style={{width:18,height:18}} fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                {isBatch ? `Downloading ${filledUrls.length} tracks…` : "Downloading…"}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                className="h-14 px-5 rounded-2xl bg-white/[0.08] text-[13px] font-semibold text-white/60 active:bg-white/[0.14] transition-all"
              >
                Cancel
              </button>
            </>
          )}

          {/* STATE: finished */}
          {phase === "finished" && (
            <button
              type="button"
              onClick={resetAll}
              className="flex-1 flex items-center justify-center gap-2 h-14 rounded-2xl font-bold text-[15px] tracking-tight"
              style={{ background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.6)" }}
            >
              Start over
            </button>
          )}

        </div>
      </div>

    </div>
  );
}
