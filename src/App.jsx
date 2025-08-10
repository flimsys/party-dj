import React, { useEffect, useMemo, useRef, useState } from "react";

/** Party DJ — Auto-DJ + update banner + contacts invite
 * - Auto-DJ modes: Favorites | Related (beta)
 * - Keeps playback going when queue is empty
 * - Adds tracks as "Auto-DJ" without hitting per-user limits
 * - Everything you already had: PWA update, install, search via function, favorites, chat,
 *   presence + active listeners, dynamic skip (50%), QR join, guest/DJ layouts, local show video, invite.
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
const AUTODJ_MIN_QUEUE = 1; // ensure at least this many items when Auto-DJ is ON

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
function useSessionBool(key, initial=false){
  const [b,setB]=useState(()=> (sessionStorage.getItem(key) ?? (initial?"1":"0"))==="1");
  useEffect(()=>{ try{ sessionStorage.setItem(key, b?"1":"0"); }catch{} },[b]);
  return [b,setB];
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

/** ✅ Baked Firebase config (guests don't need to paste anything) */
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

// ---- Favorites (per-session; clears when the app/browser restarts) ----
function useFavorites(){
  const KEY = "pdj_favorites";
  const [list, setList] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(KEY) || "[]"); }
    catch { return []; }
  });
  useEffect(() => {
    try { sessionStorage.setItem(KEY, JSON.stringify(list)); } catch {}
  }, [list]);

  const has = id => list.some(x => x.id === id);
  const add = v => setList(prev =>
    prev.some(x => x.id === v.id) ? prev : [...prev, { id:v.id, title:v.title, thumb:v.thumb }]
  );
  const remove = id => setList(prev => prev.filter(x => x.id !== id));
  const toggle = v => has(v.id) ? remove(v.id) : add(v);
  return { list, add, remove, toggle, has, setList };
}

/** 🔘 Install prompt hook (for the “Install app” button) */
function useInstallPrompt(){
  const [deferred, setDeferred] = React.useState(null);
  const [canInstall, setCanInstall] = React.useState(false);

  React.useEffect(() => {
    const onBIP = (e) => {
      e.preventDefault();           // keep it for later
      setDeferred(e);
      setCanInstall(true);
    };
    const onInstalled = () => setCanInstall(false);

    window.addEventListener('beforeinstallprompt', onBIP);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBIP);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch {}
    setDeferred(null);
    setCanInstall(false);
  };

  return { canInstall, install };
}

/** 🟦 Update banner hook (shows when a new SW is waiting while app runs) */
function useUpdateBanner(){
  const [updateReady, setUpdateReady] = React.useState(false);
  React.useEffect(() => {
    const onReady = () => setUpdateReady(true);
    window.addEventListener('pdj-sw-update-ready', onReady);
    return () => window.removeEventListener('pdj-sw-update-ready', onReady);
  }, []);
  const applyUpdate = () => {
    try {
      const w = window.__pdjSWWaiting;
      if (w) w.postMessage({ type: 'SKIP_WAITING' });
    } catch {}
  };
  return { updateReady, applyUpdate };
}

/** 📇 Invite helpers (contacts/share/copy) */
function normalizeTel(v=""){ return String(v).replace(/[^\d+]/g,""); }
function firstOf(x){ return Array.isArray(x)&&x.length? x[0]: x||""; }

