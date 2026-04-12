import express from "express";
import fs from "fs/promises";
import path from "path";

const app = express();
const PORT = process.env.PORT || 5179;

// Enable JSON body parsing for our new history database
app.use(express.json());
app.use(express.static(process.cwd(), { extensions: ["html"] }));

// --- FORECAST HISTORY DATABASE ---
// On Railway, we will store this in a persistent volume directory (e.g., /data)
// If /data doesn't exist (like on your local Mac/PC), it defaults to the current folder.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
const CACHE_FILE = path.join(DATA_DIR, "forecast_history.json");

async function loadHistory() {
  try {
    const data = await fs.readFile(CACHE_FILE, "utf-8");
    return JSON.parse(data);
  } catch (e) {
    return {}; // Return empty object if file doesn't exist yet
  }
}

async function saveHistory(data) {
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Failed to write history cache:", e);
  }
}

// Endpoint to get the centralized forecast memory
app.get("/api/history", async (req, res) => {
  const history = await loadHistory();
  res.json(history);
});

// Endpoint to update the centralized forecast memory
app.post("/api/history", async (req, res) => {
  const { stid, dateStr, model, temp, time } = req.body;
  if (!stid || !dateStr || !model || !temp) return res.status(400).json({ error: "Missing fields" });

  const history = await loadHistory();
  if (!history[stid]) history[stid] = {};
  if (!history[stid][dateStr]) history[stid][dateStr] = {};
  
  history[stid][dateStr][model] = { temp, time };
  
  await saveHistory(history);
  res.json({ success: true });
});

// --- API PROXIES ---
const apiCache = {};
const CACHE_TTL_MS = 60 * 1000; 

async function getCachedOrFetch(cacheKey, url, headers = {}) {
  const now = Date.now();
  if (apiCache[cacheKey] && (now - apiCache[cacheKey].timestamp < CACHE_TTL_MS)) {
    return { status: 200, ok: true, body: apiCache[cacheKey].data };
  }
  const r = await fetch(url, { headers });
  const body = await r.text();
  if (r.ok) apiCache[cacheKey] = { data: body, timestamp: now };
  return { status: r.status, ok: r.ok, body };
}

app.get("/api/awc_metar", async (req, res) => {
  const stid = (req.query.station || "KSFO").toString().toUpperCase();
  const url = `https://aviationweather.gov/api/data/metar?ids=${stid}&format=json&hours=48`;
  try {
    const { status, ok, body } = await getCachedOrFetch(`awc_metar_48h_${stid}`, url, { 
      "User-Agent": "WeatherDashboard/1.0 (PredictionApp)", "Accept": "application/json"
    });
    if (status === 204) return res.json([]); 
    if (!ok) return res.status(status).send(body);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(body);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/api/nws_forecast", async (req, res) => {
  const { lat, lon } = req.query;
  try {
    const pRes = await getCachedOrFetch(`nws_points_${lat}_${lon}`, `https://api.weather.gov/points/${lat},${lon}`, {
        "User-Agent": "Mozilla/5.0 (compatible; MarketPredictionApp/1.0; dev@example.com)", "Accept": "application/geo+json"
    });
    if (!pRes.ok) return res.status(pRes.status).send(pRes.body);
    
    const pointsData = JSON.parse(pRes.body);
    const hourlyUrl = pointsData.properties.forecastHourly;
    const { status, ok, body } = await getCachedOrFetch(`nws_forecast_${lat}_${lon}`, hourlyUrl, {
        "User-Agent": "Mozilla/5.0 (compatible; MarketPredictionApp/1.0; dev@example.com)", "Accept": "application/geo+json"
    });
    if (!ok) return res.status(status).send(body);
    res.setHeader("Content-Type", "application/json; charset=utf-8"); res.send(body);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/api/wu_forecast", async (req, res) => {
  const { lat, lon } = req.query;
  const url = `https://api.weather.com/v3/wx/forecast/hourly/2day?apiKey=e1f10a1e78da46f5b10a1e78da96f525&geocode=${lat},${lon}&format=json&units=e&language=en-US`;
  try {
    const { status, ok, body } = await getCachedOrFetch(`wu_forecast_${lat}_${lon}`, url);
    if (!ok) return res.status(status).send(body);
    res.setHeader("Content-Type", "application/json; charset=utf-8"); res.send(body);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.listen(PORT, () => console.log(`🌤️ Dashboard running at http://localhost:${PORT}`));