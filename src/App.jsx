import React, { useEffect, useMemo, useRef, useState } from "react";

/** Party DJ — session name/room; guest view hides DJ controls
 *  - Guests (opening a link with ?guest=1 — which the QR uses) do NOT see:
 *      • “I’m the DJ (plays audio)”
 *      • The “Share this room” link
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
const PRESENCE_STALE_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const SKIP_THRESHOLD = (active) => Math.max(1, Math.ceil(active * 0.5)); // 50%

// ---- helpers ----
function useLocalSetting(key, initial = "") {
  const [v, setV] = useState(() => localStorage.getItem(key) ?? initial);
  useEffect(() => { try { localStorage.setItem(key, v ?? ""); } catch {} }, [key, v]);
  return [v, setV];
}
function useSessionSetting(key, initial = "") {
  const [v, setV] = useState(() => sessionStorage.getItem(key) ?? initial);
  useEffect(() => { try { sessionStorage.setItem(key, v ?? ""); } catch {} }, [key, v]);
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
function fmtTime(ts){
  try{ const d=new Date(ts); const hh=String(d.getHours()).padStart(2,"0"); const mm=String(d.getMinutes()).padStart(2,"0"); return `${hh}:${mm}`; }catch{return"";}
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

  // Detect guest view from URL (?guest=1). The QR we show includes this.
  const isGuestView = useMemo(() => {
    try { return new URL(window.location.href).searchParams.get("guest") === "1"; }
    catch { return false; }
  }, []);

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
  const [fdb, setFdb] = useState(null);
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
            onDisconnect: dbMod.onDisconnect, push: dbMod.push
          });
        }
      }catch(e){ console.warn("Firebase ESM init failed:", e); if(!cancelled) setFdb(null); }
    }
    init(); return ()=>{ cancelled=true; };
  },[fbCfg]);

  // Room + presence (SESSION for name/room; persistent id for presence)
  const [roomCode, setRoomCode] = useSessionSetting("pdj_room", "");
  const [displayName, setDisplayName] = useSessionSetting("pdj_name", "Guest"+randomId(3));
  const [clientId] = useLocalSetting("pdj_client", randomId(6));
  const [isHost, setIsHost] = useState(false); // not persisted
  const [connected, setConnected] = useState(false);
  const [queue, setQueue] = useState([]); const [nowPlaying, setNowPlaying] = useState(null);
  const [paused, setPaused] = useState(false);

  const [activeCount, setActiveCount] = useState(0);
  const [activeNames, setActiveNames] = useState([]);
  const requiredSkip = SKIP_THRESHOLD(activeCount);

  const [skipMap, setSkipMap] = useState({}); const skipCount = Object.keys(skipMap||{}).length;
  const meVoted = !!skipMap[displayName];

  // Chat
  const [chat, setChat] = useState([]);
  const [chatText, setChatText] = useState("");
  const chatBoxRef = useRef(null);

  // refs to DB paths
  const rQueue = useRef(null), rNow = useRef(null), rCtl = useRef(null), rSkip = useRef(null);
  const rPresence = useRef(null), rPresenceEntry = useRef(null), rChat = useRef(null);
  const hbTimer = useRef(null);

  // Room URL (host) and Guest URL (adds ?guest=1)
  const roomUrl = useMemo(()=>{ const u=new URL(window.location.href); if(roomCode) u.searchParams.set("room", roomCode); else u.searchParams.delete("room"); u.searchParams.delete("guest"); return u.toString(); },[roomCode]);
  const guestRoomUrl = useMemo(()=>{ const u=new URL(roomUrl); u.searchParams.set("guest","1"); return u.toString(); },[roomUrl]);

  const [showQr, setShowQr] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const qrSrc = useMemo(()=> `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(guestRoomUrl || window.location.href)}`, [guestRoomUrl]);

  const copyLink = async ()=>{ const link = guestRoomUrl; try{ await navigator.clipboard.writeText(link); toast.show("Link copied!"); } catch{ prompt("Copy this link", link); } };

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
    const chRef = child(baseRef, "chat");

    rQueue.current=qRef; rNow.current=nRef; rCtl.current=cRef; rSkip.current=sRef; rPresence.current=pRef; rChat.current=chRef;

    // queue / now / control / skipVotes
    onValue(qRef, (s)=>{ try{ const v=s?.val()||{}; const items = Array.isArray(v)? v.filter(Boolean): Object.values(v).filter(Boolean); items.sort((a,b)=>(b.votes||0)-(a.votes||0)); setQueue(items||[]);}catch{ setQueue([]);} });
    onValue(nRef, (s)=>{ try{ setNowPlaying(s?.val()||null);}catch{ setNowPlaying(null);} });
    onValue(cRef, (s)=>{ try{ setPaused(!!((s?.val()||{}).paused)); }catch{ setPaused(false);} });
    onValue(sRef, (s)=>{ try{ setSkipMap(s?.val()||{});}catch{ setSkipMap({}); } });

    // presence
    try{
      const meRef = child(pRef, clientId);
      rPresenceEntry.current = meRef;
      await set(meRef, { name: displayName || "Guest", ts: Date.now() });
      try { onDisconnect(meRef).remove(); } catch {}
      if(hbTimer.current) clearInterval(hbTimer.current);
      hbTimer.current = setInterval(()=> { update(meRef, { name: displayName || "Guest", ts: Date.now() }); }, HEARTBEAT_MS);

      onValue(pRef, (s)=>{
        try{
          const all = s?.val() || {};
          const now = Date.now();
          const active = Object.values(all).filter(p => (now - (p?.ts||0)) <= PRESENCE_STALE_MS);
          setActiveCount(active.length);
          const names = [...new Set(active.map(p => String(p?.name || "Guest").trim()).filter(Boolean))];
          setActiveNames(names);
        }catch{
          setActiveCount(0); setActiveNames([]);
        }
      });
    }catch(e){ console.warn("presence error", e); }

    // chat listener
    onValue(chRef, (s)=>{
      try{
        const v = s?.val() || {};
        const items = Object.entries(v).map(([id, m]) => ({ id, ...(m||{}) }));
        items.sort((a,b)=>(a.ts||0)-(b.ts||0));
        setChat(items.slice(-200));
      }catch{ setChat([]); }
    });

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
  const [skipBtnBusy, setSkipBtnBusy] = useState(false);
  const toggleSkipVote = async ()=>{
    if(!rSkip.current || skipBtnBusy) return;
    setSkipBtnBusy(true);
    const key = displayName || "Guest";
    try{
      if(meVoted) await fdb.remove(fdb.child(rSkip.current, key));
      else await fdb.set(fdb.child(rSkip.current, key), true);
    }catch(e){ console.warn(e); }
    finally{ setSkipBtnBusy(false); }
  };
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
    ['pdj_fb_config','pdj_room','pdj_name','pdj_client','pdj_search_times'].forEach(k=>{ try{localStorage.removeItem(k);}catch{} });
    try{ sessionStorage.clear(); }catch{}
    try{ localStorage.clear(); }catch{}; location.reload();
  }

  // Chat send
  const sendChat = async ()=>{
    const text = chatText.trim().slice(0,500);
    if(!text) return;
    if(!rChat.current){ alert("Join a room first."); return; }
    try{
      const newRef = fdb.push(rChat.current);
      await fdb.set(newRef, { id: newRef.key, name: displayName || "Guest", text, ts: Date.now() });
      setChatText("");
    }catch(e){ console.warn("chat send failed", e); toast.show("Couldn’t send"); }
  };
  useEffect(()=>{ if(chatBoxRef.current){ chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight; } },[chat]);

  // --- UI ---
  const namesPreview = activeNames.slice(0,3).join(", ");
  const moreNames = Math.max(0, activeNames.length - 3);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {toast.msg && <div className="fixed top-3 left-1/2 -translate-x-1/2 z-50 px-3 py-2 rounded-xl border border-slate-700 bg-slate-900/90 text-sm">{toast.msg}</div>}

      <header className="sticky top-0 z-40 backdrop-blur bg-slate-950/70 border-b border-slate-800">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <span className="text-xl font-bold">Party DJ</span>
          <span className="text-xs ml-auto opacity-70 flex items-center gap-2">
            <span>👥 {activeCount} listening</span>
            {activeCount > 0 && (
              <button className="underline" onClick={()=>setShowPeople(true)}>
                {namesPreview}{moreNames>0?` +${moreNames}`:""}
              </button>
            )}
          </span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 grid lg:grid-cols-3 gap-6">
        {/* LEFT: Join, Search, Queue, Chat, Preview */}
        <section className="lg:col-span-2 space-y-6">
          {/* Join */}
          <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <input className="px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700" placeholder="Your name" value={displayName} onChange={(e)=>setDisplayName(e.target.value)} />
              <input className="px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 w-28" placeholder="ROOM" value={roomCode} onChange={(e)=>setRoomCode(e.target.value.toUpperCase())} />
              <button className="px-3 py-2 rounded-xl bg-white text-slate-900 font-semibold" onClick={()=>joinRoom()}>Join</button>
              {!isGuestView && <button className="px-3 py-2 rounded-xl border border-slate-700" onClick={createRoom}>Create</button>}
              {!isGuestView && <button className="px-3 py-2 rounded-xl border border-slate-700" onClick={()=>setShowQr(true)}>Show QR</button>}
              {!isGuestView && (
                <label className="ml-auto inline-flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={isHost} onChange={(e)=> setIsHost(e.target.checked)} />
                  I'm the DJ (plays audio)
                </label>
              )}
            </div>
            {(connected && !isGuestView) && (
              <div className="mt-3 text-sm opacity-80">
                Share this room: <a className="underline break-all" href={guestRoomUrl}>{guestRoomUrl}</a>
              </div>
            )}
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
                        <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={toggleSkipVote} disabled={skipBtnBusy}>
                          {meVoted ? "Undo skip vote" : "Vote to Skip"} ({skipCount}/{requiredSkip})
                        </button>
                        <div className="text-xs opacity-70 mt-1">Skip triggers at 50% of active listeners.</div>
                      </div>
                    </div>
                  </div>
                  {!isGuestView && <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={()=>setShowQr(true)}>QR</button>}
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
                </li>
              ))}
              {(!queue || queue.length===0) && <div className="text-sm opacity-70">Queue is empty. Search and add some tracks!</div>}
            </ul>
          </div>

          {/* Chat */}
          <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
            <h2 className="text-lg font-bold mb-2">Chat</h2>
            <div ref={chatBoxRef} className="h-64 overflow-y-auto space-y-2 p-2 bg-slate-900/60 rounded-xl border border-slate-800">
              {(chat||[]).map(m=>(
                <div key={m.id} className="text-sm">
                  <span className="font-semibold">{m.name || "Guest"}:</span>{" "}
                  <span className="opacity-90">{m.text}</span>
                  <span className="text-[10px] opacity-50 ml-2">{fmtTime(m.ts)}</span>
                </div>
              ))}
              {(!chat || chat.length===0) && <div className="text-sm opacity-60">No messages yet.</div>}
            </div>
            <div className="mt-2 flex gap-2">
              <input className="px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 flex-1 outline-none" placeholder="Type a message…" value={chatText} onChange={(e)=>setChatText(e.target.value)} onKeyDown={(e)=>{ if(e.key==='Enter') sendChat(); }} />
              <button className="px-3 py-2 rounded-xl bg-white text-slate-900 font-semibold" onClick={sendChat}>Send</button>
            </div>
            <div className="text-xs opacity-60 mt-1">Be nice ✌️</div>
          </div>

          {/* Inline preview */}
          {previewId && (
            <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-lg font-bold">Preview player</h2>
                <button className="text-sm underline" onClick={()=>setPreviewId("")}>Close</button>
              </div>
              <div className="aspect-video w-full bg-black rounded overflow-hidden">
                <iframe src={`https://www.youtube.com/embed/${previewId}?autoplay=1`} title="YouTube player" className="w-full h-full" allow="autoplay; encrypted-media" referrerPolicy="strict-origin-when-cross-origin" />
              </div>
            </div>
          )}
        </section>

        {/* RIGHT: Settings & Host Player */}
        <section className="space-y-6">
          <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
            <h2 className="text-lg font-bold mb-2">Settings</h2>
            <details className="mt-1">
              <summary className="cursor-pointer text-sm opacity-80">Firebase config (advanced)</summary>
              <textarea className="mt-2 w-full px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 outline-none" rows={6} placeholder="(Optional) Paste JSON to override the baked config" value={fbConfig} onChange={(e)=>setFbConfig(e.target.value)} />
              <p className="mt-2 text-xs opacity-70">Guests don’t need to paste anything.</p>
            </details>
            <button className="mt-3 px-3 py-2 rounded-xl border border-slate-700 hover:bg-slate-800/50 text-sm" onClick={resetApp}>Reset app (clear saved settings)</button>
          </div>

          {isHost && (
            <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
              <h2 className="text-lg font-bold mb-2">Host Player</h2>
              <div className="text-xs opacity-70 mb-2">Keep this tab open. Audio routes to your paired Bluetooth speaker.</div>
              <div ref={ytRef} />
              <div className="grid grid-cols-2 gap-2 mt-3">
                <button className="px-3 py-2 rounded-xl bg-white text-slate-900 font-semibold" onClick={startNext}>Play top voted / Skip</button>
                <button className="px-3 py-2 rounded-xl border border-slate-700" onClick={togglePause}>{paused? "Resume":"Pause"}</button>
              </div>
            </div>
          )}
        </section>
      </main>

      {/* QR modal (uses guest URL) */}
      {showQr && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-4 w-full max-w-sm">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold">Scan to join</h3>
              <button className="text-sm underline" onClick={()=>setShowQr(false)}>Close</button>
            </div>
            <div className="w-full flex items-center justify-center">
              <img src={qrSrc} alt="Room QR" className="rounded-xl border border-slate-800" />
            </div>
            <div className="mt-3 text-xs break-all opacity-80">{guestRoomUrl}</div>
            <div className="mt-3 flex gap-2">
              <button className="px-3 py-2 rounded-xl border border-slate-700" onClick={copyLink}>Copy link</button>
              <a className="px-3 py-2 rounded-xl border border-slate-700 text-center" href={qrSrc} download={`party-dj-${roomCode||"room"}.png`}>Download QR</a>
            </div>
            {!roomCode && <div className="mt-3 text-xs text-rose-300">Tip: set a ROOM code or click Create first.</div>}
          </div>
        </div>
      )}

      {/* People modal */}
      {showPeople && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-4 w-full max-w-sm">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold">Who's listening</h3>
              <button className="text-sm underline" onClick={()=>setShowPeople(false)}>Close</button>
            </div>
            <ul className="max-h-80 overflow-y-auto space-y-1">
              {(activeNames||[]).map((n,i)=> <li key={i} className="text-sm">{n}</li>)}
            </ul>
          </div>
        </div>
      )}

      <footer className="max-w-6xl mx-auto px-4 pb-8 text-xs opacity-60">Built for quick parties. Respect copyright & venue licensing.</footer>
    </div>
  );
}
