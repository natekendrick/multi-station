import express from "express";

const app = express();
const PORT = process.env.PORT || 5179;

app.use(express.static(process.cwd(), { extensions: ["html"] }));

const apiCache = {};
const CACHE_TTL_MS = 60 * 1000; 

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

// Proxy for Aviation Weather Center (Historical / Current METARs)
app.get("/api/awc_metar", async (req, res) => {
  const stid = (req.query.station || "KSFO").toString().toUpperCase();
  const url = `https://aviationweather.gov/api/data/metar?ids=${stid}&format=json&hours=48`;
  
  try {
    const { status, ok, body } = await getCachedOrFetch(`awc_metar_48h_${stid}`, url, { 
      "User-Agent": "WeatherDashboard/1.0 (PredictionApp)",
      "Accept": "application/json"
    });
    if (status === 204) return res.json([]); 
    if (!ok) return res.status(status).send(body);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(body);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Proxy for NWS Gridpoint Forecasts
app.get("/api/nws_forecast", async (req, res) => {
  const lat = req.query.lat;
  const lon = req.query.lon;
  if (!lat || !lon) return res.status(400).json({ error: "Missing lat/lon" });

  try {
    const pointsUrl = `https://api.weather.gov/points/${lat},${lon}`;
    const headers = {
        "User-Agent": "Mozilla/5.0 (compatible; MarketPredictionApp/1.0; dev@example.com)",
        "Accept": "application/geo+json"
    };

    let pRes = await getCachedOrFetch(`nws_points_${lat}_${lon}`, pointsUrl, headers);
    if (!pRes.ok) return res.status(pRes.status).send(pRes.body);
    
    const pointsData = JSON.parse(pRes.body);
    const forecastHourlyUrl = pointsData.properties.forecastHourly;
    if (!forecastHourlyUrl) throw new Error("No NWS hourly forecast URL");

    const { status, ok, body } = await getCachedOrFetch(`nws_forecast_${lat}_${lon}`, forecastHourlyUrl, headers);
    if (!ok) return res.status(status).send(body);
    
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(body);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Proxy for Weather Underground (using your provided API key)
app.get("/api/wu_forecast", async (req, res) => {
  const lat = req.query.lat;
  const lon = req.query.lon;
  if (!lat || !lon) return res.status(400).json({ error: "Missing lat/lon" });

  const url = `https://api.weather.com/v3/wx/forecast/hourly/2day?apiKey=e1f10a1e78da46f5b10a1e78da96f525&geocode=${lat},${lon}&format=json&units=e&language=en-US`;
  try {
    const { status, ok, body } = await getCachedOrFetch(`wu_forecast_${lat}_${lon}`, url);
    if (!ok) return res.status(status).send(body);
    
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(body);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`🌤️ Aggregator Dashboard running at http://localhost:${PORT}`);
});