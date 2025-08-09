import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Party DJ – YouTube-only safe build (no Spotify) + crash guards
 * --------------------------------------------------------------
 * - Removes Spotify code to avoid onSpotifyWebPlaybackSDKReady errors.
 * - Adds null/undefined guards so the app won't blank if Firebase isn't set yet.
 * - Keeps the same UI and Firebase realtime queue.
 */

// Firebase (compat CDN)
const firebaseCdn = {
  app: "https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js",
  db: "https://www.gstatic.com/firebasejs/10.12.5/firebase-database-compat.js",
};
const YT_IFRAME_API = "https://www.youtube.com/iframe_api";

function useScript(src) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
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

const randomId = (len = 6) => Math.random().toString(36).slice(2, 2 + len).toUpperCase();
const isHostDefault = () => (localStorage.getItem("pdj_is_host") === "1");

function useLocalSetting(key, initial = "") {
  const [v, setV] = useState(() => localStorage.getItem(key) ?? initial);
  useEffect(() => { localStorage.setItem(key, v ?? ""); }, [key, v]);
  return [v, setV];
}

function useYouTubeApi() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (window.YT && window.YT.Player) { setReady(true); return; }
    const tag = document.createElement('script');
    tag.src = YT_IFRAME_API;
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
    window.onYouTubeIframeAPIReady = () => setReady(true);
  }, []);
  return ready;
}

