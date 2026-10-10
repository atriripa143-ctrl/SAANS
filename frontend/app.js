
const API_BASE = "https://q87la9nm10.execute-api.ap-south-1.amazonaws.com";
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";

const DEFAULT_LOCATION = {
  name: "Kolkata, West Bengal, India",
  latitude: 22.5726,
  longitude: 88.3639
};

let selectedLocation = { ...DEFAULT_LOCATION };
let currentAir = null;
let chatHistory = [];
let lastHistory = [];

const $ = (id) => document.getElementById(id);

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value == null ? "" : String(value);
}

function numberText(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(1).replace(/\.0$/, "") : "--";
}

function locationSlug(value) {
  return String(value || "unknown-location")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "unknown-location";
}

function buttonLoading(button, loading, loadingText, defaultText) {
  if (!button) return;
  if (loading) {
    if (!button.disabled) button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = loadingText;
  } else {
    button.disabled = false;
    button.textContent = defaultText || button.dataset.originalText || button.textContent;
  }
}

async function getJSON(url, options = {}) {
  const response = await fetch(url, options);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("The server returned an unreadable response.");
  }
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  return data;
}

function ratingFor(aqi) {
  const value = Number(aqi);
  if (!Number.isFinite(value)) {
    return {
      color: "neutral",
      label: "UNAVAILABLE",
      title: "Rating unavailable",
      advice: "No valid AQI reading is available for this location."
    };
  }
  if (value <= 50) {
    return {
      color: "green",
      label: "GREEN",
      title: "Lower screening concern",
      advice: "Outdoor air is in the lowest SAANS screening band. Continue normal precautions and check again if conditions change."
    };
  }
  if (value <= 100) {
    return {
      color: "yellow",
      label: "YELLOW",
      title: "Use extra awareness",
      advice: "Sensitive people may wish to reduce prolonged or strenuous outdoor activity if they notice symptoms. Check conditions again later."
    };
  }
  return {
    color: "red",
    label: "RED",
    title: "Higher screening concern",
    advice: "Consider reducing prolonged or strenuous outdoor exposure, especially for sensitive groups. Follow local public-health advice."
  };
}

function updateAirUI(data) {
  currentAir = data.air || null;
  const aqi = currentAir?.aqi_indicator;
  const rating = ratingFor(aqi);
  const validAQI = aqi !== null && aqi !== undefined && Number.isFinite(Number(aqi));

  setText("aqi", validAQI ? Math.round(Number(aqi)) : "--");

  const status = $("aqiStatus");
  if (status) {
    status.className = `status ${rating.color}`;
    status.textContent = validAQI ? `${rating.label} · ${rating.title}` : "Waiting for data";
  }

  setText("aqiDescription", rating.advice);
  setText("pm25", numberText(currentAir?.pm25));
  setText("pm10", numberText(currentAir?.pm10));
  setText("no2", numberText(currentAir?.no2));
  setText("o3", numberText(currentAir?.o3));
  setText("dataTimestamp", new Date().toLocaleString());
  setText("dataSource", "Open-Meteo Air Quality");
  setText("historyLocation", selectedLocation.name);
  setText(
    "refreshMessage",
    data.history_saved
      ? "Readings loaded and a record was saved to trend history."
      : "Readings loaded, but history saving was not confirmed. Check DynamoDB setup."
  );

  updatePlaceRating();
  calculateExposure();
}

async function loadAirQuality() {
  const button = $("refreshAir");
  buttonLoading(button, true, "Refreshing...", "Refresh readings");
  setText("refreshMessage", "Requesting current outdoor readings...");

  try {
    const params = new URLSearchParams({
      latitude: String(selectedLocation.latitude),
      longitude: String(selectedLocation.longitude),
      location: selectedLocation.name
    });

    const data = await getJSON(`${API_BASE}/air?${params.toString()}`);
    if (!data.air) throw new Error("The API response did not contain air-quality data.");

    updateAirUI(data);
    await loadHistory();
  } catch (error) {
    setText("refreshMessage", `Unable to load air quality: ${error.message}`);
    setText("aqiDescription", "Check your connection and the SAANS API deployment.");
  } finally {
    buttonLoading(button, false, "", "Refresh readings");
  }
}