export default function App(){
  const toast = useToast();
  const { updateReady, applyUpdate } = useUpdateBanner();

  const isGuestView = useMemo(() => {
    try { return new URL(window.location.href).searchParams.get("guest") === "1"; }
    catch { return false; }
  }, []);

  const [collapsedSearch, setCollapsedSearch] = useState(false);
  const [collapsedChat, setCollapsedChat] = useState(false);

  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]); const [loading, setLoading] = useState(false);
  const [error, setError] = useState(""); const [previewId, setPreviewId] = useState("");

  const { list: favs, toggle: toggleFav, remove: removeFav, has: hasFav } = useFavorites();
  const [searchTab, setSearchTab] = useState("search"); // 'search' | 'favorites'

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

  const [fbConfig, setFbConfig] = useLocalSetting("pdj_fb_config", "");
  const fbCfg = useMemo(()=> parseFirebaseJson(fbConfig) || DEFAULT_FB_CFG, [fbConfig]);

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

  const [roomCode, setRoomCode] = useSessionSetting("pdj_room", "");
  const [displayName, setDisplayName] = useSessionSetting("pdj_name", "Guest"+randomId(3));
  const [clientId] = useLocalSetting("pdj_client", randomId(6));
  // ✅ Auto-check for DJ view, unchecked for guest view:
  const [isHost, setIsHost] = useState(() => !isGuestView);

  const [connected, setConnected] = useState(false);
  const [queue, setQueue] = useState([]); const [nowPlaying, setNowPlaying] = useState(null);
  const [paused, setPaused] = useState(false);

  const [activeCount, setActiveCount] = useState(0);
  const [activeNames, setActiveNames] = useState([]);
  const requiredSkip = SKIP_THRESHOLD(activeCount);

  const [skipMap, setSkipMap] = useState({}); const skipCount = Object.keys(skipMap||{}).length;
  const meVoted = !!skipMap[displayName];

  const [chat, setChat] = useState([]);
  const [chatText, setChatText] = useState("");
  const chatBoxRef = useRef(null);

  // 🔁 Auto-DJ state (saved per session)
  const [autoDj, setAutoDj] = useSessionBool("pdj_autoDj", false);
  const [autoDjMode, setAutoDjMode] = useSessionSetting("pdj_autoDjMode", "favorites"); // 'favorites' | 'related'

  const rQueue = useRef(null), rNow = useRef(null), rCtl = useRef(null), rSkip = useRef(null);
  const rPresence = useRef(null), rPresenceEntry = useRef(null), rChat = useRef(null);
  const hbTimer = useRef(null);

  const roomUrl = useMemo(()=>{ const u=new URL(window.location.href); if(roomCode) u.searchParams.set("room", roomCode); else u.searchParams.delete("room"); u.searchParams.delete("guest"); return u.toString(); },[roomCode]);
  const guestRoomUrl = useMemo(()=>{ const u=new URL(roomUrl); u.searchParams.set("guest","1"); return u.toString(); },[roomUrl]);

  const [showQr, setShowQr] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const [showVideo, setShowVideo] = useSessionBool("pdj_showVideo", false); // local show video toggle

  // Invite modal state
  const [showInvite, setShowInvite] = useState(false);
  const [pickedContacts, setPickedContacts] = useState([]);

  const qrSrc = useMemo(()=> `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(guestRoomUrl || window.location.href)}`, [guestRoomUrl]);
  const copyLink = async ()=>{ const link = guestRoomUrl; try{ await navigator.clipboard.writeText(link); toast.show("Link copied!"); } catch{ prompt("Copy this link", link); } };

  // 🔘 PWA install hook
  const { canInstall, install } = useInstallPrompt();

  // ── INVITE: contacts → share → copy
  const canPickContacts = !!(navigator?.contacts && navigator.contacts.select);
  const canShare = !!navigator?.share;
  const inviteText = useMemo(() =>
    `Join my Party DJ room ${roomCode || ""}\n\n${guestRoomUrl}`, [guestRoomUrl, roomCode]);

  async function inviteViaShare(){
    if (!canShare) { await copyLink(); return; }
    try{
      await navigator.share({ title: "Party DJ", text: inviteText, url: guestRoomUrl });
    }catch(e){ /* user cancelled */ }
  }

  async function inviteFromContacts(){
    if (!canPickContacts) { return inviteViaShare(); }
    try{
      const propsAvail = (await navigator.contacts.getProperties?.()) || ["name","email","tel"];
      const props = ["name","email","tel"].filter(p => propsAvail.includes(p));
      const selected = await navigator.contacts.select(props, { multiple: true });
      const clean = (selected||[]).map(c => ({
        name: firstOf(c.name) || "Friend",
        email: firstOf(c.email),
        tel: normalizeTel(firstOf(c.tel))
      }));
      setPickedContacts(clean);
      setShowInvite(true);
    }catch(e){
      if (String(e?.name||e).toLowerCase().includes("abort")) return;
      inviteViaShare();
    }
  }

  const joinRoom = async (code)=>{
    if(!fdb?.db){ alert("Firebase not ready. Reload the page."); return; }
    const { db, ref, child, onValue, set, update, remove, onDisconnect } = fdb;

    const safe = (code||roomCode||"").trim().toUpperCase(); if(!safe){ if(isGuestView){ toast.show("Ask the DJ for the QR."); } else { alert("Enter room code"); } return; }
    setRoomCode(safe);

    const baseRef = ref(db, `rooms/${safe}`);
    const qRef = child(baseRef, "queue");
    const nRef = child(baseRef, "now");
    const cRef = child(baseRef, "control");
    const sRef = child(baseRef, "skipVotes");
    const pRef = child(baseRef, "presence");
    const chRef = child(baseRef, "chat");

    rQueue.current=qRef; rNow.current=nRef; rCtl.current=cRef; rSkip.current=sRef; rPresence.current=pRef; rChat.current=chRef;

    onValue(qRef, (s)=>{ try{ const v=s?.val()||{}; const items = Array.isArray(v)? v.filter(Boolean): Object.values(v).filter(Boolean); items.sort((a,b)=>(b.votes||0)-(a.votes||0)); setQueue(items||[]);}catch{ setQueue([]);} });
    onValue(nRef, (s)=>{ try{ setNowPlaying(s?.val()||null);}catch{ setNowPlaying(null);} });
    onValue(cRef, (s)=>{ try{ setPaused(!!((s?.val()||{}).paused)); }catch{ setPaused(false);} });
    onValue(sRef, (s)=>{ try{ setSkipMap(s?.val()||{});}catch{ setSkipMap({}); } });

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

  useEffect(()=>{ (async ()=>{
    if(!fdb || !rPresenceEntry.current) return;
    try{ await fdb.update(rPresenceEntry.current, { name: displayName || "Guest" }); }catch{}
  })(); }, [displayName, fdb]);

  const createRoom = ()=> joinRoom(randomId(4));
  const sanitizeId = (id="")=> id.replace(/[.#$\[\]]/g,'_');

  // Add WITHOUT per-user limits, and mark as Auto-DJ
  const autoAddToQueue = async (video)=>{
    if(!rQueue.current) return false;
    const id = `yt:${video.id}`;
    const dup = (queue||[]).some(q=>q.id===id) || (nowPlaying?.id===id);
    if(dup) return false;
    try{
      await fdb.set(fdb.child(rQueue.current, sanitizeId(id)), {
        id, provider:'youtube', title: video.title, thumb: video.thumb,
        addedBy: "Auto-DJ", votes: 1, ts: Date.now()
      });
      return true;
    }catch(e){ console.warn("autoAddToQueue", e); return false; }
  };

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

  // 🔁 Auto-DJ picker
  async function fetchRelated(videoId){
    try{
      const res = await fetch(`/.netlify/functions/youtube-search?related=${encodeURIComponent(videoId)}`);
      if(!res.ok) throw new Error("related failed");
      const data = await res.json();
      const items = (data?.items||[]).map(it=>({
        id: it?.id?.videoId || "",
        title: it?.snippet?.title || "Untitled",
        thumb: it?.snippet?.thumbnails?.medium?.url || ""
      })).filter(x=>x.id);
      return items;
    }catch(e){ console.warn("fetchRelated", e); return []; }
  }
  function randPick(list){ return list[Math.floor(Math.random()*list.length)]; }

  async function ensureAutoDjSeed(countNeeded=1){
    if(!autoDj || !isHost) return false;
    let added = 0;

    // 1) Favorites mode
    if(autoDjMode === "favorites" && favs.length){
      // Shuffle favorites lightly
      const picks = [...favs].sort(()=>Math.random()-.5);
      for(const v of picks){
        if(added >= countNeeded) break;
        const ok = await autoAddToQueue(v);
        if(ok) added++;
      }
    }

    // 2) Related mode (beta)
    if(added < countNeeded && autoDjMode === "related" && nowPlaying?.id){
      const baseVid = (nowPlaying.id||"").split(":").pop();
      const rel = await fetchRelated(baseVid);
      for(const v of rel){
        if(added >= countNeeded) break;
        const ok = await autoAddToQueue(v);
        if(ok) added++;
      }
    }

    // 3) Fallback: basic search on the last title keywords
    if(added < countNeeded){
      const q = (nowPlaying?.title || "official audio music").split(/[\-\(\)\[\]\|]/)[0].trim() || "music";
      try{
        const res = await fetch(`/.netlify/functions/youtube-search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        const items = (data?.items||[]).map(it=>({
          id: it?.id?.videoId || "",
          title: it?.snippet?.title || "Untitled",
          thumb: it?.snippet?.thumbnails?.medium?.url || ""
        })).filter(x=>x.id);
        // Try the first few diverse picks
        for(const v of items.slice(0,6)){
          if(added >= countNeeded) break;
          const ok = await autoAddToQueue(v);
          if(ok) added++;
        }
      }catch(e){ /* ignore */ }
    }

    return added > 0;
  }

  const startNext = async ()=>{
    if(!isHost||!rQueue.current||!rNow.current) return;

    // If Auto-DJ is ON and queue is empty, seed it
    if(autoDj && (!queue || queue.length === 0)){
      const seeded = await ensureAutoDjSeed(AUTODJ_MIN_QUEUE);
      if(!seeded){ toast.show("Auto-DJ couldn’t find a track."); }
    }

    const next = [...(queue||[])].sort((a,b)=>(b.votes||0)-(a.votes||0))[0];
    if(!next){ toast.show("Queue is empty."); return; }
    try{
      await fdb.set(rNow.current, { id: next.id, title: next.title, thumb: next.thumb, provider:'youtube', startedAt: Date.now() });
      await fdb.remove(fdb.child(rQueue.current, sanitizeId(next.id)));
      if(rSkip.current) await fdb.remove(rSkip.current);

      // After moving to "Now", optionally top-off queue to keep one ready
      if(autoDj){
        const need = Math.max(0, AUTODJ_MIN_QUEUE - (queue.length - 1)); // -1 because we just removed one
        if(need > 0) ensureAutoDjSeed(need);
      }
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

  useEffect(()=>{ if(!fdb) return; const url=new URL(window.location.href); const r=url.searchParams.get("room"); if(r && !connected) joinRoom(r); },[connected,fdb]);

  function resetApp(){
    if(!confirm("Clear saved data and reset the app?")) return;
    ['pdj_fb_config','pdj_room','pdj_name','pdj_client','pdj_search_times','pdj_favorites','pdj_autoDj','pdj_autoDjMode']
      .forEach(k=>{ try{localStorage.removeItem(k);}catch{} });
    try { sessionStorage.removeItem('pdj_favorites'); } catch {}
    try { sessionStorage.clear(); } catch {}
    try { localStorage.clear(); } catch {}
    location.reload();
  }

  const [chatSendBusy, setChatSendBusy] = useState(false);
  const sendChat = async ()=>{
    const text = chatText.trim().slice(0,500);
    if(!text) return;
    if(!rChat.current){ alert("Join a room first."); return; }
    setChatSendBusy(true);
    try{
      const newRef = fdb.push(rChat.current);
      await fdb.set(newRef, { id: newRef.key, name: displayName || "Guest", text, ts: Date.now() });
      setChatText("");
    }catch(e){ console.warn("chat send failed", e); toast.show("Couldn’t send"); }
    finally{ setChatSendBusy(false); }
  };
  useEffect(()=>{ if(chatBoxRef.current){ chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight; } },[chat]);

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
            {updateReady && (
              <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={applyUpdate}>
                Update available
              </button>
            )}
            <InstallButton />
          </span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 grid lg:grid-cols-3 gap-6">
        {/* LEFT: Room, Search, Queue, Chat, Preview */}
        <section className="lg:col-span-2 space-y-6">
          {/* Room controls */}
          <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-bold">Room</h2>
              <div className="text-xs opacity-70">
                {connected ? <>Joined <b>{roomCode || "—"}</b>{isHost ? " • DJ" : ""}</> : "Not joined"}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2">
                <input
                  className="px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700"
                  placeholder="Your name"
                  value={displayName}
                  onChange={(e)=>setDisplayName(e.target.value)}
                />
                {isGuestView && (
                  <span className="text-xs opacity-70 hidden sm:inline">
                    This is the name others will see.
                  </span>
                )}
              </div>

              {isGuestView ? (
                <>
                  <button className="px-3 py-2 rounded-xl border border-slate-700" onClick={()=>setShowQr(true)}>
                    Show QR
                  </button>
                  <button className="px-3 py-2 rounded-xl border border-slate-700" onClick={inviteFromContacts}>
                    Invite friends
                  </button>
                  {!connected && (
                    <span className="text-xs opacity-70 sm:hidden w-full">
                      This is the name others will see.
                    </span>
                  )}
                  {!connected && (
                    <span className="text-xs opacity-70">
                      Open from the DJ’s QR/link to join the room.
                    </span>
                  )}
                </>
              ) : (
                <>
                  <input
                    className="px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 w-28"
                    placeholder="ROOM"
                    value={roomCode}
                    onChange={(e)=>setRoomCode(e.target.value.toUpperCase())}
                  />
                  <button className="px-3 py-2 rounded-xl bg-white text-slate-900 font-semibold" onClick={()=>joinRoom()}>
                    Join
                  </button>
                  <button className="px-3 py-2 rounded-xl border border-slate-700" onClick={createRoom}>
                    Create
                  </button>
                  <button className="px-3 py-2 rounded-xl border border-slate-700" onClick={()=>setShowQr(true)}>
                    Show QR
                  </button>
                  <button className="px-3 py-2 rounded-xl border border-slate-700" onClick={inviteFromContacts}>
                    Invite friends
                  </button>
                  <label className="ml-auto inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={isHost} onChange={(e)=> setIsHost(e.target.checked)} />
                    I'm the DJ (plays audio)
                  </label>
                </>
              )}
            </div>
          </div>

          {/* Search (collapsible + tabs) */}
          <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-bold">Search</h2>
                <div className="text-sm rounded-lg border border-slate-700 overflow-hidden">
                  <button
                    className={`px-3 py-1 ${searchTab==='search'?'bg-slate-800/60':''}`}
                    onClick={()=>setSearchTab('search')}
                  >Search</button>
                  <button
                    className={`px-3 py-1 ${searchTab==='favorites'?'bg-slate-800/60':''}`}
                    onClick={()=>setSearchTab('favorites')}
                  >Favorites ({favs.length})</button>
                </div>
              </div>
              <button
                className="text-sm underline"
                aria-expanded={!collapsedSearch}
                onClick={()=>setCollapsedSearch(s=>!s)}
              >
                {collapsedSearch ? "Expand" : "Minimize"}
              </button>
            </div>

            {!collapsedSearch && (
              <>
                {searchTab === "search" && (
                  <>
                    <div className="flex gap-2 flex-wrap items-center mt-3">
                      <input className="px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 flex-1 min-w-[240px] outline-none" placeholder="Search YouTube songs…" value={search} onChange={(e)=>setSearch(e.target.value)} onKeyDown={(e)=>{ if(e.key==='Enter') runSearch(); }} />
                      <button className="px-3 py-2 rounded-xl bg-white text-slate-900 font-semibold" onClick={runSearch} disabled={loading}>{loading? "Searching…":"Search"}</button>
                    </div>
                    {error && <div className="mt-3 text-sm text-rose-300">{error}</div>}
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
                      {(results||[]).map(v=>(
                        <div key={v.id} className="p-2 bg-slate-900/60 rounded-2xl border border-slate-800">
                          <img src={v.thumb} alt="" className="w-full h-32 object-cover rounded" />
                          <div className="mt-2 text-sm font-semibold line-clamp-2">{v.title}</div>
                          <div className="mt-2 flex gap-2 flex-wrap">
                            <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={()=>setPreviewId(v.id)}>Play</button>
                            <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={()=>addToQueue(v)} disabled={!connected}>Add to Queue</button>
                            <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={()=>toggleFav(v)}>
                              {hasFav(v.id) ? "★ Saved" : "☆ Save"}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {searchTab === "favorites" && (
                  <div className="mt-3">
                    {favs.length === 0 && (
                      <div className="text-sm opacity-70">
                        You don’t have any favorites yet. Search a song and press <b>☆ Save</b>.
                      </div>
                    )}
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {favs.map(v=>(
                        <div key={v.id} className="p-2 bg-slate-900/60 rounded-2xl border border-slate-800">
                          <img src={v.thumb} alt="" className="w-full h-32 object-cover rounded" />
                          <div className="mt-2 text-sm font-semibold line-clamp-2">{v.title}</div>
                          <div className="mt-2 flex gap-2 flex-wrap">
                            <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={()=>setPreviewId(v.id)}>Play</button>
                            <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={()=>addToQueue(v)} disabled={!connected}>Add to Queue</button>
                            <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={()=>removeFav(v.id)}>Remove</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
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

                  {/* Local show video switch */}
                  <label className="ml-3 inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={showVideo} onChange={(e)=>setShowVideo(e.target.checked)} />
                    Show video (local)
                  </label>
                </div>

                {showVideo && nowPlaying?.id && (
                  <div className="mt-3 rounded-xl overflow-hidden border border-slate-800">
                    <div className="aspect-video w-full bg-black">
                      <iframe
                        src={`https://www.youtube.com/embed/${(nowPlaying.id||"").split(":").pop()}?autoplay=1&mute=1&controls=1`}
                        title="Now playing"
                        className="w-full h-full"
                        allow="autoplay; encrypted-media"
                        referrerPolicy="strict-origin-when-cross-origin"
                      />
                    </div>
                    <div className="text-[11px] opacity-60 p-2">Muted by default to avoid echo. Use the YouTube controls to unmute on your device if you want audio.</div>
                  </div>
                )}
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
              {(!queue || queue.length===0) && <div className="text-sm opacity-70">Queue is empty. {autoDj ? "Auto-DJ will keep things moving." : "Search and add some tracks!"}</div>}
            </ul>
          </div>

          {/* Chat */}
          <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-bold">Chat</h2>
              <button
                className="text-sm underline"
                aria-expanded={!collapsedChat}
                onClick={()=>setCollapsedChat(s=>!s)}
              >
                {collapsedChat ? "Expand" : "Minimize"}
              </button>
            </div>

            {!collapsedChat && (
              <>
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
                  <button className="px-3 py-2 rounded-xl bg-white text-slate-900 font-semibold" onClick={sendChat} disabled={chatSendBusy}>Send</button>
                </div>
                <div className="text-xs opacity-60 mt-1">Be nice ✌️</div>
              </>
            )}
          </div>

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

        {/* RIGHT: Settings (DJ only) & Host Player */}
        <section className="space-y-6">
          {!isGuestView && (
            <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
              <h2 className="text-lg font-bold mb-2">Settings</h2>

              {/* Auto-DJ Controls */}
              <div className="p-3 rounded-xl border border-slate-800 bg-slate-900/60">
                <div className="flex items-center justify-between">
                  <div className="font-semibold">Auto-DJ</div>
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={autoDj} onChange={(e)=>setAutoDj(e.target.checked)} />
                    Enabled
                  </label>
                </div>
                <div className="mt-2 text-sm">
                  <label className="mr-2">Mode:</label>
                  <select
                    className="px-2 py-1 rounded-lg bg-slate-900/60 border border-slate-700"
                    value={autoDjMode}
                    onChange={(e)=>setAutoDjMode(e.target.value)}
                  >
                    <option value="favorites">Favorites (DJ)</option>
                    <option value="related">Related to current (beta)</option>
                  </select>
                </div>
                <div className="text-xs opacity-70 mt-2">
                  Auto-DJ fills the queue when empty. Related mode requires the server function to allow <code>?related=VIDEO_ID</code>.
                </div>
              </div>

              <details className="mt-3">
                <summary className="cursor-pointer text-sm opacity-80">Firebase config (advanced)</summary>
                <textarea className="mt-2 w-full px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 outline-none" rows={6} placeholder="(Optional) Paste JSON to override the baked config" value={fbConfig} onChange={(e)=>setFbConfig(e.target.value)} />
                <p className="mt-2 text-xs opacity-70">Guests don’t need to paste anything.</p>
              </details>
              <button className="mt-3 px-3 py-2 rounded-xl border border-slate-700 hover:bg-slate-800/50 text-sm" onClick={resetApp}>Reset app (clear saved settings)</button>
            </div>
          )}

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

      {/* QR modal */}
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
            {!roomCode && <div className="mt-3 text-xs text-rose-300">Tip: open from the DJ’s QR so the room is set.</div>}
          </div>
        </div>
      )}

      {/* Invite modal (selected contacts → SMS / email / copy) */}
      {showInvite && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-4 w-full max-w-md">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold">Invite friends</h3>
              <button className="text-sm underline" onClick={()=>setShowInvite(false)}>Close</button>
            </div>

            {(!pickedContacts || pickedContacts.length===0) && (
              <div className="text-sm opacity-80">
                No contacts selected. You can still share the link:
                <div className="mt-2 flex gap-2">
                  <button className="px-3 py-2 rounded-xl border border-slate-700" onClick={inviteViaShare}>Share</button>
                  <button className="px-3 py-2 rounded-xl border border-slate-700" onClick={copyLink}>Copy link</button>
                </div>
              </div>
            )}

            {pickedContacts && pickedContacts.length>0 && (
              <ul className="max-h-80 overflow-y-auto space-y-2">
                {pickedContacts.map((c, i) => {
                  const smsHref = c.tel ? `sms:${encodeURIComponent(c.tel)}?&body=${encodeURIComponent(inviteText)}` : null;
                  const mailHref = c.email ? `mailto:${encodeURIComponent(c.email)}?subject=${encodeURIComponent("Join my Party DJ room")}&body=${encodeURIComponent(inviteText)}` : null;
                  return (
                    <li key={i} className="p-2 bg-slate-900/60 rounded-xl border border-slate-800">
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs opacity-70">
                        {c.tel ? `📞 ${c.tel}` : ""} {c.email ? `  ✉️ ${c.email}` : ""}
                      </div>
                      <div className="mt-2 flex gap-2">
                        {smsHref && <a className="px-2 py-1 rounded-lg border border-slate-700" href={smsHref}>SMS invite</a>}
                        {mailHref && <a className="px-2 py-1 rounded-lg border border-slate-700" href={mailHref}>Email invite</a>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="mt-3 flex gap-2">
              <button className="px-3 py-2 rounded-xl border border-slate-700" onClick={inviteViaShare}>Share sheet</button>
              <button className="px-3 py-2 rounded-xl border border-slate-700" onClick={copyLink}>Copy link</button>
            </div>
            <div className="text-[11px] opacity-60 mt-2">
              Tip: On iPhone, the Contact Picker may need enabling in Settings → Safari → Advanced → Feature Flags.
            </div>
          </div>
        </div>
      )}

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

/** Small component to render the Install button when available */
function InstallButton(){
  const { canInstall, install } = useInstallPrompt();
  if(!canInstall) return null;
  return (
    <button className="px-2 py-1 rounded-lg border border-slate-700" onClick={install}>
      Install app
    </button>
  );
}
