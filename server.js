import express from "express";
import fs from "fs/promises";
import path from "path";

const app = express();
const PORT = process.env.PORT || 5179;

app.use(express.json());
app.use(express.static(process.cwd(), { extensions: ["html"] }));

const STATIONS = [
  { id: "KBOS", name: "Boston", lat: 42.3656, lon: -71.0096, tz: "America/New_York" },
  { id: "KLGA", name: "LaGuardia", lat: 40.7769, lon: -73.8740, tz: "America/New_York" },
  { id: "KPHL", name: "Philadelphia", lat: 39.8729, lon: -75.2437, tz: "America/New_York" },
  { id: "KDCA", name: "Washington Reagan", lat: 38.8512, lon: -77.0402, tz: "America/New_York" },
  { id: "KMIA", name: "Miami", lat: 25.7959, lon: -80.2870, tz: "America/New_York" },
  { id: "KCLT", name: "Charlotte", lat: 35.2140, lon: -80.9431, tz: "America/New_York" },
  { id: "KJAX", name: "Jacksonville", lat: 30.4941, lon: -81.6879, tz: "America/New_York" },
  { id: "KDTW", name: "Detroit", lat: 42.2121, lon: -83.3533, tz: "America/Detroit" },
  { id: "KATL", name: "Atlanta", lat: 33.6407, lon: -84.4277, tz: "America/New_York" },
  { id: "KBNA", name: "Nashville", lat: 36.1263, lon: -86.6774, tz: "America/Chicago" },
  { id: "KMDW", name: "Chicago Midway", lat: 41.7868, lon: -87.7522, tz: "America/Chicago" },
  { id: "KMSP", name: "Minneapolis", lat: 44.8848, lon: -93.2223, tz: "America/Chicago" },
  { id: "KHOU", name: "Houston Hobby", lat: 29.6454, lon: -95.2789, tz: "America/Chicago" },
  { id: "KDFW", name: "Dallas/Fort Worth", lat: 32.8998, lon: -97.0403, tz: "America/Chicago" },
  { id: "KOKC", name: "Oklahoma City", lat: 35.3931, lon: -97.6008, tz: "America/Chicago" },
  { id: "KAUS", name: "Austin", lat: 30.1900, lon: -97.6687, tz: "America/Chicago" },
  { id: "KSAT", name: "San Antonio", lat: 29.5337, lon: -98.4698, tz: "America/Chicago" },
  { id: "KBKF", name: "Denver Buckley", lat: 39.7017, lon: -104.7517, tz: "America/Denver" },
  { id: "KPHX", name: "Phoenix", lat: 33.4342, lon: -112.0116, tz: "America/Phoenix" },
  { id: "KLAS", name: "Las Vegas", lat: 36.0840, lon: -115.1536, tz: "America/Los_Angeles" },
  { id: "KLAX", name: "Los Angeles", lat: 33.9416, lon: -118.4085, tz: "America/Los_Angeles" },
  { id: "KSEA", name: "Seattle", lat: 47.4502, lon: -122.3088, tz: "America/Los_Angeles" },
  { id: "KSFO", name: "San Francisco", lat: 37.6196, lon: -122.3656, tz: "America/Los_Angeles" }
];

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd();
const CACHE_FILE = path.join(DATA_DIR, "forecast_history.json");

let memoryDB = {};
let currentDashboardState = []; // Holds the pre-compiled UI data for the frontend
let isFetching = false;

// --- UTILS ---
const toF = (c) => (c * 9/5) + 32;

function getStationLocalDateString(dateMs, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(dateMs));
}
function getPTMilitaryTime(dateMs) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(dateMs));
}
function extractTimeMs(obs) {
  if (!obs) return null;
  if (typeof obs.obsTime === 'number') return obs.obsTime * 1000;
  if (typeof obs.reportTime === 'string') return Date.parse(obs.reportTime);
  if (typeof obs.obsTime === 'string') return Date.parse(obs.obsTime);
  return null;
}

async function safeFetch(url, isJson = true, headers = {}) {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return isJson ? await res.json() : await res.text();
  } catch (e) {
    return null;
  }
}

