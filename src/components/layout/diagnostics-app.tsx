import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DiagLine } from "@/lib/diagnostics";
import { cn } from "@/lib/utils";

const TAG_COLORS: Record<string, string> = {
  boot: "text-sky-400",
  "stream-server": "text-sky-400",
  stream: "text-amber-400",
  ytdlp: "text-rose-400",
};

function tagColor(tag: string): string {
  return TAG_COLORS[tag] ?? "text-emerald-400";
}

function mergeBacklog(backlog: DiagLine[], live: DiagLine[]): DiagLine[] {
  const seen = new Set<string>();
  const merged: DiagLine[] = [];
  for (const l of [...backlog, ...live]) {
    const key = `${l.at}|${l.tag}|${l.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(l);
  }
  merged.sort((a, b) => a.at - b.at);
  return merged.slice(-4000);
}

function formatClock(atMs: number): string {
  const d = new Date(atMs);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${d
    .getMilliseconds()
    .toString()
    .padStart(3, "0")}`;
}

export default function DiagnosticsApp() {
  const [lines, setLines] = useState<DiagLine[]>([]);
  const [query, setQuery] = useState("");
  const [pinnedToEnd, setPinnedToEnd] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void invoke<DiagLine[]>("diag_backlog").then((backlog) => {
      if (!cancelled) setLines((prev) => mergeBacklog(backlog, prev));
    });
    const unlisten = listen<DiagLine>("diag-line", (event) => {
      setLines((prev) => [...prev, event.payload].slice(-4000));
    });
    return () => {
      cancelled = true;
      void unlisten.then((un) => un());
    };
  }, []);

  useEffect(() => {
    if (!pinnedToEnd) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, pinnedToEnd]);

  const filtered = query.trim()
    ? lines.filter(
        (l) =>
          l.text.toLowerCase().includes(query.toLowerCase()) ||
          l.tag.toLowerCase().includes(query.toLowerCase()),
      )
    : lines;

  return (
    <div className="flex h-screen w-screen flex-col bg-neutral-950 text-neutral-200">
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <span className="text-sm font-medium text-neutral-300">
          YTubic diagnostics
        </span>
        <span className="text-xs text-neutral-500">
          {filtered.length}/{lines.length} lines
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter by text or tag"
          className="ml-3 h-7 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
        />
        <label className="flex items-center gap-1 text-xs text-neutral-400">
          <input
            type="checkbox"
            checked={pinnedToEnd}
            onChange={(e) => setPinnedToEnd(e.target.checked)}
          />
          follow
        </label>
        <button
          type="button"
          onClick={() => setLines([])}
          className="h-7 rounded border border-neutral-700 px-2 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          clear
        </button>
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          setPinnedToEnd(atEnd);
        }}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-5"
      >
        {filtered.map((l, i) => (
          <div key={i} className="flex gap-2 whitespace-pre-wrap break-all">
            <span className="shrink-0 text-neutral-600">
              {formatClock(l.at)}
            </span>
            <span className={cn("shrink-0", tagColor(l.tag))}>
              [{l.tag}]
            </span>
            <span className="text-neutral-300">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
