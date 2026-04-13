import express from "express";
import fs from "fs/promises";
import path from "path";

const app = express();
const PORT = process.env.PORT || 5179;

app.use(express.json());
app.use(express.static(process.cwd(), { extensions: ["html"] }));

// --- FORECAST HISTORY DATABASE (RACE-CONDITION FREE) ---
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
const CACHE_FILE = path.join(DATA_DIR, "forecast_history.json");

// 1. Hold the database perfectly in memory
let memoryDB = {};

// 2. Load it once on server start
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

// 3. Update memory instantly, but "debounce" the disk write to prevent file corruption
let writeTimeout = null;

app.post("/api/history", (req, res) => {
  const { stid, dateStr, model, temp, time } = req.body;
  if (!stid || !dateStr || !model || !temp) return res.status(400).json({ error: "Missing fields" });

  // Update RAM synchronously (No race conditions)
  if (!memoryDB[stid]) memoryDB[stid] = {};
  if (!memoryDB[stid][dateStr]) memoryDB[stid][dateStr] = {};
  memoryDB[stid][dateStr][model] = { temp, time };

  // Wait 2 seconds after the *last* API call to write the final file to disk
  if (writeTimeout) clearTimeout(writeTimeout);
  writeTimeout = setTimeout(async () => {
    try {
      await fs.writeFile(CACHE_FILE, JSON.stringify(memoryDB, null, 2));
    } catch (e) {
      console.error("Failed to write history cache:", e);
    }
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

app.get("/api/nws_afd", async (req, res) => {
  const { lat, lon, station } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "Missing lat/lon" });

  try {
    const headers = { "User-Agent": "Mozilla/5.0 (MarketPredictionApp; dev@example.com)", "Accept": "application/geo+json" };
    let pRes = await getCachedOrFetch(`nws_points_${lat}_${lon}`, `https://api.weather.gov/points/${lat},${lon}`, headers);
    if (!pRes.ok) return res.status(pRes.status).send(pRes.body);
    const wfo = JSON.parse(pRes.body).properties.cwa;
    if (!wfo) throw new Error("No WFO found");

    let afdListRes = await getCachedOrFetch(`nws_afd_list_${wfo}`, `https://api.weather.gov/products/types/AFD/locations/${wfo}`, headers);
    if (!afdListRes.ok) throw new Error("Failed to get AFD list");
    const afdListData = JSON.parse(afdListRes.body);
    const latestAfdUrl = afdListData["@graph"]?.[0]?.["@id"];
    if (!latestAfdUrl) throw new Error("No AFD products found");

    let afdRes = await getCachedOrFetch(`nws_afd_product_${latestAfdUrl}`, latestAfdUrl, headers);
    if (!afdRes.ok) throw new Error("Failed to get AFD product");
    
    const text = JSON.parse(afdRes.body).productText || "";
    let bodyText = text.includes("DISCUSSION...") ? text.split("DISCUSSION...")[1] : text;
    let cleaned = bodyText.replace(/\n/g, ' ').replace(/\s{2,}/g, ' '); 
    let sentences = cleaned.split(/(?<=\.)\s+/); 
    
    let insights = [];
    const stidSearch = (station || "").replace("K", ""); 
    const regex = new RegExp(`(temperatur|highs?|lows?|warm|cool|heat|bust|overachiev|${stidSearch})`, 'i');
    
    for (let s of sentences) {
        if (regex.test(s) && s.length > 15 && s.length < 300) insights.push(s.trim());
    }
    res.json({ insights: insights.slice(0, 3) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.listen(PORT, () => console.log(`🌤️ Dashboard running at http://localhost:${PORT}`));