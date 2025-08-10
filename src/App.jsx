import React, { useEffect, useMemo, useRef, useState } from "react";

/** Party DJ — presence (active listeners) + dynamic vote-to-skip (50%)
 *  Keeps all previous features:
 *   - DJ Skip / Clear, pause/resume
 *   - Duplicate prevention + per-user cap
 *   - Serverless YouTube search (guests can search)
 *   - QR share, preview player
 *   - Baked Firebase config (guests don’t paste)
 */

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

// ---- knobs ----
const MAX_SONGS_PER_USER = 3;
const SEARCH_COOLDOWN_MS = 800;
const SEARCH_WINDOW_MS = 60_000;
const SEARCH_MAX_PER_WINDOW = 15;
// Skip threshold = ceil(activeListeners * 0.5)
const SKIP_THRESHOLD = (active) => Math.max(1, Math.ceil(active * 0.5));
// Presence: consider clients active if their heartbeat < 60s old
const PRESENCE_STALE_MS = 60_000;
const HEARTBEAT_MS = 15_000;

// ---- small helpers ----
function useLocalSetting(key, initial = "") {
  const [v, setV] = useState(() => localStorage.getItem(key) ?? initial);
  useEffect(() => { try { localStorage.setItem(key, v ?? ""); } catch {} }, [key, v]);
  return [v, setV];
}
function useToast() {
  const [msg, setMsg] = useState("");
  function show(m, _type="info", ms=1800){ setMsg(m); clearTimeout(show._t); show._t=setTimeout(()=>setMsg(""), ms); }
  return { msg, show };
}
const YT_IFRAME_API = "https://www.youtube.com/iframe_api";
function useYouTubeApi() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (window.YT?.Player) { setReady(true); return; }
    const tag = document.createElement("script"); tag.src = YT_IFRAME_API;
    const first = document.getElementsByTagName("script")[0];
    first.parentNode.insertBefore(tag, first);
    window.onYouTubeIframeAPIReady = () => setReady(true);
  }, []);
  return ready;
}
const randomId = (n=4)=>Math.random().toString(36).slice(2,2+n).toUpperCase();
function parseFirebaseJson(str) {
  if (!str) return null;
  const t = String(str).trim(); const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  let jsonText = t.slice(a, b+1)
    .replace(/[\u201C-\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201B\u2032\u2035]/g, "'");
  try { return JSON.parse(jsonText); } catch {}
  try { return (new Function("return ("+jsonText+")"))(); } catch {}
  return null;
}

/** ✅ Baked Firebase config */
const DEFAULT_FB_CFG = {
  apiKey: "AIzaSyBqKvl9Hh47gg-9vf82bh64Wh9PJm-PfRI",
  authDomain: "party-dj-6ccc4.firebaseapp.com",
  databaseURL: "https://party-dj-6ccc4-default-rtdb.firebaseio.com",
  projectId: "party-dj-6ccc4",
  storageBucket: "party-dj-6ccc4.firebasestorage.app",
  messagingSenderId: "265535993182",
  appId: "1:265535993182:web:bec84b53875055ca8dcbcf",
  measurementId: "G-58NT1F2QZM"
};

