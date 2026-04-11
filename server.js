import express from "express";

const app = express();
const PORT = process.env.PORT || 5179;

// Serve the index.html file and any static assets
app.use(express.static(process.cwd(), { extensions: ["html"] }));

const apiCache = {};
const CACHE_TTL_MS = 60 * 1000; // 1 minute cache TTL

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
  const url = `https://aviationweather.gov/api/data/metar?ids=${stid}&format=json&hours=48`;
  
  try {
    const { status, ok, body } = await getCachedOrFetch(`awc_metar_48h_${stid}`, url, { 
      "User-Agent": "WeatherDashboard/1.0 (PredictionApp)",
      "Accept": "application/json"
    });

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

// NEW: Proxy for NWS Gridpoint Forecasts
app.get("/api/nws_forecast", async (req, res) => {
  const lat = req.query.lat;
  const lon = req.query.lon;
  
  if (!lat || !lon) return res.status(400).json({ error: "Missing lat/lon" });

  const cacheKey = `nws_forecast_${lat}_${lon}`;
  
  try {
    // Step 1: Get the Gridpoint URL for these coordinates
    const pointsUrl = `https://api.weather.gov/points/${lat},${lon}`;
    const pointsHeaders = {
        "User-Agent": "Mozilla/5.0 (compatible; MarketPredictionApp/1.0; nathan@example.com)",
        "Accept": "application/geo+json"
    };

    let pointsResponse = await getCachedOrFetch(`nws_points_${lat}_${lon}`, pointsUrl, pointsHeaders);
    if (!pointsResponse.ok) return res.status(pointsResponse.status).send(pointsResponse.body);
    
    const pointsData = JSON.parse(pointsResponse.body);
    const forecastHourlyUrl = pointsData.properties.forecastHourly;

    if (!forecastHourlyUrl) throw new Error("NWS did not return an hourly forecast URL");

    // Step 2: Fetch the actual hourly forecast
    const { status, ok, body } = await getCachedOrFetch(cacheKey, forecastHourlyUrl, pointsHeaders);
    
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