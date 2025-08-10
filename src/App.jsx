import React, { useEffect, useMemo, useRef, useState } from "react";

/** Party DJ — YouTube + Firebase Queue (ESM CDN + baked Firebase config + Reset) **/

// ---- quick reset by URL: add ?reset=1 ----
(function hardResetViaUrl() {
  try {
    const qs = new URLSearchParams(window.location.search);
    if (qs.get("reset") === "1") {
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
      const finish = () => {
        const clean = window.location.origin + window.location.pathname + "?v=" + Date.now();
        window.location.replace(clean);
      };
      if (window.indexedDB?.databases) {
        indexedDB.databases()
          .then(dbs => Promise.all(dbs.map(d => d?.name && indexedDB.deleteDatabase(d.name))))
          .finally(finish);
      } else finish();
    }
  } catch {}
})();

// ---------- helpers ----------
function useLocalSetting(key, initial = "") {
  const [v, setV] = useState(() => localStorage.getItem(key) ?? initial);
  useEffect(() => { try { localStorage.setItem(key, v ?? ""); } catch {} }, [key, v]);
  return [v, setV];
}

const YT_IFRAME_API = "https://www.youtube.com/iframe_api";

function useYouTubeApi() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (window.YT?.Player) { setReady(true); return; }
    const tag = document.createElement("script");
    tag.src = YT_IFRAME_API;
    const first = document.getElementsByTagName("script")[0];
    first.parentNode.insertBefore(tag, first);
    window.onYouTubeIframeAPIReady = () => setReady(true);
  }, []);
  return ready;
}

const randomId = (n=4)=>Math.random().toString(36).slice(2,2+n).toUpperCase();

/** Accepts raw JSON or a snippet containing it, tolerates curly quotes */
function parseFirebaseJson(str) {
  if (!str) return null;
  const t = String(str).trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  let jsonText = t.slice(a, b + 1);
  jsonText = jsonText
    .replace(/[\u201C-\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201B\u2032\u2035]/g, "'");
  try { return JSON.parse(jsonText); } catch {}
  try { return (new Function("return (" + jsonText + ")"))(); } catch {}
  return null;
}

/** ✅ Bake your Firebase config here so guests don't paste it */
const DEFAULT_FB_CFG = {
  "apiKey": "AIzaSyBqKvl9Hh47gg-9vf82bh64Wh9PJm-PfRI",
  "authDomain": "party-dj-6ccc4.firebaseapp.com",
  "databaseURL": "https://party-dj-6ccc4-default-rtdb.firebaseio.com",
  "projectId": "party-dj-6ccc4",
  "storageBucket": "party-dj-6ccc4.firebasestorage.app",
  "messagingSenderId": "265535993182",
  "appId": "1:265535993182:web:bec84b53875055ca8dcbcf",
  "measurementId": "G-58NT1F2QZM"
};

