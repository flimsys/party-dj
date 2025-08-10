// netlify/functions/youtube-search.js
export async function handler(event) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing YOUTUBE_API_KEY" }) };
  }

  const url = new URL(event.rawUrl);
  const q = url.searchParams.get("q");
  const related = url.searchParams.get("related");

  const api = new URL("https://www.googleapis.com/youtube/v3/search");
  api.searchParams.set("part", "snippet");
  api.searchParams.set("maxResults", "12");
  api.searchParams.set("type", "video");
  api.searchParams.set("key", key);

  if (related) {
    api.searchParams.set("relatedToVideoId", related);
  } else if (q) {
    api.searchParams.set("q", q);
  } else {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing q or related" }) };
  }

  try {
    const r = await fetch(api.toString());
    const data = await r.json();
    return { statusCode: 200, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
}