async function searchLocations(query) {
  const params = new URLSearchParams({
    name: query,
    count: "10",
    language: "en",
    format: "json"
  });

  const data = await getJSON(`${GEOCODING_URL}?${params.toString()}`);
  return (data.results || []).filter(
    item => !item.country_code || item.country_code.toUpperCase() === "IN"
  );
}

function formatLocation(item) {
  return [item.name, item.admin1, item.country].filter(Boolean).join(", ");
}

async function handleLocationSearch(event) {
  event.preventDefault();
  const query = $("locationSearch").value.trim();

  if (!query) {
    setText("locationMessage", "Enter a city or place name.");
    return;
  }

  const button = $("searchLocationBtn");
  buttonLoading(button, true, "Searching...", "Search");
  setText("locationMessage", "Searching locations...");

  try {
    const results = await searchLocations(query);
    const select = $("locationResults");
    const wrap = $("locationResultsWrap");
    select.replaceChildren();

    if (!results.length) {
      wrap.classList.add("hidden");
      setText("locationMessage", "No matching Indian locations found. Try another city name.");
      return;
    }

    results.forEach((item, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = formatLocation(item);
      select.appendChild(option);
    });

    select._locationResults = results;
    wrap.classList.remove("hidden");
    select.value = "0";
    applySelectedSearchResult();
    setText("locationMessage", `${results.length} matching location(s) found.`);
  } catch (error) {
    setText("locationMessage", `Location search failed: ${error.message}`);
  } finally {
    buttonLoading(button, false, "", "Search");
  }
}

function applySelectedSearchResult() {
  const select = $("locationResults");
  const item = select?._locationResults?.[Number(select.value)];
  if (!item) return;

  selectedLocation = {
    name: formatLocation(item),
    latitude: Number(item.latitude),
    longitude: Number(item.longitude)
  };

  setText("selectedLocation", selectedLocation.name);
  setText("historyLocation", selectedLocation.name);
  loadAirQuality();
}

