import React, { useEffect, useMemo, useRef, useState } from "react";

/** Party DJ — baked Firebase, serverless YouTube search, QR, + DJ tools + Vote-to-Skip
 *  Already has:
 *   - DJ Skip & Clear Queue
 *   - Duplicate prevention (adds vote instead)
 *   - Client search rate limit
 *   - Max songs per user in queue
 *   - Big QR on Now Playing
 *   - Firebase baked config
 *   - Serverless YouTube search (guests can search)
 *  NEW in this version:
 *   - Vote-to-Skip for everyone; DJ auto-skips when threshold reached
 **/

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

// ---------- limits / knobs ----------
const MAX_SONGS_PER_USER = 3;
const SEARCH_COOLDOWN_MS = 800;
const SEARCH_WINDOW_MS = 60_000;
const SEARCH_MAX_PER_WINDOW = 15;

// vote-to-skip: require this many votes to skip current song
const SKIP_VOTES_REQUIRED = 3;

// ---------- helpers ----------
function useLocalSetting(key, initial = "") {
  const [v, setV] = useState(() => localStorage.getItem(key) ?? initial);
  useEffect(() => { try { localStorage.setItem(key, v ?? ""); } catch {} }, [key, v]);
  return [v, setV];
}

function useToast() {
  const [msg, setMsg] = useState("");
  function show(m, _type="info", ms=1800){ setMsg(m); window.clearTimeout((show)._t); (show)._t=setTimeout(()=>setMsg(""), ms); }
  return { msg, show };
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

function parseFirebaseJson(str) {
  if (!str) return null;
  const t = String(str).trim();
  const a = t.indexOf("{"); const b = t.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  let jsonText = t.slice(a, b + 1);
  jsonText = jsonText
    .replace(/[\u201C-\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201B\u2032\u2035]/g, "'");
  try { return JSON.parse(jsonText); } catch {}
  try { return (new Function("return (" + jsonText + ")"))(); } catch {}
  return null;
}

/** ✅ Baked Firebase config so guests don't paste anything */
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
  const toast = useToast();

  // YouTube search (via serverless function) + client rate limit
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [previewId, setPreviewId] = useState("");

  function canSearchNow() {
    const k = "pdj_search_times";
    const now = Date.now();
    let list = [];
    try { list = JSON.parse(localStorage.getItem(k) || "[]"); } catch {}
    list = list.filter(t => now - t <= SEARCH_WINDOW_MS);
    if (list.length && now - list[list.length-1] < SEARCH_COOLDOWN_MS) {
      toast.show("Searching too fast—give it a sec."); return false;
    }
    if (list.length >= SEARCH_MAX_PER_WINDOW) {
      toast.show("You’ve hit the search limit. Try again in a minute.", 2200); return false;
    }
    list.push(now);
    try { localStorage.setItem(k, JSON.stringify(list)); } catch {}
    return true;
  }

  async function runSearch() {
    if (!search.trim()) return;
    if (!canSearchNow()) return;
    setError(""); setResults([]);
    try {
      setLoading(true);
      const res = await fetch(`/.netlify/functions/youtube-search?q=${encodeURIComponent(search.trim())}`);
      if (!res.ok) throw new Error("Search function error");
      const data = await res.json();
      const items = (data?.items||[]).map(it=>({
        id: it?.id?.videoId || "",
        title: it?.snippet?.title || "Untitled",
        thumb: it?.snippet?.thumbnails?.medium?.url || ""
      })).filter(x=>x.id);
      setResults(items);
      if (!items.length) setError("No results. Try a different search.");
    } catch (e) {
      console.error(e); setError("Search failed. (Server function).");
    } finally { setLoading(false); }
  }

  // Firebase config (baked, but allow override)
  const [fbConfig, setFbConfig] = useLocalSetting("pdj_fb_config", "");
  const fbCfg = useMemo(() => parseFirebaseJson(fbConfig) || DEFAULT_FB_CFG, [fbConfig]);

  // Firebase (ESM)
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

  // vote-to-skip state
  const [skipMap, setSkipMap] = useState({}); // { "User A": true, ... }
  const skipCount = Object.keys(skipMap || {}).length;
  const meVoted = !!skipMap[displayName];

  const rQueue = useRef(null), rNow = useRef(null), rCtl = useRef(null), rSkip = useRef(null);

  const roomUrl = useMemo(() => {
    const u = new URL(window.location.href);
    if (roomCode) u.searchParams.set("room", roomCode);
    else u.searchParams.delete("room");
    return u.toString();
  }, [roomCode]);

  const [showQr, setShowQr] = useState(false);
  const qrSrc = useMemo(() => {
    const url = roomUrl || window.location.href;
    return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(url)}`;
  }, [roomUrl]);

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(roomUrl); toast.show("Link copied!"); }
    catch { prompt("Copy this link", roomUrl); }
  };

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
    const sRef = child(baseRef, "skipVotes");

    rQueue.current = qRef; rNow.current = nRef; rCtl.current = cRef; rSkip.current = sRef;

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
    onValue(sRef, (s) => { try { setSkipMap(s?.val() || {}); } catch { setSkipMap({}); } });

    setConnected(true);
  };
  const createRoom = () => joinRoom(randomId(4));

  const sanitizeId = (id="") => id.replace(/[.#$\[\]]/g,'_');

  // add to queue with dup guard + cap
  const addToQueue = async (video) => {
    if (!rQueue.current) { alert("Join a room first."); return; }
    const id = `yt:${video.id}`;
    const dup = (queue || []).some(q => q.id === id) || (nowPlaying?.id === id);
    if (dup) {
      await vote(id, +1);
      toast.show("Already in queue — upvoted.");
      return;
    }
    const mine = (queue || []).filter(q => (q.addedBy || "") === displayName).length;
    if (mine >= MAX_SONGS_PER_USER) { toast.show(`Limit reached: max ${MAX_SONGS_PER_USER} in queue.`); return; }

    const { set, child } = fdb;
    const safeId = sanitizeId(id);
    const item = { id, provider:'youtube', title: video.title, thumb: video.thumb, addedBy: displayName, votes:1, ts: Date.now() };
    try { await set(child(rQueue.current, safeId), item); }
    catch(e){ console.warn(e); toast.show("Couldn’t add. Try again."); }
  };

  const vote = async (id, delta=1) => {
    if (!rQueue.current) return;
    const { runTransaction, child } = fdb;
    const safeId = sanitizeId(id);
    try {
      await runTransaction(child(rQueue.current, safeId), (it) => {
        if (!it) return it;
        it.votes = (it.votes||0) + delta;
        return it;
      });
    } catch (e) { console.warn(e); }
  };

  // DJ controls
  const { set, remove, child, runTransaction } = fdb || {};
  const startNext = async () => {
    if (!isHost || !rQueue.current || !rNow.current) return;
    const next = [...(queue||[])].sort((a,b)=>(b.votes||0)-(a.votes||0))[0];
    if (!next) { toast.show("Queue is empty."); return; }
    try {
      await set(rNow.current, { id: next.id, title: next.title, thumb: next.thumb, provider:'youtube', startedAt: Date.now() });
      await remove(child(rQueue.current, sanitizeId(next.id)));
      if (rSkip.current) await remove(rSkip.current); // clear skip votes on next
    } catch(e){ console.warn(e); }
  };

  const clearQueue = async () => {
    if (!isHost || !rQueue.current) return;
    if (!window.confirm("Clear the entire queue?")) return;
    try {
      for (const it of (queue||[])) {
        await remove(child(rQueue.current, sanitizeId(it.id)));
      }
      toast.show("Queue cleared.");
    } catch (e) { console.warn(e); toast.show("Couldn’t clear queue."); }
  };

  const togglePause = async () => {
    if (!isHost || !rCtl.current) return;
    try { await runTransaction(rCtl.current, (ctl)=>{ ctl=ctl||{}; ctl.paused=!ctl.paused; return ctl; }); } catch(e){}
  };

  // Vote-to-skip actions
  const toggleSkipVote = async () => {
    if (!rSkip.current) return;
    try {
      const key = displayName || "Guest";
      if (meVoted) {
        await remove(child(rSkip.current, key));
      } else {
        await set(child(rSkip.current, key), true);
      }
    } catch (e) { console.warn(e); }
  };

  // Auto-skip when threshold reached (host only)
  useEffect(() => {
    if (!isHost) return;
    if (!rSkip.current) return;
    if (skipCount >= SKIP_VOTES_REQUIRED) {
      startNext(); // startNext clears skip votes
    }
  }, [skipCount, isHost]); // eslint-disable-line

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

  // Auto-join if ?room=XXXX
  useEffect(() => {
    if (!fdb) return;
    const url = new URL(window.location.href);
    const r = url.searchParams.get("room");
    if (r && !connected) joinRoom(r);
  }, [connected, fdb]);

  function resetApp() {
    if (!window.confirm('Clear saved data and reset the app?')) return;
    ['pdj_fb_config','pdj_is_host','pdj_room','pdj_name','pdj_search_times'].forEach(k=>{ try{localStorage.removeItem(k);}catch{} });
    try { localStorage.clear(); } catch {}
    location.reload();
  }

  // ---------- UI ----------
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {toast.msg && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-50 px-3 py-2 rounded-xl border border-slate-700 bg-slate-900/90 text-sm">
          {toast.msg}
        </div>
      )}

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
              <button className="px-3 py-2 rounded-xl border border-slate-700" onClick={()=>setShowQr(true)}>
                Show QR
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