const nwsGridCache = {};
async function getNwsHourlyUrl(lat, lon) {
  const key = `${lat},${lon}`;
  if (nwsGridCache[key]) return nwsGridCache[key];
  const data = await safeFetch(`https://api.weather.gov/points/${lat},${lon}`, true, { "User-Agent": "DashboardApp/1.0" });
  if (data && data.properties) {
      nwsGridCache[key] = data.properties.forecastHourly;
      return nwsGridCache[key];
  }
  return null;
}

function saveForecastToMemory(stid, dateStr, model, temp, time) {
  if (temp === "Err" || temp === "—" || temp == null) return;
  if (!memoryDB[stid]) memoryDB[stid] = {};
  if (!memoryDB[stid][dateStr]) memoryDB[stid][dateStr] = {};

  let existing = memoryDB[stid][dateStr][model];

  if (!existing) {
    memoryDB[stid][dateStr][model] = { temp, time, initialTemp: temp, history: [{ ts: Date.now(), temp, time }] };
  } else {
    existing.temp = temp;
    existing.time = time;
    if (!existing.initialTemp) existing.initialTemp = temp; 
    if (!existing.history) existing.history = [{ ts: Date.now() - 600000, temp: existing.initialTemp, time }];
    
    existing.history.push({ ts: Date.now(), temp, time });
    if (existing.history.length > 288) existing.history.shift(); // Cap at ~48 hours of 10-min dots
  }
}

// --- ENGINE ---
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