export default function App(){
  const toast = useToast();

  // Search (serverless) + client rate-limit
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]); const [loading, setLoading] = useState(false);
  const [error, setError] = useState(""); const [previewId, setPreviewId] = useState("");

  function canSearchNow(){
    const k="pdj_search_times"; const now=Date.now();
    let list=[]; try{ list=JSON.parse(localStorage.getItem(k)||"[]"); }catch{}
    list=list.filter(t=> now-t <= SEARCH_WINDOW_MS);
    if(list.length && now-list[list.length-1] < SEARCH_COOLDOWN_MS){ toast.show("Searching too fast—give it a sec."); return false; }
    if(list.length >= SEARCH_MAX_PER_WINDOW){ toast.show("You’ve hit the search limit. Try again in a minute.", 2200); return false; }
    list.push(now); try{ localStorage.setItem(k, JSON.stringify(list)); }catch{}; return true;
  }
  async function runSearch(){
    if(!search.trim()) return; if(!canSearchNow()) return;
    setError(""); setResults([]); setLoading(true);
    try{
      const res = await fetch(`/.netlify/functions/youtube-search?q=${encodeURIComponent(search.trim())}`);
      if(!res.ok) throw new Error("Search function error");
      const data = await res.json();
      const items = (data?.items||[]).map(it=>({
        id: it?.id?.videoId || "",
        title: it?.snippet?.title || "Untitled",
        thumb: it?.snippet?.thumbnails?.medium?.url || ""
      })).filter(x=>x.id);
      setResults(items);
      if(!items.length) setError("No results. Try a different search.");
    } catch(e){ console.error(e); setError("Search failed. (Server function)."); }
    finally{ setLoading(false); }
  }

  // Firebase config (allow override but default baked)
  const [fbConfig, setFbConfig] = useLocalSetting("pdj_fb_config", "");
  const fbCfg = useMemo(()=> parseFirebaseJson(fbConfig) || DEFAULT_FB_CFG, [fbConfig]);

  // Firebase ESM imports
  const [fdb, setFdb] = useState(null); // { db, ref, child, onValue, set, update, runTransaction, remove, onDisconnect }
  useEffect(()=>{ let cancelled=false;
    async function init(){
      if(!fbCfg) return;
      try{
        const appMod = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js");
        const dbMod  = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js");
        const apps = appMod.getApps(); const app = apps.length? apps[0]: appMod.initializeApp(fbCfg);
        const db = dbMod.getDatabase(app);
        if(!cancelled){
          setFdb({
            db,
            ref: dbMod.ref, child: dbMod.child, onValue: dbMod.onValue,
            set: dbMod.set, update: dbMod.update, runTransaction: dbMod.runTransaction, remove: dbMod.remove,
            onDisconnect: dbMod.onDisconnect
          });
        }
      }catch(e){ console.warn("Firebase ESM init failed:", e); if(!cancelled) setFdb(null); }
    }
    init(); return ()=>{ cancelled=true; };
  },[fbCfg]);

  // Room + presence
  const [roomCode, setRoomCode] = useLocalSetting("pdj_room", "");
  const [displayName, setDisplayName] = useLocalSetting("pdj_name", "Guest"+randomId(3));
  const [clientId] = useLocalSetting("pdj_client", randomId(6));
  const [isHost, setIsHost] = useState(localStorage.getItem("pdj_is_host")==="1");
  const [connected, setConnected] = useState(false);
  const [queue, setQueue] = useState([]); const [nowPlaying, setNowPlaying] = useState(null);
  const [paused, setPaused] = useState(false);
  const [activeCount, setActiveCount] = useState(0); // 👥 active listeners (presence)
  const requiredSkip = SKIP_THRESHOLD(activeCount);

  // skip vote map
  const [skipMap, setSkipMap] = useState({}); const skipCount = Object.keys(skipMap||{}).length;
  const meVoted = !!skipMap[displayName];

  // refs to DB paths
  const rQueue = useRef(null), rNow = useRef(null), rCtl = useRef(null), rSkip = useRef(null), rPresence = useRef(null), rPresenceEntry = useRef(null);
  const hbTimer = useRef(null);

  const roomUrl = useMemo(()=>{ const u=new URL(window.location.href); if(roomCode) u.searchParams.set("room", roomCode); else u.searchParams.delete("room"); return u.toString(); },[roomCode]);

  const [showQr, setShowQr] = useState(false);
  const qrSrc = useMemo(()=> `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(roomUrl || window.location.href)}`, [roomUrl]);

  const copyLink = async ()=>{ try{ await navigator.clipboard.writeText(roomUrl); toast.show("Link copied!"); } catch{ prompt("Copy this link", roomUrl); } };

  const joinRoom = async (code)=>{
    if(!fdb?.db){ alert("Firebase not ready. Reload the page."); return; }
    const { db, ref, child, onValue, set, update, remove, onDisconnect } = fdb;

    const safe = (code||roomCode||"").trim().toUpperCase(); if(!safe){ alert("Enter room code"); return; }
    setRoomCode(safe);

    const baseRef = ref(db, `rooms/${safe}`);
    const qRef = child(baseRef, "queue");
    const nRef = child(baseRef, "now");
    const cRef = child(baseRef, "control");
    const sRef = child(baseRef, "skipVotes");
    const pRef = child(baseRef, "presence");

    rQueue.current=qRef; rNow.current=nRef; rCtl.current=cRef; rSkip.current=sRef; rPresence.current=pRef;

    // listeners
    onValue(qRef, (s)=>{ try{ const v=s?.val()||{}; const items = Array.isArray(v)? v.filter(Boolean): Object.values(v).filter(Boolean); items.sort((a,b)=>(b.votes||0)-(a.votes||0)); setQueue(items||[]);}catch{ setQueue([]);} });
    onValue(nRef, (s)=>{ try{ setNowPlaying(s?.val()||null);}catch{ setNowPlaying(null);} });
    onValue(cRef, (s)=>{ try{ setPaused(!!((s?.val()||{}).paused)); }catch{ setPaused(false);} });
    onValue(sRef, (s)=>{ try{ setSkipMap(s?.val()||{});}catch{ setSkipMap({}); } });

    // presence: write my entry + heartbeat + count active
    try{
      const meRef = child(pRef, clientId);
      rPresenceEntry.current = meRef;
      await set(meRef, { name: displayName || "Guest", ts: Date.now() });
      try { onDisconnect(meRef).remove(); } catch {}
      // heartbeat
      if(hbTimer.current) clearInterval(hbTimer.current);
      hbTimer.current = setInterval(()=> { update(meRef, { name: displayName || "Guest", ts: Date.now() }); }, HEARTBEAT_MS);

      // count active
      onValue(pRef, (s)=>{
        try{
          const all = s?.val() || {};
          const now = Date.now();
          const active = Object.values(all).filter(p => (now - (p?.ts||0)) <= PRESENCE_STALE_MS);
          setActiveCount(active.length);
        }catch{ setActiveCount(0); }
      });
    }catch(e){ console.warn("presence error", e); }

    setConnected(true);
  };

  // If name changes after joining, update my presence.name once
  useEffect(()=>{ (async ()=>{
    if(!fdb || !rPresenceEntry.current) return;
    try{ await fdb.update(rPresenceEntry.current, { name: displayName || "Guest" }); }catch{}
  })(); }, [displayName, fdb]);

  const createRoom = ()=> joinRoom(randomId(4));
  const sanitizeId = (id="")=> id.replace(/[.#$\[\]]/g,'_');

  // add to queue with dup guard + cap
  const addToQueue = async (video)=>{
    if(!rQueue.current){ alert("Join a room first."); return; }
    const id = `yt:${video.id}`;
    const dup = (queue||[]).some(q=>q.id===id) || (nowPlaying?.id===id);
    if(dup){ await vote(id,+1); toast.show("Already in queue — upvoted."); return; }
    const mine = (queue||[]).filter(q=> (q.addedBy||"")===displayName).length;
    if(mine >= MAX_SONGS_PER_USER){ toast.show(`Limit reached: max ${MAX_SONGS_PER_USER} in queue.`); return; }
    try{
      await fdb.set(fdb.child(rQueue.current, sanitizeId(id)), { id, provider:'youtube', title: video.title, thumb: video.thumb, addedBy: displayName, votes:1, ts: Date.now() });
    }catch(e){ console.warn(e); toast.show("Couldn’t add. Try again."); }
  };

  const vote = async (id, delta=1)=>{
    if(!rQueue.current) return;
    try{
      await fdb.runTransaction(fdb.child(rQueue.current, sanitizeId(id)), it=>{ if(!it) return it; it.votes=(it.votes||0)+delta; return it; });
    }catch(e){ console.warn(e); }
  };

  // DJ controls
  const startNext = async ()=>{
    if(!isHost||!rQueue.current||!rNow.current) return;
    const next = [...(queue||[])].sort((a,b)=>(b.votes||0)-(a.votes||0))[0];
    if(!next){ toast.show("Queue is empty."); return; }
    try{
      await fdb.set(rNow.current, { id: next.id, title: next.title, thumb: next.thumb, provider:'youtube', startedAt: Date.now() });
      await fdb.remove(fdb.child(rQueue.current, sanitizeId(next.id)));
      if(rSkip.current) await fdb.remove(rSkip.current); // clear skip votes
    }catch(e){ console.warn(e); }
  };
  const clearQueue = async ()=>{
    if(!isHost||!rQueue.current) return;
    if(!confirm("Clear the entire queue?")) return;
    try{
      for(const it of (queue||[])){ await fdb.remove(fdb.child(rQueue.current, sanitizeId(it.id))); }
      toast.show("Queue cleared.");
    }catch(e){ console.warn(e); toast.show("Couldn’t clear queue."); }
  };
  const togglePause = async ()=>{
    if(!isHost||!rCtl.current) return;
    try{ await fdb.runTransaction(rCtl.current, ctl=>{ ctl=ctl||{}; ctl.paused=!ctl.paused; return ctl; }); }catch(e){}
  };

  // Vote-to-skip
  const toggleSkipVote = async ()=>{
    if(!rSkip.current) return;
    const key = displayName || "Guest";
    try{
      if(meVoted) await fdb.remove(fdb.child(rSkip.current, key));
      else await fdb.set(fdb.child(rSkip.current, key), true);
    }catch(e){ console.warn(e); }
  };

  // Auto-skip when votes >= 50% of active listeners (host)
  useEffect(()=>{ if(!isHost) return; if(!rSkip.current) return;
    if(skipCount >= requiredSkip && nowPlaying){ startNext(); }
  }, [skipCount, requiredSkip, isHost]); // eslint-disable-line

  // Host playback (YouTube)
  const ytReady = useYouTubeApi(); const ytRef = useRef(null); const ytPlayer = useRef(null);
  useEffect(()=>{ if(!ytReady||!isHost) return; if(ytPlayer.current) return;
    try{
      ytPlayer.current = new window.YT.Player(ytRef.current, {
        height:"0", width:"0", videoId:"",
        playerVars:{ autoplay:0 },
        events:{ onStateChange:(e)=>{ if(e.data===window.YT.PlayerState.ENDED) startNext(); } }
      });
    }catch{}
  },[ytReady,isHost]);
  useEffect(()=>{ if(!ytPlayer.current||!isHost) return; if(!nowPlaying?.id) return;
    const vid = (nowPlaying.id||"").split(":").pop();
    try{ ytPlayer.current.loadVideoById(vid); paused? ytPlayer.current.pauseVideo(): ytPlayer.current.playVideo(); }catch{}
  },[nowPlaying,paused,isHost]);
  useEffect(()=>{ if(!ytPlayer.current||!isHost) return; try{ paused? ytPlayer.current.pauseVideo(): ytPlayer.current.playVideo(); }catch{} },[paused,isHost]);

  // Auto-join if ?room=XXXX
  useEffect(()=>{ if(!fdb) return; const url=new URL(window.location.href); const r=url.searchParams.get("room"); if(r && !connected) joinRoom(r); },[connected,fdb]);

  function resetApp(){
    if(!confirm("Clear saved data and reset the app?")) return;
    ['pdj_fb_config','pdj_is_host','pdj_room','pdj_name','pdj_client','pdj_search_times'].forEach(k=>{ try{localStorage.removeItem(k);}catch{} });
    try{ localStorage.clear(); }catch{}; location.reload();
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {toast.msg && <div className="fixed top-3 left-1/2 -translate-x-1/2 z-50 px-3 py-2 rounded-xl border border-slate-700 bg-slate-900/90 text-sm">{toast.msg}</div>}

      <header className="sticky top-0 z-40 backdrop-blur bg-slate-950/70 border-b border-slate-800">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <span className="text-xl font-bold">Party DJ</span>
          <span className="text-xs ml-auto opacity-70">
            Pair to your Bluetooth speaker first. <span className="ml-3">👥 {activeCount} listening</span>
          </span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 grid lg:grid-cols-3 gap-6">
        {/* Join */}
        <section className="lg:col-span-2 space-y-6">
          <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <input className="px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700" placeholder="Your name" value={displayName} onChange={(e)=>setDisplayName(e.target.value)} />
              <input className="px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 w-28" placeholder="ROOM" value={roomCode} onChange={(e)=>setRoomCode(e.target.value.toUpperCase())} />
              <button className="px-3 py-2 rounded-xl bg-white text-slate-900 font-semibold" onClick={()=>joinRoom()}>Join</button>
              <button className="px-3 py-2 rounded-xl border border-slate-700" onClick={createRoom}>Create</button>
              <button className="px-3 py-2 rounded-xl border border-slate-700" onClick={()=>setShowQr(true)}>Show QR</button>
              <label className="ml-auto inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isHost} onChange={(e)=>{ setIsHost(e.target.checked); localStorage.setItem("pdj_is_host", e.target.checked?"1":"0"); }} />
                I'm the DJ (plays audio)
              </label>
            </div>
            {connected && <div className="mt-3 text-sm opacity-80">Share this room: <a className="underline break-all" href={roomUrl}>{roomUrl}</a></div>}
          </div>

          {/* Search */}
          <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
            <div className="flex gap-2 flex-wrap items-center">
              <input className="px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 flex-1 min-w-[240px] outline-none" placeholder="Search YouTube songs…" value={search} onChange={(e)=>setSearch(e.target.value)} onKeyDown={(e)=>{ if(e.key==='Enter') runSearch(); }} />
              <button className="px-3 py-2 rounded-xl bg-white text-slate-900 font-semibold" onClick={runSearch} disabled={loading}>{loading? "Searching…":"Search"}</button>
            </div>
            {error && <div className="mt-3 text-sm text-rose-300">{error}</div>}
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
              {(results||[]).map(v=>(
                <div key={v.id} className="p-2 bg-slate-900/60 rounded-2xl border border-slate-800">
                  <img src={v.thumb} alt="" className="w-full h-32 object-cover rounded" />
                  <div className="mt-2 text-sm font-semibold line-clamp-2">{v.title}</div>
                  <div className="mt-2 flex gap-2">
                    <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={()=>setPreviewId(v.id)}>Play</button>
                    <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={()=>addToQueue(v)} disabled={!connected}>Add to Queue</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Queue */}
          <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-lg font-bold">Queue</h2>
              {isHost && <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={startNext}>Play top voted / Skip</button>}
              {isHost && <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={togglePause}>{paused? "Resume":"Pause"}</button>}
              {isHost && <button className="px-2 py-1 rounded-lg border border-slate-700 ml-auto" onClick={clearQueue}>Clear queue</button>}
            </div>

            {nowPlaying && (
              <div className="mb-4 p-3 bg-slate-900/60 rounded-2xl border border-slate-800">
                <div className="flex items-center gap-3 justify-between">
                  <div className="flex items-center gap-3">
                    <img src={nowPlaying.thumb} className="w-24 h-14 rounded object-cover" />
                    <div>
                      <div className="text-sm opacity-70">Now playing</div>
                      <div className="font-semibold line-clamp-2">{nowPlaying.title}</div>
                      <div className="mt-2">
                        <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={toggleSkipVote}>
                          {meVoted ? "Undo skip vote" : "Vote to Skip"} ({skipCount}/{requiredSkip})
                        </button>
                        <div className="text-xs opacity-70 mt-1">Skip triggers at 50% of active listeners.</div>
                      </div>
                    </div>
                  </div>
                  <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={()=>setShowQr(true)}>QR</button>
                </div>
              </div>
            )}

            <ul className="space-y-2">
              {(queue||[]).map(item=>(
                <li key={item.id} className="p-2 bg-slate-900/60 rounded-2xl border border-slate-800 flex items-center gap-3">
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
                </li
