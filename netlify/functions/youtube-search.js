// netlify/functions/youtube-search.js

// Allow both of your site URLs (add your custom domain here too if you get one)
const ALLOWED = new Set([
  "https://steady-khapse-68fb98.netlify.app",
  "https://bespoke-gumdrop-6a5e0d.netlify.app",
  // "http://localhost:5173", // uncomment for local dev
]);

// very lightweight per-IP in-memory rate limit (best-effort on warm instances)
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;
const MIN_GAP_MS = 400;
const bucket = new Map(); // ip -> [timestamps]

function getIp(event) {
  return (
    event.headers["x-nf-client-connection-ip"] ||
    (event.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    event.headers["client-ip"] ||
    "unknown"
  );
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "null",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
function jsonHeaders(origin) {
  return { ...corsHeaders(origin), "Content-Type": "application/json" };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || "";
  const ip = getIp(event);

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    const allow = ALLOWED.has(origin) || origin === ""; // allow empty for quick tests
    return { statusCode: 204, headers: corsHeaders(allow ? origin : "null") };
  }

  // origin lock (allow empty origin if called directly in browser bar)
  if (!ALLOWED.has(origin) && origin !== "") {
    return { statusCode: 403, headers: jsonHeaders(origin), body: JSON.stringify({ error: "forbidden" }) };
  }

  // basic rate limit
  const now = Date.now();
  const arr = (bucket.get(ip) || []).filter(t => now - t <= WINDOW_MS);
  if (arr.length && now - arr[arr.length-1] < MIN_GAP_MS) {
    return { statusCode: 429, headers: jsonHeaders(origin), body: JSON.stringify({ error: "Too many requests (gap)" }) };
  }
  if (arr.length >= MAX_PER_WINDOW) {
    return { statusCode: 429, headers: jsonHeaders(origin), body: JSON.stringify({ error: "Too many requests (window)" }) };
  }
  arr.push(now); bucket.set(ip, arr);

  const API_KEY = process.env.YOUTUBE_API_KEY;
  if (!API_KEY) {
    return { statusCode: 500, headers: jsonHeaders(origin), body: JSON.stringify({ error: "YOUTUBE_API_KEY not set" }) };
    }

  const q = (event.queryStringParameters?.q || "").trim();
  const pageToken = event.queryStringParameters?.pageToken || "";
  if (!q) return { statusCode: 400, headers: jsonHeaders(origin), body: JSON.stringify({ error: "Missing q" }) };

  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", "12");
  url.searchParams.set("q", q);
  url.searchParams.set("key", API_KEY);
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  try {
    const res = await fetch(url);
    const data = await res.json();
    return { statusCode: 200, headers: jsonHeaders(origin), body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 502, headers: jsonHeaders(origin), body: JSON.stringify({ error: "YouTube fetch failed", detail: String(e) }) };
  }
};