function useMyLocation() {
  if (!navigator.geolocation) {
    setText("locationMessage", "Location access is not supported by this browser. Search for a city instead.");
    return;
  }

  setText("locationMessage", "Requesting location permission...");

  navigator.geolocation.getCurrentPosition(
    position => {
      selectedLocation = {
        name: `My location (${position.coords.latitude.toFixed(3)}, ${position.coords.longitude.toFixed(3)})`,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude
      };

      setText("selectedLocation", selectedLocation.name);
      setText("locationMessage", "Using coordinates shared by your browser.");
      loadAirQuality();
    },
    () => setText("locationMessage", "Location permission was denied or unavailable. Search for a city instead."),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
}

function updatePlaceRating() {
  const result = $("placeResult");
  if (!result) return;

  const rating = ratingFor(currentAir?.aqi_indicator);
  const aqi = Number(currentAir?.aqi_indicator);
  const valid = currentAir?.aqi_indicator != null && Number.isFinite(aqi);
  const name = $("placeName")?.value.trim();
  const type = $("placeType")?.value || "Public outdoor space";
  const place = name || type;

  result.replaceChildren();

  const light = document.createElement("div");
  light.className = `place-light ${rating.color === "neutral" ? "neutral-light" : `${rating.color}-light`}`;

  const dot = document.createElement("span");
  dot.className = "light-dot";
  light.appendChild(dot);

  const content = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = valid
    ? `${rating.label}: ${place} — ${rating.title}`
    : "Rating unavailable";

  const description = document.createElement("p");
  description.textContent = valid
    ? `${selectedLocation.name}: provider-reported US AQI ${Math.round(aqi)}. ${rating.advice}`
    : "Load valid outdoor air-quality data first. This tool does not measure indoor air.";

  content.append(title, description);
  result.append(light, content);
}

function calculateExposure() {
  const output = $("exposureResult");
  if (!output) return;

  const rawAQI = currentAir?.aqi_indicator;
  const aqi = Number(rawAQI);

  if (rawAQI == null || !Number.isFinite(aqi)) {
    output.textContent = "Air-quality data is not available yet. Refresh the readings first.";
    return;
  }

  const profile = $("profile").value;
  const activity = $("activity").value;
  const duration = Number($("duration").value);

  const profileFactor = {
    adult: 1,
    child: 1.25,
    elderly: 1.2,
    worker: 1.15,
    sensitive: 1.35
  }[profile] || 1;

  const activityFactor = activity === "outdoor" ? 1 : 0.55;
  const durationFactor = Math.min(duration / 60, 8);
  const score = Math.max(
    0,
    Math.min(100, Math.round((Math.max(0, aqi) / 150) * 35 * profileFactor * activityFactor * durationFactor))
  );

  const level = score < 25
    ? "lower relative estimate"
    : score < 55
      ? "moderate relative estimate"
      : "higher relative estimate";

  output.textContent =
    `Estimated exposure score: ${score}/100 (${level}). ` +
    "This simplified score compares scenarios using the current provider-reported AQI, selected profile, activity and duration. " +
    "It is not a measured dose, a prediction of illness, or medical advice.";
}

async function loadHistory() {
  const params = new URLSearchParams({
    location: selectedLocation.name,
    limit: "48"
  });

  setText("historyMessage", "Loading saved readings...");

  try {
    const data = await getJSON(`${API_BASE}/history?${params.toString()}`);
    lastHistory = Array.isArray(data.records) ? data.records : [];

    setText(
      "historyCount",
      `${lastHistory.length} record${lastHistory.length === 1 ? "" : "s"}`
    );

    if (lastHistory.length < 2) {
      setText(
        "historyMessage",
        lastHistory.length === 1
          ? "One reading is saved. Refresh later to create another point and compare changes."
          : "No saved readings yet. Refresh air quality after DynamoDB is configured."
      );
    } else {
      setText("historyMessage", `Showing ${lastHistory.length} saved reading(s), oldest to newest.`);
    }

    drawHistoryChart(lastHistory);
  } catch (error) {
    lastHistory = [];
    setText("historyCount", "History unavailable");
    setText("historyMessage", `Could not load stored history: ${error.message}`);
    drawHistoryChart([]);
  }
}

function drawHistoryChart(records) {
  const canvas = $("historyChart");
  if (!canvas) return;

  const width = Math.max(300, Math.floor(canvas.getBoundingClientRect().width));
  const height = Math.max(180, Math.floor(canvas.getBoundingClientRect().height));
  const ratio = window.devicePixelRatio || 1;

  canvas.width = width * ratio;
  canvas.height = height * ratio;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = { left: 42, right: 16, top: 20, bottom: 36 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  const sorted = [...records].sort(
    (a, b) => String(a.timestamp).localeCompare(String(b.timestamp))
  );

  const aqiValues = sorted.map(r => Number(r.aqi)).filter(Number.isFinite);
  const pmValues = sorted.map(r => Number(r.pm25)).filter(Number.isFinite);
  const maxValue = Math.max(100, ...aqiValues, ...pmValues);

  ctx.font = "11px DM Sans, sans-serif";
  ctx.fillStyle = "#63756e";
  ctx.strokeStyle = "#e5ece7";
  ctx.lineWidth = 1;

  for (let i = 0; i <= 4; i++) {
    const y = pad.top + chartH * i / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(maxValue * (1 - i / 4))), 4, y + 4);
  }

  if (sorted.length < 2) {
    ctx.fillStyle = "#63756e";
    ctx.textAlign = "center";
    ctx.font = "13px DM Sans, sans-serif";
    ctx.fillText("Two or more saved readings are needed.", width / 2, height / 2);
    ctx.textAlign = "left";
    return;
  }

  const xAt = i => pad.left + i * chartW / (sorted.length - 1);
  const yAt = value => pad.top + chartH - (Math.max(0, value) / maxValue) * chartH;

  function plot(key, color) {
    const points = sorted.map((record, index) => ({
      x: xAt(index),
      y: yAt(Number(record[key]))
    })).filter(point => Number.isFinite(point.y));

    if (!points.length) return;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();

    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });

    ctx.stroke();
    ctx.fillStyle = color;

    points.forEach(point => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  plot("aqi", "#267c58");
  plot("pm25", "#d69b00");

  ctx.fillStyle = "#63756e";
  ctx.textAlign = "center";

  [0, Math.floor((sorted.length - 1) / 2), sorted.length - 1].forEach(index => {
    const date = new Date(sorted[index].timestamp);
    const label = Number.isNaN(date.getTime())
      ? ""
      : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    ctx.fillText(label, xAt(index), height - 10);
  });

  ctx.textAlign = "left";
}

