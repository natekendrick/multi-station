import express from "express";

const app = express();
const PORT = process.env.PORT || 5179;

// Serve the index.html file and any static assets
app.use(express.static(process.cwd(), { extensions: ["html"] }));

const apiCache = {};
const CACHE_TTL_MS = 60 * 1000; // 1 minute cache TTL to prevent AWC rate limiting

async function getCachedOrFetch(cacheKey, url, headers = {}) {
  const now = Date.now();
  if (apiCache[cacheKey] && (now - apiCache[cacheKey].timestamp < CACHE_TTL_MS)) {
    return { status: 200, ok: true, body: apiCache[cacheKey].data };
  }

  const r = await fetch(url, { headers });
  const body = await r.text();

  if (r.ok) {
    apiCache[cacheKey] = { data: body, timestamp: now };
  }
  return { status: r.status, ok: r.ok, body };
}

// Proxy for Aviation Weather Center (Free METARs)
app.get("/api/awc_metar", async (req, res) => {
  const stid = (req.query.station || "KSFO").toString().toUpperCase();
  // Fetching 48 hours to ensure we can calculate "Yesterday's High" properly
  const url = `https://aviationweather.gov/api/data/metar?ids=${stid}&format=json&hours=48`;
  
  try {
    const { status, ok, body } = await getCachedOrFetch(`awc_metar_48h_${stid}`, url, { 
      // AWC aggressively blocks generic requests; use a custom User-Agent
      "User-Agent": "WeatherDashboard/1.0 (PredictionApp)",
      "Accept": "application/json"
    });

    // AWC returns 204 No Content if a station is offline or has no recent data
    if (status === 204) {
      return res.json([]); 
    }

    if (!ok) return res.status(status).send(body);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(body);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`🌤️ Free-Tier Dashboard running at http://localhost:${PORT}`);
});