export default function App(){
  const [roomCode, setRoomCode] = useLocalSetting("pdj_room", "");
  const [displayName, setDisplayName] = useLocalSetting("pdj_name", "Guest"+randomId(3));
  const [isHost, setIsHost] = useState(isHostDefault());
  const [ytKey, setYtKey] = useLocalSetting("pdj_yt_key", "");
  const [fbConfig, setFbConfig] = useLocalSetting("pdj_fb_config", "");

  // Load Firebase
  const firebaseReady = useScript(firebaseCdn.app) && useScript(firebaseCdn.db);
  const [db, setDb] = useState(null);
  useEffect(()=>{
    if(!firebaseReady) return;
    try{
      const cfg = fbConfig? JSON.parse(fbConfig): null;
      if(!cfg) return;
      try {
  const cfg = fbConfig ? JSON.parse(fbConfig) : null;
  if (!cfg) return;

  // Wait until the firebase global exists
  if (!window.firebase) return;

  // Safely check for existing app and init if needed
  const hasApps = !!(window.firebase?.apps && window.firebase.apps.length > 0);
  if (!hasApps && window.firebase?.initializeApp) {
    window.firebase.initializeApp(cfg);
  }

  // Only set DB if available
  if (window.firebase?.database) {
    setDb(window.firebase.database());
  }
} catch (e) {
  console.warn("Firebase config invalid or init failed", e);
}
    }catch(e){ console.warn("Firebase config invalid", e); }
  },[firebaseReady, fbConfig]);

  // Realtime state
  const [connected, setConnected] = useState(false);
  const [queue, setQueue] = useState([]);
  const [nowPlaying, setNowPlaying] = useState(null);
  const [paused, setPaused] = useState(false);

  const rQueue = useRef(null), rNow = useRef(null), rCtl = useRef(null);

  const joinRoom = async (code)=>{
    if (!db) { alert("Add Firebase config in Settings first."); return; }
    const safe = (code||roomCode||'').trim().toUpperCase(); if(!safe){ alert("Enter room code"); return; }
    setRoomCode(safe);
    const base = db.ref(`rooms/${safe}`);
    rQueue.current = base.child('queue');
    rNow.current   = base.child('now');
    rCtl.current   = base.child('control');

    rQueue.current.on('value', s => {
  try {
    const v = (typeof s?.val === "function" ? s.val() : {}) || {};
    const items = Array.isArray(v) 
      ? v.filter(Boolean).sort((a,b)=>(b.votes||0)-(a.votes||0))
      : Object.values(v).filter(Boolean).sort((a,b)=>(b.votes||0)-(a.votes||0));
    setQueue(items || []);
  } catch (err) {
    console.warn("Queue read error", err);
    setQueue([]);
  }
});
    rNow.current.on('value', s => {
  try {
    const val = typeof s?.val === "function" ? s.val() : null;
    setNowPlaying(val || null);
  } catch {
    setNowPlaying(null);
  }
});
    rCtl.current.on('value', s=> setPaused(!!(((s && s.val && s.val())||{}).paused)));
    setConnected(true);
  };
  const createRoom = ()=> joinRoom(randomId(4));

  // Queue ops
  const addToQueue = async (video)=>{
    if(!rQueue.current) return;
    const id = `youtube:${video.id}`.replace(/[.#$\[\]]/g,'_');
    const item = { id, provider:'youtube', title: video.title||'Untitled', thumb: video.thumb||'', addedBy: displayName, votes: 1, ts: Date.now() };
    try{ await rQueue.current.child(id).set(item);}catch(e){ console.warn('addToQueue failed', e); }
  };
  const vote = async (id, delta=1)=>{
    if(!rQueue.current) return;
    const safeId = (id||'').replace(/[.#$\[\]]/g,'_');
    try{
      await rQueue.current.child(safeId).transaction(it=>{ if(!it) return it; it.votes=(it.votes||0)+delta; return it; });
    }catch(e){ console.warn('vote failed', e); }
  };

  const startNext = async ()=>{
    if(!isHost||!rQueue.current||!rNow.current) return;
    const next = [...(queue||[])].sort((a,b)=>(b.votes||0)-(a.votes||0))[0];
    if(!next) return;
    try{
      await rNow.current.set({ id: next.id, provider: 'youtube', title: next.title, thumb: next.thumb, startedAt: Date.now() });
      await rQueue.current.child(next.id.replace(/[.#$\[\]]/g,'_')).remove();
      await rCtl.current.update({ paused:false });
    }catch(e){ console.warn('startNext failed', e); }
  };
  const togglePause = async ()=>{ if(!isHost||!rCtl.current) return; try{ await rCtl.current.transaction(ctl=>{ ctl=ctl||{}; ctl.paused=!ctl.paused; return ctl; }); }catch(e){} };

  // YouTube search
  const [search, setSearch] = useState("");
  const [ytResults,setYtResults] = useState([]);
  const runYtSearch = async ()=>{
    if(!ytKey) { alert("Add a YouTube API key in Settings."); return; }
    if(!search.trim()) return;
    try{
      const url = new URL("https://www.googleapis.com/youtube/v3/search");
      url.searchParams.set("part","snippet"); url.searchParams.set("type","video"); url.searchParams.set("maxResults","10"); url.searchParams.set("q", search.trim()); url.searchParams.set("key", ytKey);
      const res = await fetch(url); const data = await res.json();
      const vids = ((data && data.items) || []).map(it=>({ id: it.id.videoId, title: (it.snippet?.title)||'Video', thumb: it.snippet?.thumbnails?.medium?.url || '' }));
      setYtResults(vids);
    }catch(e){ console.warn('YouTube search failed', e); setYtResults([]); }
  };

  // Host player (YouTube only)
  const ytReady = useYouTubeApi();
  const ytPlayerRef = useRef(null); const ytPlayer = useRef(null);
  useEffect(()=>{ if(!ytReady||!isHost) return; if(ytPlayer.current) return; try{ ytPlayer.current=new window.YT.Player(ytPlayerRef.current,{height:'0',width:'0',videoId:'',playerVars:{autoplay:0},events:{onStateChange:(e)=>{ if(e.data===window.YT.PlayerState.ENDED) startNext(); }}});}catch(e){} },[ytReady,isHost]);
  useEffect(()=>{ if(!ytPlayer.current||!isHost) return; if(!nowPlaying||!nowPlaying.id) return; const parts = nowPlaying.id.split(':'); const vid = parts[1]||parts[0]; try{ ytPlayer.current.loadVideoById(vid); paused? ytPlayer.current.pauseVideo(): ytPlayer.current.playVideo(); }catch(e){} },[nowPlaying]);
  useEffect(()=>{ if(!ytPlayer.current||!isHost) return; try{ paused? ytPlayer.current.pauseVideo(): ytPlayer.current.playVideo(); }catch(e){} },[paused]);

  // Room URL helper
  const roomUrl = useMemo(()=>{ const u=new URL(window.location.href); u.searchParams.set("room", roomCode||""); return u.toString(); },[roomCode]);
  useEffect(()=>{ const url=new URL(window.location.href); const r=url.searchParams.get('room'); if(r && !connected) joinRoom(r); },[connected]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-40 backdrop-blur bg-slate-950/70 border-b border-slate-800">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <span className="text-xl font-bold">Party DJ</span>
          <span className="text-xs ml-auto opacity-70">Pair your device to a Bluetooth speaker first.</span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 grid lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 space-y-6">
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <input className="input" placeholder="Your display name" value={displayName} onChange={(e)=>setDisplayName(e.target.value)} />
              <input className="input w-28" placeholder="ROOM" value={roomCode} onChange={(e)=>setRoomCode(e.target.value.toUpperCase())} />
              <button className="btn" onClick={()=>joinRoom()}>Join</button>
              <button className="btn-outline" onClick={createRoom}>Create</button>
              <label className="ml-auto inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isHost} onChange={(e)=>{ setIsHost(e.target.checked); localStorage.setItem("pdj_is_host", e.target.checked?"1":"0"); }} />
                I'm the DJ (plays audio)
              </label>
            </div>
            {connected && (
              <div className="mt-3 text-sm opacity-80">Share this room: <a className="underline break-all" href={roomUrl}>{roomUrl}</a></div>
            )}
          </Card>

          <Card>
            <div className="flex gap-2">
              <input className="input flex-1" placeholder="Search YouTube songs…" value={search} onChange={(e)=>setSearch(e.target.value)} onKeyDown={(e)=>{ if(e.key==='Enter') runYtSearch(); }} />
              <button className="btn" onClick={runYtSearch}>Search</button>
            </div>
            <div className="grid md:grid-cols-2 gap-3 mt-4">
              {(ytResults||[]).map(v => (
                <div key={v.id} className="p-2 bg-slate-900/60 rounded-xl border border-slate-800 flex gap-3 items-center">
                  <img src={v.thumb} alt="thumb" className="w-20 h-12 object-cover rounded"/>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold line-clamp-2">{v.title}</div>
                  </div>
                  <button className="btn-sm" onClick={()=>addToQueue(v)}>Add</button>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-lg font-bold">Queue</h2>
              {isHost && <button className="btn-sm" onClick={startNext}>Start next</button>}
              {isHost && <button className="btn-sm" onClick={togglePause}>{paused?"Resume":"Pause"}</button>}
            </div>
            {nowPlaying && (
              <div className="mb-4 p-3 bg-slate-900/60 rounded-xl border border-slate-800">
                <div className="text-sm opacity-70">Now playing</div>
                <div className="flex items-center gap-3 mt-2">
                  <img src={nowPlaying.thumb} className="w-24 h-14 rounded object-cover"/>
                  <div className="font-semibold line-clamp-2">{nowPlaying.title}</div>
                </div>
              </div>
            )}
            <ul className="space-y-2">
              {(queue||[]).map(item => (
                <li key={item.id} className="p-2 bg-slate-900/60 rounded-xl border border-slate-800 flex items-center gap-3">
                  <img src={item.thumb} className="w-16 h-10 rounded object-cover"/>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium line-clamp-2">{item.title}</div>
                    <div className="text-xs opacity-60">Added by {item.addedBy}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="chip" onClick={()=>vote(item.id, +1)}>▲</button>
                    <span className="w-6 text-center">{item.votes||0}</span>
                    <button className="chip" onClick={()=>vote(item.id, -1)}>▼</button>
                  </div>
                </li>
              ))}
              {(!queue || queue.length===0) && <div className="text-sm opacity-70">Queue is empty. Search and add some tracks!</div>}
            </ul>
          </Card>
        </section>

        <section className="space-y-6">
          <Card>
            <h2 className="text-lg font-bold mb-2">Settings</h2>
            <label className="label">Firebase config (JSON)</label>
            <textarea className="textarea" rows={6} placeholder='{"apiKey":"...","authDomain":"...","databaseURL":"...","projectId":"...","storageBucket":"...","messagingSenderId":"...","appId":"..."}' value={fbConfig} onChange={(e)=>setFbConfig(e.target.value)} />
            <label className="label mt-3">YouTube Data API key</label>
            <input className="input" placeholder="AIza..." value={ytKey} onChange={(e)=>setYtKey(e.target.value)} />
            <ol className="text-xs opacity-80 mt-3 list-decimal pl-5 space-y-1">
              <li>Pair your device to a Bluetooth speaker in system settings.</li>
              <li>Tap <b>Create</b> on the DJ device and enable <b>I'm the DJ</b>.</li>
              <li>Share the room URL with friends.</li>
              <li>Search YouTube, add to queue, and vote. Host presses <b>Start next</b> and <b>Play</b> once.</li>
            </ol>
          </Card>

          {isHost && (
            <Card>
              <h2 className="text-lg font-bold mb-2">Host Player</h2>
              <div className="text-xs opacity-70 mb-2">Keep this tab open. Audio routes to your paired Bluetooth speaker.</div>
              <div ref={ytPlayerRef} />
              <button className="btn w-full mt-3" onClick={startNext}>Play top voted</button>
            </Card>
          )}
        </section>
      </main>

      <footer className="max-w-6xl mx-auto px-4 pb-8 text-xs opacity-60">Built for quick parties. Respect copyright & venue licensing.</footer>

      <style>{`
        .btn{ padding:0.5rem 0.75rem; border-radius:0.75rem; background:#fff; color:#0f172a; font-weight:600; border:1px solid #e5e7eb; box-shadow:0 1px 2px rgba(0,0,0,.06); }
        .btn:hover{ opacity:.9; }
        .btn-outline{ padding:0.5rem 0.75rem; border-radius:0.75rem; border:1px solid #334155; }
        .btn-sm{ padding:0.25rem 0.5rem; border-radius:0.5rem; border:1px solid #334155; font-size:0.875rem; }
        .chip{ padding:0.25rem 0.5rem; border-radius:0.5rem; border:1px solid #334155; font-size:0.875rem; }
        .input{ padding:0.5rem 0.75rem; border-radius:0.75rem; background:rgba(15,23,42,.6); border:1px solid #1f2937; outline:none; }
        .textarea{ padding:0.5rem 0.75rem; border-radius:0.75rem; background:rgba(15,23,42,.6); border:1px solid #1f2937; outline:none; width:100%; }
        .label{ font-size:0.875rem; opacity:.8; }
        .p-2{ padding:0.5rem; } .p-3{ padding:0.75rem; } .p-4{ padding:1rem; }
        .rounded-xl{ border-radius:0.75rem; } .rounded-2xl{ border-radius:1rem; }
        .border{ border-width:1px; } .border-slate-800{ border-color:#1f2937; }
        .bg-slate-900\/60{ background:rgba(15,23,42,.6); } .bg-slate-900\/40{ background:rgba(15,23,42,.4); }
        .text-xs{ font-size:0.75rem; } .text-sm{ font-size:0.875rem; } .text-lg{ font-size:1.125rem; } .text-xl{ font-size:1.25rem; }
        .font-bold{ font-weight:700; } .font-semibold{ font-weight:600; } .font-medium{ font-weight:500; }
        .max-w-6xl{ max-width:72rem; } .mx-auto{ margin-left:auto; margin-right:auto; }
        .px-4{ padding-left:1rem; padding-right:1rem; } .py-3{ padding-top:0.75rem; padding-bottom:0.75rem; } .pb-8{ padding-bottom:2rem; }
        .grid{ display:grid; } .gap-6{ gap:1.5rem; } .md\:grid-cols-2{ grid-template-columns:repeat(2,minmax(0,1fr)); }
        .lg\:grid-cols-3{ grid-template-columns:repeat(3,minmax(0,1fr)); }
        .lg\:col-span-2{ grid-column: span 2 / span 2; }
        .min-h-screen{ min-height:100vh; }
        .backdrop-blur{ backdrop-filter: blur(8px); } .bg-slate-950{ background-color:#020617; } .text-slate-100{ color:#f1f5f9; }
        .border-b{ border-bottom-width:1px; } .opacity-70{ opacity:.7; } .flex{ display:flex; } .items-center{ align-items:center; } .gap-2{ gap:0.5rem; } .gap-3{ gap:0.75rem; } .ml-auto{ margin-left:auto; }
        .space-y-6 > * + *{ margin-top:1.5rem; } .list-decimal{ list-style:decimal; } .pl-5{ padding-left:1.25rem; } .mt-3{ margin-top:0.75rem; } .mb-2{ margin-bottom:0.5rem; } .mb-3{ margin-bottom:0.75rem; } .mb-4{ margin-bottom:1rem; }
        .w-24{ width:6rem; } .w-20{ width:5rem; } .w-16{ width:4rem; } .w-6{ width:1.5rem; } .h-14{ height:3.5rem; } .h-12{ height:3rem; } .h-10{ height:2.5rem; }
        .rounded{ border-radius:0.25rem; } .object-cover{ object-fit:cover; } .min-w-0{ min-width:0; }
        .underline{ text-decoration: underline; } .break-all{ word-break: break-all; }
      `}</style>
    </div>
  );
}

function Card({children}){ return <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">{children}</div>; }
 