// ---------- app ----------
export default function App() {
  // YouTube
  const [ytKey, setYtKey] = useLocalSetting("pdj_yt_key", "");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [previewId, setPreviewId] = useState("");

  async function runSearch() {
    setError("");
    setResults([]);
    if (!ytKey) { setError("Only the DJ needs a YouTube key to search. Guests can still vote."); return; }
    if (!search.trim()) return;
    try {
      setLoading(true);
      const url = new URL("https://www.googleapis.com/youtube/v3/search");
      url.searchParams.set("part","snippet");
      url.searchParams.set("type","video");
      url.searchParams.set("maxResults","12");
      url.searchParams.set("q", search.trim());
      url.searchParams.set("key", ytKey);
      const res = await fetch(url);
      const data = await res.json();
      const items = (data?.items||[]).map(it=>({
        id: it?.id?.videoId || "",
        title: it?.snippet?.title || "Untitled",
        thumb: it?.snippet?.thumbnails?.medium?.url || ""
      })).filter(x=>x.id);
      setResults(items);
      if (!items.length) setError("No results. Try a different search.");
    } catch (e) {
      console.error(e);
      setError("YouTube search failed. Check the key or quota.");
    } finally { setLoading(false); }
  }

  // Firebase config
  const [fbConfig, setFbConfig] = useLocalSetting("pdj_fb_config", "");
  const fbCfg = useMemo(() => parseFirebaseJson(fbConfig) || DEFAULT_FB_CFG, [fbConfig]);
  const needsFirebase = !fbCfg; // will be false because DEFAULT_FB_CFG exists

  // Firebase (ESM CDN modules) — loaded only when config is present (it is)
  const [fdb, setFdb] = useState(null); // { db, ref, child, onValue, set, update, runTransaction, remove }
  useEffect(() => {
    let cancelled = false;
    async function init() {
      if (!fbCfg) return;
      try {
        const appMod = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js");
        const dbMod  = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js");
        const apps = appMod.getApps();
        const app = apps.length ? apps[0] : appMod.initializeApp(fbCfg);
        const db = dbMod.getDatabase(app);
        if (!cancelled) {
          setFdb({
            db,
            ref: dbMod.ref,
            child: dbMod.child,
            onValue: dbMod.onValue,
            set: dbMod.set,
            update: dbMod.update,
            runTransaction: dbMod.runTransaction,
            remove: dbMod.remove,
          });
        }
      } catch (e) {
        console.warn("Firebase ESM init failed:", e);
        if (!cancelled) setFdb(null);
      }
    }
    init();
    return () => { cancelled = true; };
  }, [fbCfg]);

  // Rooms / queue
  const [roomCode, setRoomCode] = useLocalSetting("pdj_room", "");
  const [displayName, setDisplayName] = useLocalSetting("pdj_name", "Guest"+randomId(3));
  const [isHost, setIsHost] = useState(localStorage.getItem("pdj_is_host")==="1");
  const [connected, setConnected] = useState(false);
  const [queue, setQueue] = useState([]);
  const [nowPlaying, setNowPlaying] = useState(null);
  const [paused, setPaused] = useState(false);

  const rQueue = useRef(null), rNow = useRef(null), rCtl = useRef(null);

  const joinRoom = async (code) => {
    if (!fdb?.db) { alert("Firebase not ready. Reload the page."); return; }
    const { db, ref, child, onValue } = fdb;
    const safe = (code || roomCode || "").trim().toUpperCase();
    if (!safe) { alert("Enter room code"); return; }
    setRoomCode(safe);

    const baseRef = ref(db, `rooms/${safe}`);
    const qRef = child(baseRef, "queue");
    const nRef = child(baseRef, "now");
    const cRef = child(baseRef, "control");
    rQueue.current = qRef; rNow.current = nRef; rCtl.current = cRef;

    onValue(qRef, (s) => {
      try {
        const v = s?.val() || {};
        const items = Array.isArray(v) ? v.filter(Boolean) : Object.values(v).filter(Boolean);
        items.sort((a,b)=>(b.votes||0)-(a.votes||0));
        setQueue(items || []);
      } catch { setQueue([]); }
    });
    onValue(nRef, (s) => { try { setNowPlaying(s?.val() || null); } catch { setNowPlaying(null); } });
    onValue(cRef, (s) => { try { setPaused(!!((s?.val()||{}).paused)); } catch { setPaused(false); } });

    setConnected(true);
  };
  const createRoom = () => joinRoom(randomId(4));

  const addToQueue = async (video) => {
    if (!rQueue.current) { alert("Join a room first."); return; }
    const { set, child } = fdb;
    const id = `yt:${video.id}`.replace(/[.#$\[\]]/g,'_');
    const item = { id, provider:'youtube', title: video.title, thumb: video.thumb, addedBy: displayName, votes:1, ts: Date.now() };
    try { await set(child(rQueue.current, id), item); } catch(e){ console.warn(e); }
  };
  const vote = async (id, delta=1) => {
    if (!rQueue.current) return;
    const { runTransaction, child } = fdb;
    const safeId = (id||"").replace(/[.#$\[\]]/g,'_');
    try {
      await runTransaction(child(rQueue.current, safeId), (it) => {
        if (!it) return it;
        it.votes = (it.votes||0) + delta;
        return it;
      });
    } catch (e) { console.warn(e); }
  };
  const startNext = async () => {
    if (!isHost || !rQueue.current || !rNow.current) return;
    const { set, remove, child } = fdb;
    const next = [...(queue||[])].sort((a,b)=>(b.votes||0)-(a.votes||0))[0];
    if (!next) return;
    try {
      await set(rNow.current, { id: next.id, title: next.title, thumb: next.thumb, provider:'youtube', startedAt: Date.now() });
      await remove(child(rQueue.current, next.id.replace(/[.#$\[\]]/g,'_')));
    } catch(e){ console.warn(e); }
  };
  const togglePause = async () => {
    if (!isHost || !rCtl.current) return;
    const { runTransaction } = fdb;
    try { await runTransaction(rCtl.current, (ctl)=>{ ctl=ctl||{}; ctl.paused=!ctl.paused; return ctl; }); } catch(e){}
  };

  // Host playback (YouTube)
  const ytReady = useYouTubeApi();
  const ytRef = useRef(null);
  const ytPlayer = useRef(null);
  useEffect(() => {
    if (!ytReady || !isHost) return;
    if (ytPlayer.current) return;
    try {
      ytPlayer.current = new window.YT.Player(ytRef.current, {
        height: "0", width: "0", videoId: "",
        playerVars: { autoplay: 0 },
        events: {
          onStateChange: (e) => {
            if (e.data === window.YT.PlayerState.ENDED) startNext();
          },
        },
      });
    } catch {}
  }, [ytReady, isHost]);
  useEffect(() => {
    if (!ytPlayer.current || !isHost) return;
    if (!nowPlaying?.id) return;
    const vid = (nowPlaying.id||"").split(":").pop();
    try {
      ytPlayer.current.loadVideoById(vid);
      paused ? ytPlayer.current.pauseVideo() : ytPlayer.current.playVideo();
    } catch {}
  }, [nowPlaying, paused, isHost]);
  useEffect(() => {
    if (!ytPlayer.current || !isHost) return;
    try { paused ? ytPlayer.current.pauseVideo() : ytPlayer.current.playVideo(); } catch {}
  }, [paused, isHost]);

  // Shareable room link & auto-join
  const roomUrl = useMemo(() => {
    const u = new URL(window.location.href);
    u.searchParams.set("room", roomCode || "");
    return u.toString();
  }, [roomCode]);
  useEffect(() => {
    if (!fdb) return;
    const url = new URL(window.location.href);
    const r = url.searchParams.get("room");
    if (r && !connected) joinRoom(r);
  }, [connected, fdb]);

  // Reset button
  function resetApp() {
    if (!window.confirm('Clear saved keys (YouTube + Firebase) and reset the app?')) return;
    ['pdj_fb_config','pdj_yt_key','pdj_is_host','pdj_room','pdj_name'].forEach(k=>{ try{localStorage.removeItem(k);}catch{} });
    try { localStorage.clear(); } catch {}
    location.reload();
  }

  // ---------- UI ----------
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-40 backdrop-blur bg-slate-950/70 border-b border-slate-800">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <span className="text-xl font-bold">Party DJ</span>
          <span className="text-xs ml-auto opacity-70">Pair to your Bluetooth speaker first.</span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 grid lg:grid-cols-3 gap-6">
        {/* Left: Join + Queue */}
        <section className="lg:col-span-2 space-y-6">
          <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <input className="px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700"
                     placeholder="Your name" value={displayName}
                     onChange={(e)=>setDisplayName(e.target.value)} />
              <input className="px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 w-28"
                     placeholder="ROOM" value={roomCode}
                     onChange={(e)=>setRoomCode(e.target.value.toUpperCase())} />
              <button className="px-3 py-2 rounded-xl bg-white text-slate-900 font-semibold" onClick={()=>joinRoom()}>
                Join
              </button>
              <button className="px-3 py-2 rounded-xl border border-slate-700" onClick={createRoom}>
                Create
              </button>
              <label className="ml-auto inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isHost}
                  onChange={(e)=>{ setIsHost(e.target.checked); localStorage.setItem("pdj_is_host", e.target.checked?"1":"0"); }} />
                I'm the DJ (plays audio)
              </label>
            </div>
            {connected && <div className="mt-3 text-sm opacity-80">Share this room: <a className="underline break-all" href={roomUrl}>{roomUrl}</a></div>}
          </div>

          {/* Search + Results */}
          <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
            <div className="flex gap-2 flex-wrap items-center">
              <input className="px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 flex-1 min-w-[240px] outline-none"
                     placeholder="Search YouTube songs…" value={search}
                     onChange={(e)=>setSearch(e.target.value)}
                     onKeyDown={(e)=>{ if(e.key==='Enter') runSearch(); }} />
              <button className="px-3 py-2 rounded-xl bg-white text-slate-900 font-semibold"
                      onClick={runSearch} disabled={loading}>
                {loading ? "Searching…" : "Search"}
              </button>
            </div>
            {error && <div className="mt-3 text-sm text-rose-300">{error}</div>}
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
              {(results||[]).map(v=>(
                <div key={v.id} className="p-2 bg-slate-900/60 rounded-xl border border-slate-800">
                  <img src={v.thumb} alt="" className="w-full h-32 object-cover rounded" />
                  <div className="mt-2 text-sm font-semibold line-clamp-2">{v.title}</div>
                  <div className="mt-2 flex gap-2">
                    <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={()=>setPreviewId(v.id)}>Play</button>
                    <button className="px-2 py-1 rounded-lg border border-slate-700"
                            onClick={()=>addToQueue(v)} disabled={!connected}>
                      Add to Queue
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Queue */}
          <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-lg font-bold">Queue</h2>
              {isHost && <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={startNext}>Start next</button>}
              {isHost && <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={togglePause}>{paused?"Resume":"Pause"}</button>}
            </div>
            {nowPlaying && (
              <div className="mb-4 p-3 bg-slate-900/60 rounded-xl border border-slate-800">
                <div className="text-sm opacity-70">Now playing</div>
                <div className="flex items-center gap-3 mt-2">
                  <img src={nowPlaying.thumb} className="w-24 h-14 rounded object-cover" />
                  <div className="font-semibold line-clamp-2">{nowPlaying.title}</div>
                </div>
              </div>
            )}
            <ul className="space-y-2">
              {(queue||[]).map(item=>(
                <li key={item.id} className="p-2 bg-slate-900/60 rounded-xl border border-slate-800 flex items-center gap-3">
                  <img src={item.thumb} className="w-16 h-10 rounded object-cover" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium line-clamp-2">{item.title}</div>
                    <div className="text-xs opacity-60">Added by {item.addedBy}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={()=>vote(item.id,+1)}>▲</button>
                    <span className="w-6 text-center">{item.votes||0}</span>
                    <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={()=>vote(item.id,-1)}>▼</button>
                  </div>
                </li>
              ))}
              {(!queue || queue.length===0) && <div className="text-sm opacity-70">Queue is empty. Search and add some tracks!</div>}
            </ul>
          </div>

          {/* Inline preview player */}
          {previewId && (
            <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-lg font-bold">Preview player</h2>
                <button className="text-sm underline" onClick={()=>setPreviewId("")}>Close</button>
              </div>
              <div className="aspect-video w-full bg-black rounded overflow-hidden">
                <iframe
                  src={`https://www.youtube.com/embed/${previewId}?autoplay=1`}
                  title="YouTube player"
                  className="w-full h-full"
                  allow="autoplay; encrypted-media"
                  referrerPolicy="strict-origin-when-cross-origin"
                />
              </div>
            </div>
          )}
        </section>

        {/* Right: Settings & Host player */}
        <section className="space-y-6">
          <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
            <h2 className="text-lg font-bold mb-2">Settings</h2>
            <label className="text-sm opacity-80">YouTube Data API key (DJ only)</label>
            <input className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 outline-none"
                   placeholder="Only DJ needs this — AIza…" value={ytKey} onChange={(e)=>setYtKey(e.target.value)} />
            <details className="mt-3">
              <summary className="cursor-pointer text-sm opacity-80">Firebase config (advanced)</summary>
              <textarea className="mt-2 w-full px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 outline-none"
                        rows={6}
                        placeholder="(Optional) Paste JSON to override the baked config"
                        value={fbConfig} onChange={(e)=>setFbConfig(e.target.value)} />
              <p className="mt-2 text-xs opacity-70">Guests don’t need to paste anything.</p>
            </details>
            <button
              className="mt-3 px-3 py-2 rounded-xl border border-slate-700 hover:bg-slate-800/50 text-sm"
              onClick={resetApp}
            >
              Reset app (clear saved settings)
            </button>
          </div>

          {isHost && (
            <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
              <h2 className="text-lg font-bold mb-2">Host Player</h2>
              <div className="text-xs opacity-70 mb-2">Keep this tab open. Audio routes to your paired Bluetooth speaker.</div>
              <div ref={ytRef} />
              <button className="px-3 py-2 rounded-xl bg-white text-slate-900 font-semibold w-full mt-3" onClick={startNext}>
                Play top voted
              </button>
            </div>
          )}
        </section>
      </main>

      <footer className="max-w-6xl mx-auto px-4 pb-8 text-xs opacity-60">
        Built for quick parties. Respect copyright & venue licensing.
      </footer>
    </div>
  );
}
