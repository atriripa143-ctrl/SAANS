
"use strict";

// ============================================
// SAANS - India-wide air-quality dashboard
// AWS Lambda + API Gateway + Open-Meteo
// ============================================

const API_URL =
  "https://q87la9nm10.execute-api.ap-south-1.amazonaws.com/air";

const GEOCODING_URL =
  "https://geocoding-api.open-meteo.com/v1/search";

let selectedLocation = {
  name: "Kolkata",
  admin1: "West Bengal",
  country: "India",
  lat: 22.5726,
  lon: 88.3639
};

let currentAir = {
  pm25: null,
  pm10: null,
  no2: null,
  o3: null,
  aqi: null
};

let latestApiResult = null;
let searchResults = [];
let requestVersion = 0;

// ============================================
// HELPERS
// ============================================

function el(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const node = el(id);
  if (node) {
    node.textContent =
      value === null || value === undefined || value === ""
        ? "--"
        : String(value);
  }
}

function showResult(id, message) {
  const node = el(id);
  if (!node) return;
  node.textContent = message;
  node.classList.remove("hidden");
}

function hideResult(id) {
  const node = el(id);
  if (node) node.classList.add("hidden");
}

function setStatus(node, status) {
  if (!node) return;

  node.classList.remove(
    "green", "yellow", "orange", "red",
    "low", "moderate", "high", "very-high"
  );

  node.classList.add(
    String(status || "")
      .toLowerCase()
      .replace(/\s+/g, "-")
  );
}

function numericValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function displayNumber(value) {
  const number = numericValue(value);
  return number === null ? "--" : number.toFixed(1);
}

function locationLabel(location) {
  return [
    location.name,
    location.admin1,
    location.country || "India"
  ].filter(Boolean).join(", ");
}

// ============================================
// INDIA-WIDE LOCATION SEARCH
// ============================================

async function searchLocations() {
  const query = el("locationSearch")?.value.trim();
  const message = el("locationMessage");
  const select = el("locationResults");
  const button = el("searchLocationBtn");

  if (!query || query.length < 2) {
    setText("locationMessage", "Enter at least 2 characters.");
    return;
  }

  if (button) button.disabled = true;
  setText("locationMessage", "Searching Indian locations…");

  if (select) {
    select.hidden = true;
    select.innerHTML =
      '<option value="">Select a location</option>';
  }

  try {
    const params = new URLSearchParams({
      name: query,
      count: "100",
      language: "en",
      format: "json"
    });

    const response = await fetch(
      `${GEOCODING_URL}?${params.toString()}`
    );

    if (!response.ok) {
      throw new Error(`Location search failed: HTTP ${response.status}`);
    }

    const data = await response.json();

    // Filter results to India only.
    searchResults = (data.results || []).filter(place =>
      String(place.country_code || "").toUpperCase() === "IN" &&
      Number.isFinite(Number(place.latitude)) &&
      Number.isFinite(Number(place.longitude))
    );

    if (!select || searchResults.length === 0) {
      setText(
        "locationMessage",
        "No matching Indian locations found. Try another spelling."
      );
      return;
    }

    searchResults.forEach((place, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = [
        place.name,
        place.admin1,
        place.admin2,
        "India"
      ].filter(Boolean).join(", ");
      select.appendChild(option);
    });

    select.hidden = false;
    setText(
      "locationMessage",
      `Found ${searchResults.length} matching locations. Select one below.`
    );

  } catch (error) {
    console.error("SAANS location search error:", error);
    setText(
      "locationMessage",
      "Location search failed. Check your internet connection and try again."
    );
  } finally {
    if (button) button.disabled = false;
  }
}

