// netlify/functions/youtube-search.js

// Allowed browser origins that can call this function
const ALLOWED = [
  "https://steady-khapse-68fb98.netlify.app",   // your live site
  // "http://localhost:5173",                    // uncomment while testing locally
];

// Helper to build CORS headers for a given origin
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "null",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// JSON headers + CORS
function jsonHeaders(origin) {
  return { ...corsHeaders(origin), "Content-Type": "application/json" };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || "";

  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    const allow = ALLOWED.includes(origin);
    return { statusCode: 204, headers: corsHeaders(allow ? origin : "null") };
  }

  // 🔒 Origin lock: only allow calls coming from your site
  if (!ALLOWED.includes(origin)) {
    return {
      statusCode: 403,
      headers: jsonHeaders(origin),
      body: JSON.stringify({ error: "forbidden" }),
    };
  }

  const API_KEY = process.env.YOUTUBE_API_KEY;
  if (!API_KEY) {
    return {
      statusCode: 500,
      headers: jsonHeaders(origin),
      body: JSON.stringify({ error: "YOUTUBE_API_KEY not set" }),
    };
  }

  const q = (event.queryStringParameters?.q || "").trim();
  const pageToken = event.queryStringParameters?.pageToken || "";
  if (!q) {
    return {
      statusCode: 400,
      headers: jsonHeaders(origin),
      body: JSON.stringify({ error: "Missing q" }),
    };
  }

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
    return {
      statusCode: 200,
      headers: jsonHeaders(origin),
      body: JSON.stringify(data),
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: jsonHeaders(origin),
      body: JSON.stringify({ error: "YouTube fetch failed", detail: String(e) }),
    };
  }
};
