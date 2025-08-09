import React, { useEffect, useMemo, useRef, useState } from "react";

/** Party DJ — YouTube Search + Firebase Queue (safe, with Reset button) **/

// ---------- helpers ----------
function useLocalSetting(key, initial = "") {
  const [v, setV] = useState(() => localStorage.getItem(key) ?? initial);
  useEffect(() => { try { localStorage.setItem(key, v ?? ""); } catch {} }, [key, v]);
  return [v, setV];
}

const firebaseCdn = {
  app: "https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js",
  db:  "https://www.gstatic.com/firebasejs/10.12.5/firebase-database-compat.js",
};
const YT_IFRAME_API = "https://www.youtube.com/iframe_api";

function useScript(src) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!src) { setLoaded(false); return; } // do nothing if not provided
    let el = document.querySelector(`script[src="${src}"]`);
    if (!el) {
      el = document.createElement("script");
      el.src = src;
      el.async = true;
      el.onload = () => setLoaded(true);
      el.onerror = () => setLoaded(false);
      document.head.appendChild(el);
    } else {
      setLoaded(true);
    }
  }, [src]);
  return loaded;
}

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

/** Accepts either the raw JSON {…} OR a full snippet like:
 * const firebaseConfig = { ... };
 * returns a parsed object or null
 */
function parseFirebaseJson(str) {
  if (!str) return null;
  const t = String(str).trim();
  let jsonText = t;
  if (!t.startsWith("{")) {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a !== -1 && b !== -1) jsonText = t.slice(a, b + 1);
  }
  try { return JSON.parse(jsonText); } catch { return null; }
}

// ---------- app ----------
export default function App() {
  // YouTube search state
  const [ytKey, setYtKey] = useLocalSetting("pdj_yt_key", "");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [previewId, setPreviewId] = useState("");

  async function runSearch() {
    setError("");
    setResults([]);
    if (!ytKey) { setError("Add your YouTube Data API key in Settings."); return; }
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

  // Firebase config (accept snippet or JSON)
  const [fbConfig, setFbConfig] = useLocalSetting("pdj_fb_config", "");
  const fbCfg = useMemo(() => parseFirebaseJson(fbConfig), [fbConfig]);
  const needsFirebase = !fbCfg; // only enable queue when JSON is valid

  // Load Firebase scripts ONLY when config is valid
  const fbAppSrc = needsFirebase ? null : firebaseCdn.app;
  const fbDbSrc  = needsFirebase ? null : firebaseCdn.db;
  const firebaseReady = useScript(fbAppSrc) && useScript(fbDbSrc);

  const [db, setDb] = useState(null);
  useEffect(() => {
    if (needsFirebase) return;
    if (!firebaseReady) return;
    if (!fbCfg || !window.firebase) return;

    try {
      // Avoid touching .length; try app() and init if needed
      try {
        window.firebase.app();
      } catch {
        if (typeof window.firebase.initializeApp === "function") {
          window.firebase.initializeApp(fbCfg);
        }
      }

      if (typeof window.firebase.database === "function") {
        setDb(window.firebase.database());
      }
    } catch (e) { console.warn("Firebase init failed", e); }
  }, [firebaseReady, fbCfg, needsFirebase]);

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
    if (!db) { alert("Add Firebase config in Settings first."); return; }
    const safe = (code || roomCode || "").trim().toUpperCase();
    if (!safe) { alert("Enter room code"); return; }
    setRoomCode(safe);

    const base = db.ref(`rooms/${safe}`);
    rQueue.current = base.child("queue");
    rNow.current   = base.child("now");
    rCtl.current   = base.child("control");

    rQueue.current.on("value", s => {
      try {
        const v = (typeof s?.val === "function" ? s.val() : {}) || {};
        const items = Array.isArray(v) ? v.filter(Boolean) : Object.values(v).filter(Boolean);
        items.sort((a,b)=>(b.votes||0)-(a.votes||0));
        setQueue(items || []);
      } catch (e) { setQueue([]); }
    });
    rNow.current.on("value", s => {
      try { setNowPlaying((typeof s?.val==="function" ? s.val() : null) || null); }
      catch { setNowPlaying(null); }
    });
    rCtl.current.on("value", s => setPaused(!!(((s && s.val && s.val())||{}).paused)));

    setConnected(true);
  };
  const createRoom = () => joinRoom(randomId(4));

  const addToQueue = async (video) => {
    if (!rQueue.current) { alert("Join a room first."); return; }
    const id = `yt:${video.id}`.replace(/[.#$\[\]]/g,'_');
    const item = { id, provider:'youtube', title: video.title, thumb: video.thumb, addedBy: displayName, votes:1, ts: Date.now() };
    try { await rQueue.current.child(id).set(item); } catch(e){ console.warn(e); }
  };
  const vote = async (id, delta=1) => {
    if (!rQueue.current) return;
    const safeId = (id||"").replace(/[.#$\[\]]/g,'_');
    try {
      await rQueue.current.child(safeId).transaction(it => {
        if (!it) return it;
        it.votes = (it.votes||0) + delta;
        return it;
      });
    } catch (e) { console.warn(e); }
  };
  const startNext = async () => {
    if (!isHost || !rQueue.current || !rNow.current) return;
    const next = [...(queue||[])].sort((a,b)=>(b.votes||0)-(a.votes||0))[0];
    if (!next) return;
    try {
      await rNow.current.set({ id: next.id, title: next.title, thumb: next.thumb, provider:'youtube', startedAt: Date.now() });
      await rQueue.current.child(next.id.replace(/[.#$\[\]]/g,'_')).remove();
      await rCtl.current.update({ paused:false });
    } catch(e){ console.warn(e); }
  };
  const togglePause = async () => {
    if (!isHost || !rCtl.current) return;
    try { await rCtl.current.transaction(ctl => { ctl=ctl||{}; ctl.paused=!ctl.paused; return ctl; }); } catch(e){}
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
    if (needsFirebase) return;
    const url = new URL(window.location.href);
    const r = url.searchParams.get("room");
    if (r && !connected) joinRoom(r);
  }, [connected, needsFirebase]);

  // Reset button handler
  function resetApp() {
    if (!window.confirm('Clear saved keys (YouTube + Firebase) and reset the app?')) return;
    const keys = ['pdj_fb_config', 'pdj_yt_key', 'pdj_is_host', 'pdj_room', 'pdj_name'];
    try { keys.forEach(k => localStorage.removeItem(k)); } catch {}
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
            {needsFirebase && <div className="mt-3 text-sm text-rose-300">Queue features disabled until you paste valid Firebase config (Settings).</div>}
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
                            onClick={()=>addToQueue(v)} disabled={!connected || needsFirebase}>
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

          {/* Inline preview player (not the host player) */}
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
            <label className="text-sm opacity-80">YouTube Data API key</label>
            <input className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 outline-none"
                   placeholder="AIza…" value={ytKey} onChange={(e)=>setYtKey(e.target.value)} />
            <label className="text-sm opacity-80 mt-4 block">Firebase config (JSON or snippet)</label>
            <textarea className="mt-1 w-full px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 outline-none"
                      rows={6}
                      placeholder='Paste either { "apiKey":"...", ... } OR the full snippet that contains it'
                      value={fbConfig} onChange={(e)=>setFbConfig(e.target.value)} />
            <p className="mt-2 text-xs opacity-70">
              Realtime Database must be enabled. You can paste the raw JSON or the entire
              <i> const firebaseConfig = {"{"} ... {"}"};</i> snippet — I’ll extract it safely.
            </p>
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
