import React, { useEffect, useState } from "react";

/** Minimal Party DJ — YouTube Search ONLY (no Firebase yet) */

function useLocalSetting(key, initial = "") {
  const [v, setV] = useState(() => localStorage.getItem(key) ?? initial);
  useEffect(() => { localStorage.setItem(key, v ?? ""); }, [key, v]);
  return [v, setV];
}

export default function App() {
  const [ytKey, setYtKey] = useLocalSetting("pdj_yt_key", "");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");

  async function runSearch() {
    setError("");
    setResults([]);
    if (!ytKey) { setError("Add your YouTube Data API key first (Settings)."); return; }
    if (!search.trim()) return;

    try {
      setLoading(true);
      const url = new URL("https://www.googleapis.com/youtube/v3/search");
      url.searchParams.set("part", "snippet");
      url.searchParams.set("type", "video");
      url.searchParams.set("maxResults", "12");
      url.searchParams.set("q", search.trim());
      url.searchParams.set("key", ytKey);

      const res = await fetch(url);
      const data = await res.json();
      const items = (data?.items || []).map(it => ({
        id: it?.id?.videoId || "",
        title: it?.snippet?.title || "Untitled",
        thumb: it?.snippet?.thumbnails?.medium?.url || "",
      })).filter(x => x.id);
      setResults(items);
      if (!items.length) setError("No results. Try a different search.");
    } catch (e) {
      console.error(e);
      setError("YouTube search failed. Check the API key or quota.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-40 backdrop-blur bg-slate-950/70 border-b border-slate-800">
        <div className="max-w-6xl mx-auto px-4 py-3">
          <span className="text-xl font-bold">Party DJ (YouTube search only)</span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 grid lg:grid-cols-3 gap-6">
        {/* Left: Search + Results */}
        <section className="lg:col-span-2 space-y-4">
          <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
            <div className="flex gap-2 flex-wrap items-center">
              <input
                className="px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 flex-1 min-w-[240px] outline-none"
                placeholder="Search YouTube songs…"
                value={search}
                onChange={(e)=>setSearch(e.target.value)}
                onKeyDown={(e)=>{ if(e.key==='Enter') runSearch(); }}
              />
              <button
                className="px-3 py-2 rounded-xl bg-white text-slate-900 font-semibold"
                onClick={runSearch}
                disabled={loading}
              >
                {loading ? "Searching…" : "Search"}
              </button>
            </div>

            {error && <div className="mt-3 text-sm text-rose-300">{error}</div>}

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
              {(results || []).map(v => (
                <div key={v.id} className="p-2 bg-slate-900/60 rounded-xl border border-slate-800">
                  <img src={v.thumb} alt="" className="w-full h-32 object-cover rounded" />
                  <div className="mt-2 text-sm font-semibold line-clamp-2">{v.title}</div>
                  <div className="mt-2 flex gap-2">
                    <button
                      className="px-2 py-1 rounded-lg border border-slate-700"
                      onClick={()=>setSelectedId(v.id)}
                    >
                      Play
                    </button>
                    <a
                      className="px-2 py-1 rounded-lg border border-slate-700"
                      href={`https://www.youtube.com/watch?v=${v.id}`} target="_blank" rel="noreferrer"
                    >
                      Open
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {selectedId && (
            <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-lg font-bold">Preview player</h2>
                <button className="text-sm underline" onClick={()=>setSelectedId("")}>Close</button>
              </div>
              <div className="aspect-video w-full bg-black rounded overflow-hidden">
                <iframe
                  src={`https://www.youtube.com/embed/${selectedId}?autoplay=1`}
                  title="YouTube player"
                  className="w-full h-full"
                  allow="autoplay; encrypted-media"
                  referrerPolicy="strict-origin-when-cross-origin"
                />
              </div>
            </div>
          )}
        </section>

        {/* Right: Settings */}
        <section className="space-y-4">
          <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
            <h2 className="text-lg font-bold mb-2">Settings</h2>
            <label className="text-sm opacity-80">YouTube Data API key</label>
            <input
              className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 outline-none"
              placeholder="AIza…"
              value={ytKey}
              onChange={(e)=>setYtKey(e.target.value)}
            />
            <p className="mt-3 text-xs opacity-70">
              Don’t have a key? In Google Cloud: APIs & Services → Library → enable
              <b> YouTube Data API v3</b> → Credentials → Create API key.
            </p>
          </div>
          <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 text-xs opacity-70">
            Next we’ll add the shared queue + voting (Firebase).
          </div>
        </section>
      </main>
    </div>
  );
}