function addChatMessage(role, text) {
  const container = $("chatMessages");
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role === "user" ? "user-bubble" : "assistant-bubble"}`;

  const label = document.createElement("strong");
  label.textContent = role === "user" ? "You" : "SAANS AI";

  const paragraph = document.createElement("p");
  paragraph.textContent = text;

  bubble.append(label, paragraph);
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  return bubble;
}

async function askSAANS(event) {
  event.preventDefault();

  const input = $("question");
  const question = input.value.trim();
  if (!question) return;

  addChatMessage("user", question);
  input.value = "";

  const pending = addChatMessage("assistant", "Thinking...");
  const button = $("askButton");
  buttonLoading(button, true, "Thinking...", "Send question");

  try {
    const payload = {
      message: question,
      history: chatHistory.slice(-8),
      location: selectedLocation.name,
      air: currentAir ? {
        pm25: currentAir.pm25,
        pm10: currentAir.pm10,
        no2: currentAir.no2,
        o3: currentAir.o3,
        aqi_indicator: currentAir.aqi_indicator
      } : null
    };

    const data = await getJSON(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const answer = data.answer || "I couldn't generate an answer just now.";
    pending.querySelector("p").textContent = answer;

    chatHistory.push(
      { role: "user", content: question },
      { role: "assistant", content: answer }
    );
    chatHistory = chatHistory.slice(-8);
  } catch (error) {
    pending.querySelector("p").textContent =
      `I couldn't connect to the AI service: ${error.message} ` +
      "Check the /chat API route, Bedrock model access, and Lambda permissions.";
  } finally {
    buttonLoading(button, false, "", "Send question");
  }
}

function setup() {
  $("locationForm")?.addEventListener("submit", handleLocationSearch);
  $("locationResults")?.addEventListener("change", applySelectedSearchResult);
  $("useMyLocation")?.addEventListener("click", useMyLocation);
  $("refreshAir")?.addEventListener("click", loadAirQuality);
  $("checkPlace")?.addEventListener("click", updatePlaceRating);
  $("placeName")?.addEventListener("input", updatePlaceRating);
  $("placeType")?.addEventListener("change", updatePlaceRating);
  $("calculateExposureBtn")?.addEventListener("click", calculateExposure);
  $("refreshHistory")?.addEventListener("click", loadHistory);
  $("chatForm")?.addEventListener("submit", askSAANS);

  document.querySelectorAll("[data-question]").forEach(button => {
    button.addEventListener("click", () => {
      $("question").value = button.dataset.question || "";
      $("question").focus();
    });
  });

  window.addEventListener("resize", () => drawHistoryChart(lastHistory));
  loadAirQuality();
}

document.addEventListener("DOMContentLoaded", setup);