function selectSearchResult() {
  const select = el("locationResults");
  if (!select || select.value === "") return;

  const place = searchResults[Number(select.value)];
  if (!place) return;

  selectedLocation = {
    name: place.name,
    admin1: place.admin1 || place.admin2 || "",
    country: "India",
    lat: Number(place.latitude),
    lon: Number(place.longitude)
  };

  setText("selectedLocation", locationLabel(selectedLocation));
  setText("locationMessage", "Location selected.");
  loadAirQuality();
}

function useMyLocation() {
  if (!navigator.geolocation) {
    setText(
      "locationMessage",
      "Device location is not supported by this browser."
    );
    return;
  }

  setText("locationMessage", "Requesting your location permission…");

  navigator.geolocation.getCurrentPosition(
    position => {
      selectedLocation = {
        name: "Your selected coordinates",
        admin1: "",
        country: "India",
        lat: position.coords.latitude,
        lon: position.coords.longitude
      };

      setText(
        "selectedLocation",
        `${selectedLocation.lat.toFixed(4)}, ${selectedLocation.lon.toFixed(4)}`
      );
      setText(
        "locationMessage",
        "Coordinates selected. Results are estimates for this location."
      );
      loadAirQuality();
    },
    error => {
      console.warn("Device location unavailable:", error.message);
      setText(
        "locationMessage",
        "Location permission denied or unavailable. Search for a place instead."
      );
    },
    {
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 300000
    }
  );
}

// ============================================
// LIVE AIR-QUALITY API
// ============================================

async function loadAirQuality() {
  const thisRequest = ++requestVersion;
  const refreshButton = el("refreshAir");

  if (refreshButton) refreshButton.disabled = true;
  setText("aqiStatus", "Loading…");
  setText("aqiDescription", "Requesting air-quality data…");
  setText("refreshMessage", "Fetching data from the air-quality API…");

  const params = new URLSearchParams({
    lat: String(selectedLocation.lat),
    lon: String(selectedLocation.lon),
    profile: el("profile")?.value || "adult",
    activity: el("activity")?.value || "outdoor",
    duration: el("duration")?.value || "60"
  });

  try {
    const response = await fetch(
      `${API_URL}?${params.toString()}`
    );

    if (!response.ok) {
      throw new Error(`Air-quality API returned HTTP ${response.status}`);
    }

    const result = await response.json();

    if (!result.success || !result.air) {
      throw new Error(result.error || "Air-quality data unavailable.");
    }

    // Ignore an older response if the user changed location meanwhile.
    if (thisRequest !== requestVersion) return;

    const air = result.air;

    currentAir = {
      pm25: numericValue(air.pm25),
      pm10: numericValue(air.pm10),
      no2: numericValue(air.no2),
      o3: numericValue(air.o3),
      aqi: numericValue(air.aqi_indicator)
    };

    latestApiResult = result;

    updateAirDashboard(result);
    updateExposure();
    updateSchoolSafety();
    updatePlaceChecker();

    setText(
      "refreshMessage",
      "API request completed. Underlying data may update less frequently."
    );

    console.log("SAANS API response:", result);

  } catch (error) {
    console.error("SAANS air-quality error:", error);

    // Clear previous values so stale readings aren't presented as current.
    currentAir = {
      pm25: null,
      pm10: null,
      no2: null,
      o3: null,
      aqi: null
    };

    latestApiResult = null;

    ["aqi", "pm25", "pm10", "no2", "o3", "riskScore"].forEach(id =>
      setText(id, "--")
    );

    setText("aqiStatus", "Data unavailable");
    setText(
      "aqiDescription",
      "SAANS could not retrieve air-quality data. Please retry."
    );
    setText("dataTimestamp", "Unavailable");
    setText("schoolStatus", "Data unavailable");
    setText("schoolAdvice", "Safety guidance cannot be updated without air-quality data.");
    setText("refreshMessage", "Request failed. Check your API and internet connection.");
    setText("dataSource", "Source: Open-Meteo via SAANS API");

    showResult(
      "placeResult",
      "Air-quality data is unavailable. Place conditions cannot currently be assessed."
    );

  } finally {
    if (thisRequest === requestVersion && refreshButton) {
      refreshButton.disabled = false;
    }
  }
}