async function fetchStationData(st) {
    const nowMs = Date.now();
    const todayStr = getStationLocalDateString(nowMs, st.tz);
    const yesterdayStr = getStationLocalDateString(nowMs - 86400000, st.tz);
    const dayBeforeStr = getStationLocalDateString(nowMs - 86400000 * 2, st.tz);
    const tmrwStr = getStationLocalDateString(nowMs + 86400000, st.tz);

    const stHistory = memoryDB[st.id] || {};
    const todayHistory = stHistory[todayStr] || {};
    const yestHistory = stHistory[yesterdayStr] || {};
    const dayBeforeHistory = stHistory[dayBeforeStr] || {};

    const getCombinedHistory = (model) => {
        let combined = [
            ...(dayBeforeHistory[model]?.history || []),
            ...(yestHistory[model]?.history || []),
            ...(todayHistory[model]?.history || [])
        ];
        combined.sort((a, b) => a.ts - b.ts);
        return combined;
    };

    // Execute API Calls
    const pAWC = safeFetch(`https://aviationweather.gov/api/data/metar?ids=${st.id}&format=json&hours=48`, false);
    const nwsUrl = await getNwsHourlyUrl(st.lat, st.lon);
    const pNWS = nwsUrl ? safeFetch(nwsUrl, true, { "User-Agent": "DashboardApp/1.0" }) : Promise.resolve(null);
    const pWU = safeFetch(`https://api.weather.com/v3/wx/forecast/hourly/2day?apiKey=e1f10a1e78da46f5b10a1e78da96f525&geocode=${st.lat},${st.lon}&format=json&units=e&language=en-US`);
    const pOM = safeFetch(`https://api.open-meteo.com/v1/forecast?latitude=${st.lat}&longitude=${st.lon}&hourly=temperature_2m&past_days=1&forecast_days=2&temperature_unit=fahrenheit&timezone=auto&timeformat=unixtime`);
    const pWUCurr = safeFetch(`https://api.weather.com/v3/wx/observations/current?apiKey=e1f10a1e78da46f5b10a1e78da96f525&geocode=${st.lat},${st.lon}&format=json&units=e&language=en-US`);

    const [resAWC, resNWS, resWU, resOM, resWUCurr] = await Promise.all([pAWC, pNWS, pWU, pOM, pWUCurr]);

    // 1. Process AWC
    let currentTempF = "—", obsTimeStr = "—", yestActualF = "—", yestActualTime = "—";
    let actualTodayC = -999, actualTodayTime = null;

    if (resAWC) {
       let awcData = [];
       try { awcData = JSON.parse(resAWC); } catch(e){}
       let obsList = Array.isArray(awcData) ? awcData : (awcData.data || []);
       
       const latest = obsList[0];
       if (latest && latest.temp != null) {
           currentTempF = toF(latest.temp).toFixed(1);
           const latestMs = extractTimeMs(latest);
           obsTimeStr = latestMs ? getPTMilitaryTime(latestMs) : "—";
       }

       let yestMaxC = -999, yMaxTime = null;
       obsList.forEach(obs => {
         const ms = extractTimeMs(obs);
         if (ms && obs.temp != null) {
             const obsDateStr = getStationLocalDateString(ms, st.tz);
             if (obsDateStr === yesterdayStr) {
               if (obs.temp > yestMaxC) { yestMaxC = obs.temp; yMaxTime = ms; }
             } else if (obsDateStr === todayStr) {
               if (obs.temp > actualTodayC) { actualTodayC = obs.temp; actualTodayTime = ms; }
             }
         }
       });
       if (yestMaxC !== -999) {
           yestActualF = toF(yestMaxC).toFixed(1);
           yestActualTime = getPTMilitaryTime(yMaxTime);
       }
    }

    let actualTodayF = -999;
    if (actualTodayC !== -999) actualTodayF = parseFloat(toF(actualTodayC).toFixed(1));

    // 2. Process NWS
    let nwsToday = null, nwsTodayTime = null, nwsTmrw = null, nwsTmrwTime = null;
    if (resNWS) {
        let maxT = -999, maxTTm = null, maxTm = -999, maxTmTm = null;
        const periods = resNWS.properties?.periods || [];
        periods.forEach(p => {
            const ms = Date.parse(p.startTime);
            const dateStr = getStationLocalDateString(ms, st.tz);
            if (dateStr === todayStr && p.temperature > maxT) { maxT = p.temperature; maxTTm = ms; }
            if (dateStr === tmrwStr && p.temperature > maxTm) { maxTm = p.temperature; maxTmTm = ms; }
        });
        if (actualTodayF !== -999 && actualTodayF > maxT) { maxT = actualTodayF; maxTTm = actualTodayTime; }
        if (maxT !== -999) { nwsToday = maxT.toFixed(1); nwsTodayTime = typeof maxTTm === 'number' ? getPTMilitaryTime(maxTTm) : maxTTm; }
        if (maxTm !== -999) { nwsTmrw = maxTm.toFixed(1); nwsTmrwTime = getPTMilitaryTime(maxTmTm); }
    } else { nwsToday = "Err"; nwsTmrw = "Err"; }

    // 3. Process WU
    let wuToday = null, wuTodayTime = null, wuTmrw = null, wuTmrwTime = null;
    if (resWU) {
        let maxT = -999, maxTTm = null, maxTm = -999, maxTmTm = null;
        const tArr = resWU.temperature || [];
        const timeArr = resWU.validTimeLocal || [];
        for(let i=0; i<tArr.length; i++) {
            const ms = Date.parse(timeArr[i]);
            const dateStr = getStationLocalDateString(ms, st.tz);
            if (dateStr === todayStr && tArr[i] > maxT) { maxT = tArr[i]; maxTTm = ms; }
            if (dateStr === tmrwStr && tArr[i] > maxTm) { maxTm = tArr[i]; maxTmTm = ms; }
        }
        if (actualTodayF !== -999 && actualTodayF > maxT) { maxT = actualTodayF; maxTTm = actualTodayTime; }
        if (maxT !== -999) { wuToday = maxT.toFixed(1); wuTodayTime = typeof maxTTm === 'number' ? getPTMilitaryTime(maxTTm) : getPTMilitaryTime(maxTTm); }
        if (maxTm !== -999) { wuTmrw = maxTm.toFixed(1); wuTmrwTime = getPTMilitaryTime(maxTmTm); }
    } else { wuToday = "Err"; wuTmrw = "Err"; }

    // 4. Process OM
    let omYest = null, omYestTime = null, omToday = null, omTodayTime = null, omTmrw = null, omTmrwTime = null;
    if (resOM) {
        const h = resOM.hourly || {};
        const hours = h.time || [], temps = h.temperature_2m || [];
        
        let yT = -999, yTm = null, tT = -999, tTm = null, tmT = -999, tmTm = null;
        for(let i=0; i<hours.length; i++) {
            const ms = hours[i] * 1000;
            const dateStr = getStationLocalDateString(ms, st.tz);
            if (dateStr === yesterdayStr && temps[i] > yT) { yT = temps[i]; yTm = ms; }
            if (dateStr === todayStr && temps[i] > tT) { tT = temps[i]; tTm = ms; }
            if (dateStr === tmrwStr && temps[i] > tmT) { tmT = temps[i]; tmTm = ms; }
        }
        if (actualTodayF !== -999 && actualTodayF > tT) { tT = actualTodayF; tTm = actualTodayTime; }
        if (yT !== -999) { omYest = yT.toFixed(1); omYestTime = getPTMilitaryTime(yTm); }
        if (tT !== -999) { omToday = tT.toFixed(1); omTodayTime = typeof tTm === 'number' ? getPTMilitaryTime(tTm) : getPTMilitaryTime(tTm); }
        if (tmT !== -999) { omTmrw = tmT.toFixed(1); omTmrwTime = getPTMilitaryTime(tmTm); }
    } else { omYest = "Err"; omToday = "Err"; omTmrw = "Err"; }

    // 5. Process WU Current
    let wuCurrentTempF = "—";
    let wuCurrentTimeMs = Date.now();
    if (resWUCurr && resWUCurr.temperature != null) {
        wuCurrentTempF = resWUCurr.temperature.toFixed(1);
    }

    saveForecastToMemory(st.id, todayStr, "NWS", nwsToday, nwsTodayTime);
    saveForecastToMemory(st.id, todayStr, "WU", wuToday, wuTodayTime);
    saveForecastToMemory(st.id, todayStr, "OM", omToday, omTodayTime);
    if (wuCurrentTempF !== "—") saveForecastToMemory(st.id, todayStr, "OBS", wuCurrentTempF, getPTMilitaryTime(wuCurrentTimeMs));

    return {
      id: st.id, name: st.name,
      currentTempF, obsTimeStr, yestActualF, yestActualTime,
      wuCurrentTempF,
      nwsToday, nwsTodayTime, nwsTmrw, nwsTmrwTime, 
      wuToday, wuTodayTime, wuTmrw, wuTmrwTime, 
      omToday, omTodayTime, omTmrw, omTmrwTime, omYest, omYestTime,
      
      wuYestTemp: yestHistory["WU"] ? yestHistory["WU"].temp : "—", wuYestTime: yestHistory["WU"] ? yestHistory["WU"].time : "",
      
      nwsTodayCache: memoryDB[st.id][todayStr]["NWS"] || {}, 
      wuTodayCache: memoryDB[st.id][todayStr]["WU"] || {}, 
      omTodayCache: memoryDB[st.id][todayStr]["OM"] || {},

      nwsCombinedHistory: getCombinedHistory("NWS"),
      wuCombinedHistory: getCombinedHistory("WU"),
      omCombinedHistory: getCombinedHistory("OM"),
      obsCombinedHistory: getCombinedHistory("OBS")
    };
}

