import express from "express";
import fs from "fs/promises";
import path from "path";

const app = express();
const PORT = process.env.PORT || 5179;

app.use(express.json());
app.use(express.static(process.cwd(), { extensions: ["html"] }));

// --- FORECAST HISTORY DATABASE (With Timeseries Array for Sparklines) ---
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
const CACHE_FILE = path.join(DATA_DIR, "forecast_history.json");

let memoryDB = {};

async function initDB() {
  try {
    const data = await fs.readFile(CACHE_FILE, "utf-8");
    memoryDB = JSON.parse(data);
    console.log("✅ History Database Loaded");
  } catch (e) {
    console.log("⚠️ No history file found. Starting fresh.");
    memoryDB = {};
  }
}
initDB();

app.get("/api/history", (req, res) => {
  res.json(memoryDB);
});

let writeTimeout = null;

app.post("/api/history", (req, res) => {
  const { stid, dateStr, model, temp, time } = req.body;
  if (!stid || !dateStr || !model || !temp || temp === "—" || temp === "Err") {
      return res.status(400).json({ error: "Invalid fields" });
  }

  if (!memoryDB[stid]) memoryDB[stid] = {};
  if (!memoryDB[stid][dateStr]) memoryDB[stid][dateStr] = {};

  let existing = memoryDB[stid][dateStr][model];

  if (!existing) {
    // First time seeing it today: set initial and start the history array
    memoryDB[stid][dateStr][model] = { 
        temp, time, initialTemp: temp, 
        history: [{ ts: Date.now(), temp, time }] 
    };
  } else {
    existing.temp = temp;
    existing.time = time;
    if (!existing.initialTemp) existing.initialTemp = temp; 
    if (!existing.history) existing.history = [{ ts: Date.now() - 600000, temp: existing.initialTemp, time }];
    
    // Push current reading to history array (cap at 144 to prevent memory leaks, ~24hrs at 10m intervals)
    existing.history.push({ ts: Date.now(), temp, time });
    if (existing.history.length > 144) existing.history.shift();
  }

  if (writeTimeout) clearTimeout(writeTimeout);
  writeTimeout = setTimeout(async () => {
    try { await fs.writeFile(CACHE_FILE, JSON.stringify(memoryDB, null, 2)); } 
    catch (e) { console.error("Failed to write history cache:", e); }
  }, 2000);

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
    res.setHeader("Content-Type", "application/json; charset=utf-8"); res.send(body);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/api/nws_forecast", async (req, res) => {
  const { lat, lon } = req.query;
  try {
    const pRes = await getCachedOrFetch(`nws_points_${lat}_${lon}`, `https://api.weather.gov/points/${lat},${lon}`, {
        "User-Agent": "Mozilla/5.0 (MarketPredictionApp; dev@example.com)", "Accept": "application/geo+json"
    });
    if (!pRes.ok) return res.status(pRes.status).send(pRes.body);
    
    const pointsData = JSON.parse(pRes.body);
    const hourlyUrl = pointsData.properties.forecastHourly;
    const { status, ok, body } = await getCachedOrFetch(`nws_forecast_${lat}_${lon}`, hourlyUrl, {
        "User-Agent": "Mozilla/5.0 (MarketPredictionApp; dev@example.com)", "Accept": "application/geo+json"
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