// ============================================
// DASHBOARD
// ============================================

function getAirCategory(value) {
  if (value === null) {
    return {
      label: "UNAVAILABLE",
      advice: "No usable air-quality indicator is available."
    };
  }

  if (value <= 50) {
    return {
      label: "LOW",
      advice: "Continue monitoring local conditions."
    };
  }

  if (value <= 100) {
    return {
      label: "MODERATE",
      advice: "Sensitive people should consider reducing prolonged outdoor exertion."
    };
  }

  if (value <= 150) {
    return {
      label: "HIGH",
      advice: "Reduce prolonged or strenuous outdoor activity, especially if sensitive to pollution."
    };
  }

  return {
    label: "VERY HIGH",
    advice: "Reduce outdoor exposure and follow local health advisories."
  };
}

function updateAirDashboard(result) {
  const air = result.air;

  setText("aqi", displayNumber(air.aqi_indicator));
  setText("pm25", displayNumber(air.pm25));
  setText("pm10", displayNumber(air.pm10));
  setText("no2", displayNumber(air.no2));
  setText("o3", displayNumber(air.o3));

  const category = getAirCategory(currentAir.aqi);

  setText("aqiStatus", category.label);
  setText(
    "aqiDescription",
    category.advice
  );

  setStatus(el("aqiStatus"), category.label);

  const school = result.school || {};
  setText(
    "schoolStatus",
    school.status || "Not available"
  );
  setText(
    "schoolAdvice",
    school.advice || category.advice
  );
  setStatus(el("schoolStatus"), school.status || category.label);

  setText(
    "dataSource",
    "Source: Open-Meteo Air Quality API via SAANS. Values are provider estimates, not necessarily station measurements."
  );

  // Prefer the source timestamp if the backend returns one.
  const sourceTimestamp =
    air.time ||
    air.timestamp ||
    result.time ||
    result.timestamp ||
    result.observation_time ||
    result.data_time;

  if (sourceTimestamp) {
    const parsed = new Date(sourceTimestamp);
    setText(
      "dataTimestamp",
      Number.isNaN(parsed.getTime())
        ? sourceTimestamp
        : `${parsed.toLocaleString()} (source timestamp)`
    );
  } else {
    setText(
      "dataTimestamp",
      `${new Date().toLocaleString()} (retrieved by SAANS; source timestamp unavailable)`
    );
  }

  setText(
    "aqiDescription",
    `${category.advice} ${result.note || "The indicator is approximate and is not an official AQI."}`
  );
}

// ============================================
// PERSONAL EXPOSURE
// ============================================

function calculateExposure(aqi, profile, activity, duration) {
  const multipliers = {
    child: 1.25,
    adult: 1,
    elderly: 1.2,
    worker: 1.1,
    sensitive: 1.25
  };

  let score = aqi * (multipliers[profile] || 1);

  score *= activity === "outdoor" ? 1.25 : 0.75;

  if (duration >= 120) {
    score *= 1.2;
  } else if (duration >= 60) {
    score *= 1.1;
  }

  score = Math.min(100, Math.round(score));

  let level = "LOW";
  if (score > 75) level = "VERY HIGH";
  else if (score > 50) level = "HIGH";
  else if (score > 25) level = "MODERATE";

  return { score, level };
}

function updateExposure() {
  if (currentAir.aqi === null) {
    setText("riskScore", "--");
    return;
  }

  const result = calculateExposure(
    currentAir.aqi,
    el("profile")?.value || "child",
    el("activity")?.value || "outdoor",
    Number(el("duration")?.value || 60)
  );

  setText("riskScore", result.score);
  setText("exposureResult", `${result.level}: ${getExposureAdvice(result.level)}`);
}

