// netlify/functions/youtube-search.js

// CORS helpers
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const CORS_JSON = { ...CORS, "Content-Type": "application/json" };

// CommonJS export (most compatible with Netlify Functions)
exports.handler = async (event) => {
  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS };
  }

  const API_KEY = process.env.YOUTUBE_API_KEY;
  if (!API_KEY) {
    return {
      statusCode: 500,
      headers: CORS_JSON,
      body: JSON.stringify({ error: "YOUTUBE_API_KEY not set" }),
    };
  }

  const q = (event.queryStringParameters?.q || "").trim();
  const pageToken = event.queryStringParameters?.pageToken || "";
  if (!q) {
    return {
      statusCode: 400,
      headers: CORS_JSON,
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
    return { statusCode: 200, headers: CORS_JSON, body: JSON.stringify(data) };
  } catch (e) {
    return {
      statusCode: 502,
      headers: CORS_JSON,
      body: JSON.stringify({ error: "YouTube fetch failed", detail: String(e) }),
    };
  }
};