async function updateAllStations() {
    if(isFetching) return;
    isFetching = true;
    console.log(`[${new Date().toISOString()}] Background Fetch Cycle Started...`);
    
    let newResults = [];
    for (let st of STATIONS) {
        try {
            const data = await fetchStationData(st);
            newResults.push(data);
        } catch(e) {
            console.error(`Error processing ${st.id}:`, e);
            const old = currentDashboardState.find(d => d.id === st.id);
            if(old) newResults.push(old);
        }
        await new Promise(r => setTimeout(r, 250)); // Gentle API staggering
    }
    
    currentDashboardState = newResults;
    
    try {
        await fs.writeFile(CACHE_FILE, JSON.stringify(memoryDB, null, 2));
    } catch(e) { console.error("Disk write failed", e); }
    
    isFetching = false;
    console.log(`[${new Date().toISOString()}] Cycle Complete. UI Updated.`);
}

// Start Background Engine
initDB().then(() => {
    updateAllStations();
    setInterval(updateAllStations, 10 * 60 * 1000); // Exact 10 minute engine loop
});

// Serve frontend pre-compiled data
app.get("/api/dashboard", (req, res) => {
    res.json(currentDashboardState);
});

app.listen(PORT, () => console.log(`🌤️ Dashboard running at http://localhost:${PORT}`));