function getExposureAdvice(level) {
  if (level === "VERY HIGH") {
    return "Minimize exposure and follow local health guidance.";
  }
  if (level === "HIGH") {
    return "Reduce prolonged outdoor activity.";
  }
  if (level === "MODERATE") {
    return "Sensitive people should consider limiting prolonged exertion.";
  }
  return "Continue monitoring local conditions.";
}

// ============================================
// SCHOOL SAFETY
// ============================================

function updateSchoolSafety() {
  if (currentAir.aqi === null) return;

  let status;
  let advice;

  if (currentAir.aqi <= 50) {
    status = "GREEN";
    advice = "Monitor conditions and follow school health guidance.";
  } else if (currentAir.aqi <= 100) {
    status = "YELLOW";
    advice = "Sensitive students should consider limiting strenuous outdoor activity.";
  } else if (currentAir.aqi <= 150) {
    status = "ORANGE";
    advice = "Consider reducing prolonged outdoor activities.";
  } else {
    status = "RED";
    advice = "Consider moving strenuous activities indoors and follow local advisories.";
  }

  setText("schoolStatus", status);
  setText("schoolAdvice", advice);
  setStatus(el("schoolStatus"), status);
}

// ============================================
// PLACE QUALITY CHECKER
// Checks outdoor conditions at the selected coordinates.
// Does not certify indoor air or the whole building.
// ============================================

function updatePlaceChecker() {
  if (currentAir.pm25 === null) {
    showResult(
      "placeResult",
      "No PM2.5 data is available for this location."
    );
    return;
  }

  const type = el("placeType")?.value || "public";
  const placeName = el("placeName")?.value.trim();
  const location = locationLabel(selectedLocation);
  const pm25 = currentAir.pm25;
  const category = getAirCategory(currentAir.aqi);

  const placeLabels = {
    hospital: "Hospital",
    office: "Office",
    school: "School / College",
    home: "Home",
    public: "Public place"
  };

  const recommendations = {
    hospital:
      "This is outdoor air guidance only. Patients and visitors who are sensitive to pollution should follow facility and medical guidance.",
    office:
      "Consider reducing strenuous outdoor activity during commutes or breaks. Indoor conditions require separate measurements.",
    school:
      "Consider limiting prolonged outdoor exercise when pollution is elevated. Follow school policies and local advisories.",
    home:
      "Outdoor conditions do not indicate indoor air quality. Consider indoor sources and ventilate when outdoor air is cleaner.",
    public:
      "Check conditions before prolonged outdoor activity and follow local health advisories."
  };

  const heading = placeName
    ? `${placeLabels[type]} "${placeName}"`
    : placeLabels[type];

  const message =
    `${heading} — ${location}. ` +
    `Outdoor PM2.5: ${pm25.toFixed(1)} µg/m³. ` +
    `SAANS indicator category: ${category.label}. ` +
    `${recommendations[type]} ` +
    `This is an outdoor air assessment, not a building safety certification.`;

  showResult("placeResult", message);
}

function checkIndoorAir() {
  const pm25 = numericValue(el("indoorPM25")?.value);
  const co2 = numericValue(el("co2")?.value);
  const humidity = numericValue(el("humidity")?.value);

  if (pm25 === null && co2 === null && humidity === null) {
    showResult(
      "indoorResult",
      "Enter readings from an indoor monitor first. SAANS does not measure indoor air automatically."
    );
    return;
  }

  const notes = [];

  if (pm25 !== null) {
    notes.push(
      `Indoor PM2.5: ${pm25} µg/m³. Compare with relevant health guidance.`
    );
  }
  if (co2 !== null) {
    notes.push(
      `CO₂: ${co2} ppm. Interpret alongside ventilation, occupancy and applicable guidance.`
    );
  }
  if (humidity !== null) {
    notes.push(
      `Relative humidity: ${humidity}%.`
    );
  }

  showResult(
    "indoorResult",
    notes.join(" ") +
    " These are user-entered readings, not measurements collected by SAANS."
  );
}

// ============================================
// ASK SAANS — rule-based guidance, not an AI model
// ============================================

function askSAANS() {
  const question = el("question")?.value.trim();
  if (!question) {
    setText("aiAnswer", "Please enter a question first.");
    return;
  }

  const q = question.toLowerCase();

  if (currentAir.aqi === null) {
    setText("aiAnswer", "Air-quality data is not available. Please try refreshing.");
    return;
  }

  let answer;

  if (
    q.includes("school") ||
    q.includes("child") ||
    q.includes("student")
  ) {
    answer = `School guidance for ${selectedLocation.name}: ${el("schoolAdvice")?.textContent || "Follow local health advisories."}`;
  } else if (
    q.includes("hospital") ||
    q.includes("office") ||
    q.includes("home") ||
    q.includes("building")
  ) {
    answer = "Use the Place Quality Checker to assess estimated outdoor air conditions. SAANS cannot certify indoor air without indoor monitoring data.";
  } else if (
    q.includes("fire") ||
    q.includes("stubble") ||
    q.includes("burning")
  ) {
    answer = "SAANS has not connected a satellite fire-hotspot data source yet, so it cannot confirm nearby fires.";
  } else if (
    q.includes("indoor") ||
    q.includes("room")
  ) {
    answer = "Indoor air has not been measured unless you enter readings from an indoor monitor. Outdoor readings cannot establish indoor PM2.5 or CO₂.";
  } else if (
    q.includes("pm2.5") ||
    q.includes("pm25") ||
    q.includes("particle")
  ) {
    answer = currentAir.pm25 === null
      ? "PM2.5 data is unavailable."
      : `The API reports outdoor PM2.5 of ${currentAir.pm25.toFixed(1)} µg/m³ for ${selectedLocation.name}. This is a provider estimate, not necessarily a station measurement.`;
  } else if (
    q.includes("exercise") ||
    q.includes("running") ||
    q.includes("outdoor") ||
    q.includes("play")
  ) {
    answer = getAirCategory(currentAir.aqi).advice +
      " Follow local health guidance, especially for children and sensitive people.";
  } else {
    answer = `For ${locationLabel(selectedLocation)}, PM2.5 is ${displayNumber(currentAir.pm25)} µg/m³. The SAANS PM2.5-based indicator is ${displayNumber(currentAir.aqi)}, not an official AQI. ${getAirCategory(currentAir.aqi).advice}`;
  }

  setText("aiAnswer", answer);
}

// ============================================
// EVENTS + INITIALIZATION
// ============================================

function initializeSaans() {
  el("searchLocationBtn")?.addEventListener("click", searchLocations);

  el("locationSearch")?.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchLocations();
    }
  });

  el("locationResults")?.addEventListener("change", selectSearchResult);
  el("useMyLocation")?.addEventListener("click", useMyLocation);
  el("refreshAir")?.addEventListener("click", loadAirQuality);
  el("checkPlace")?.addEventListener("click", updatePlaceChecker);
  el("placeType")?.addEventListener("change", updatePlaceChecker);
  el("placeName")?.addEventListener("input", updatePlaceChecker);
  el("calculateExposureBtn")?.addEventListener("click", updateExposure);
  el("checkIndoorBtn")?.addEventListener("click", checkIndoorAir);
  el("askButton")?.addEventListener("click", askSAANS);

  el("question")?.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      askSAANS();
    }
  });

  ["profile", "activity", "duration"].forEach(id => {
    el(id)?.addEventListener("change", updateExposure);
  });

  setText("selectedLocation", locationLabel(selectedLocation));
  loadAirQuality();

  // Refresh the request periodically. The source itself may update less often.
  window.setInterval(loadAirQuality, 15 * 60 * 1000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeSaans);
} else {
  initializeSaans();
}
