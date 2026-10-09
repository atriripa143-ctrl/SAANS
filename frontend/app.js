
"use strict";

// ============================================================
// SAANS — India-wide air-quality and exposure dashboard
// Frontend: JavaScript
// Backend: AWS Lambda + API Gateway
// Air-quality provider: Open-Meteo
// ============================================================

const API_URL =
  "https://q87la9nm10.execute-api.ap-south-1.amazonaws.com/air";

const GEOCODING_URL =
  "https://geocoding-api.open-meteo.com/v1/search";

const REFRESH_INTERVAL = 15 * 60 * 1000;

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
let refreshTimer = null;

// ============================================================
// GENERAL HELPERS
// ============================================================

function el(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const node = el(id);
  if (!node) return;

  node.textContent =
    value === null || value === undefined || value === ""
      ? "--"
      : String(value);
}

function showResult(id, message) {
  const node = el(id);
  if (!node) return;

  node.textContent = message;
  node.classList.remove("hidden");
  node.setAttribute("aria-live", "polite");
}

function hideResult(id) {
  const node = el(id);
  if (node) node.classList.add("hidden");
}

function setStatus(node, status) {
  if (!node) return;

  node.classList.remove(
    "green",
    "yellow",
    "orange",
    "red",
    "low",
    "moderate",
    "high",
    "very-high"
  );

  const normalized = String(status || "")
    .toLowerCase()
    .replace(/\s+/g, "-");

  if (
    ["green", "yellow", "orange", "red", "low", "moderate", "high", "very-high"]
      .includes(normalized)
  ) {
    node.classList.add(normalized);
  }
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

function setButtonLoading(id, loading, loadingText) {
  const button = el(id);
  if (!button) return;

  if (loading) {
    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent;
    }

    button.disabled = true;
    if (loadingText) button.textContent = loadingText;
  } else {
    button.disabled = false;

    if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }
}

function animateUpdate(node) {
  if (!node) return;

  // Re-trigger a brief CSS animation when a value changes.
  node.classList.remove("saans-updated");
  void node.offsetWidth;
  node.classList.add("saans-updated");
}

function setAnimatedText(id, value) {
  const node = el(id);
  if (!node) return;

  const next = value === null || value === undefined || value === ""
    ? "--"
    : String(value);

  if (node.textContent !== next) {
    node.textContent = next;
    animateUpdate(node);
  }
}

// ============================================================
// LOCATION SEARCH
// ============================================================

async function searchLocations() {
  const query = el("locationSearch")?.value.trim();
  const select = el("locationResults");

  if (!query || query.length < 2) {
    setText("locationMessage", "Enter at least two characters.");
    return;
  }

  setButtonLoading("searchLocationBtn", true, "Searching...");

  setText("locationMessage", "Searching Indian locations...");

  if (select) {
    select.hidden = true;
    select.innerHTML = '<option value="">Select a location</option>';
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
      "Location search failed. Check your connection and try again."
    );
  } finally {
    setButtonLoading("searchLocationBtn", false);
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

  setText("locationMessage", "Requesting location permission...");

  navigator.geolocation.getCurrentPosition(
    position => {
      selectedLocation = {
        name: "Selected coordinates",
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
        "Coordinates selected. Air-quality values are provider estimates."
      );

      loadAirQuality();
    },
    error => {
      console.warn("SAANS location error:", error.message);

      setText(
        "locationMessage",
        "Location permission was denied or unavailable. Search for a place instead."
      );
    },
    {
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 300000
    }
  );
}

// ============================================================
// LOAD AIR QUALITY
// ============================================================

async function loadAirQuality() {
  const thisRequest = ++requestVersion;

  setButtonLoading("refreshAir", true, "Refreshing...");

  setText("aqiStatus", "Loading");
  setText("aqiDescription", "Requesting air-quality data...");
  setText("refreshMessage", "Fetching the latest available provider data...");

  const params = new URLSearchParams({
    lat: String(selectedLocation.lat),
    lon: String(selectedLocation.lon),
    profile: el("profile")?.value || "adult",
    activity: el("activity")?.value || "outdoor",
    duration: el("duration")?.value || "60"
  });

  try {
    const response = await fetch(`${API_URL}?${params.toString()}`);

    if (!response.ok) {
      throw new Error(`Air-quality API returned HTTP ${response.status}`);
    }

    const result = await response.json();

    if (!result.success || !result.air) {
      throw new Error(result.error || "Air-quality data is unavailable.");
    }

    // Ignore outdated responses if another location was selected.
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
      "Request completed. The underlying provider data may update less frequently."
    );

    console.log("SAANS API response:", result);
  } catch (error) {
    console.error("SAANS air-quality error:", error);

    if (thisRequest !== requestVersion) return;

    currentAir = {
      pm25: null,
      pm10: null,
      no2: null,
      o3: null,
      aqi: null
    };

    latestApiResult = null;

    ["aqi", "pm25", "pm10", "no2", "o3", "riskScore"].forEach(id => {
      setText(id, "--");
    });

    setText("aqiStatus", "Data unavailable");
    setText(
      "aqiDescription",
      "SAANS could not retrieve air-quality data. Check your connection and retry."
    );

    setText("dataTimestamp", "Unavailable");
    setText("schoolStatus", "Data unavailable");

    setText(
      "schoolAdvice",
      "School safety guidance cannot be updated without air-quality data."
    );

    setText(
      "dataSource",
      "Source: Open-Meteo via SAANS API. Latest retrieval failed."
    );

    setText(
      "refreshMessage",
      "Request failed. Check the API endpoint, backend logs, and internet connection."
    );

    showResult(
      "exposureResult",
      "Exposure cannot be estimated because air-quality data is unavailable."
    );

    showResult(
      "placeResult",
      "Air-quality data is unavailable. Place conditions cannot currently be assessed."
    );

    showResult(
      "aiAnswer",
      "Air-quality data is temporarily unavailable. You can still ask general questions about pollutants, exposure, indoor air, and fire-hotspot limitations."
    );
  } finally {
    if (thisRequest === requestVersion) {
      setButtonLoading("refreshAir", false);
    }
  }
}

// ============================================================
// AIR-QUALITY CATEGORY
// This is a SAANS PM2.5-based indicator, not official AQI.
// ============================================================

function getAirCategory(value) {
  if (value === null || value === undefined) {
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

// ============================================================
// DASHBOARD DISPLAY
// ============================================================

function updateAirDashboard(result) {
  const air = result.air;

  setAnimatedText("aqi", displayNumber(air.aqi_indicator));
  setAnimatedText("pm25", displayNumber(air.pm25));
  setAnimatedText("pm10", displayNumber(air.pm10));
  setAnimatedText("no2", displayNumber(air.no2));
  setAnimatedText("o3", displayNumber(air.o3));

  const category = getAirCategory(currentAir.aqi);

  setText("aqiStatus", category.label);
  setStatus(el("aqiStatus"), category.label);

  setText(
    "aqiDescription",
    `${category.advice} ${result.note || "The SAANS indicator is approximate and is not an official AQI."}`
  );

  setText(
    "dataSource",
    "Source: Open-Meteo Air Quality API via SAANS. Values are provider estimates and may not represent nearby station measurements."
  );

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
        ? String(sourceTimestamp)
        : `${parsed.toLocaleString()} (source timestamp)`
    );
  } else {
    setText(
      "dataTimestamp",
      `${new Date().toLocaleString()} (retrieved by SAANS; source timestamp unavailable)`
    );
  }
}

// ============================================================
// PERSONAL EXPOSURE CALCULATOR
// Score is a screening heuristic, not a measured dose.
// ============================================================

function calculateExposure(aqi, profile, activity, duration) {
  if (!Number.isFinite(Number(aqi))) {
    return {
      score: null,
      level: "UNAVAILABLE"
    };
  }

  const multipliers = {
    child: 1.25,
    adult: 1,
    elderly: 1.2,
    worker: 1.1,
    sensitive: 1.25
  };

  const profileMultiplier = multipliers[profile] || 1;
  const activityMultiplier = activity === "outdoor" ? 1.25 : 0.75;

  const minutes = Math.max(0, Number(duration) || 0);
  const durationMultiplier =
    minutes >= 120 ? 1.2 :
    minutes >= 60 ? 1.1 :
    1;

  const score = Math.min(
    100,
    Math.round(
      Number(aqi) *
      profileMultiplier *
      activityMultiplier *
      durationMultiplier
    )
  );

  let level = "LOW";

  if (score > 75) {
    level = "VERY HIGH";
  } else if (score > 50) {
    level = "HIGH";
  } else if (score > 25) {
    level = "MODERATE";
  }

  return { score, level };
}

function getExposureAdvice(level) {
  if (level === "VERY HIGH") {
    return "Minimize outdoor exposure where possible and follow local health guidance.";
  }

  if (level === "HIGH") {
    return "Reduce prolonged or strenuous outdoor activity.";
  }

  if (level === "MODERATE") {
    return "Sensitive people should consider limiting prolonged exertion.";
  }

  if (level === "LOW") {
    return "Continue monitoring local conditions.";
  }

  return "Exposure guidance is unavailable.";
}

function updateExposure() {
  if (currentAir.aqi === null) {
    setText("riskScore", "--");

    showResult(
      "exposureResult",
      "Exposure cannot be estimated yet because air-quality data is unavailable. Refresh the dashboard and try again."
    );

    return;
  }

  const profile = el("profile")?.value || "adult";
  const activity = el("activity")?.value || "outdoor";
  const duration = Number(el("duration")?.value || 60);

  const result = calculateExposure(
    currentAir.aqi,
    profile,
    activity,
    duration
  );

  if (result.score === null) {
    setText("riskScore", "--");

    showResult(
      "exposureResult",
      "A valid air-quality indicator is required to calculate exposure."
    );

    return;
  }

  setAnimatedText("riskScore", result.score);

  showResult(
    "exposureResult",
    `Estimated exposure-risk score: ${result.score}/100 — ${result.level}. ` +
    `Profile: ${profile}. Activity: ${activity}. Duration: ${duration} minutes. ` +
    `${getExposureAdvice(result.level)} ` +
    "This is a screening estimate, not a measurement of the dose absorbed by your body."
  );
}

// ============================================================
// SCHOOL SAFETY
// Uses one consistent threshold rule based on the SAANS indicator.
// It does not make official school closure decisions.
// ============================================================

function updateSchoolSafety() {
  const value = currentAir.aqi;

  if (value === null) {
    setText("schoolStatus", "Data unavailable");

    setText(
      "schoolAdvice",
      "School safety guidance cannot be estimated until air-quality data is available."
    );

    setStatus(el("schoolStatus"), "");
    return;
  }

  let status;
  let advice;

  if (value <= 50) {
    status = "GREEN";
    advice =
      "The SAANS indicator is low. Continue routine monitoring and follow school health guidance.";
  } else if (value <= 100) {
    status = "YELLOW";
    advice =
      "The SAANS indicator is moderate. Consider additional precautions for students sensitive to air pollution.";
  } else if (value <= 150) {
    status = "ORANGE";
    advice =
      "The SAANS indicator is elevated. Consider reducing prolonged or strenuous outdoor activities.";
  } else {
    status = "RED";
    advice =
      "The SAANS indicator is very high. Consider moving strenuous activities indoors and follow local health advisories.";
  }

  setText("schoolStatus", status);
  setText("schoolAdvice", advice);
  setStatus(el("schoolStatus"), status);
}

// ============================================================
// PLACE QUALITY CHECKER
// Assesses estimated outdoor conditions at selected coordinates.
// It does not certify indoor air or the whole building.
// ============================================================

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
    school: "School or college",
    home: "Home",
    public: "Public place"
  };

  const recommendations = {
    hospital:
      "This is outdoor air guidance only. Sensitive patients and visitors should follow facility and medical guidance.",
    office:
      "Consider reducing strenuous outdoor activity during commutes or breaks. Indoor conditions require separate measurements.",
    school:
      "Consider limiting prolonged outdoor exercise when pollution is elevated. Follow school policies and local advisories.",
    home:
      "Outdoor readings do not indicate indoor air quality. Consider indoor sources and ventilate when outdoor air is cleaner.",
    public:
      "Check conditions before prolonged outdoor activity and follow local health advisories."
  };

  const heading = placeName
    ? `${placeLabels[type] || "Public place"} "${placeName}"`
    : placeLabels[type] || "Public place";

  showResult(
    "placeResult",
    `${heading} — ${location}. ` +
    `Estimated outdoor PM2.5: ${pm25.toFixed(1)} µg/m³. ` +
    `SAANS indicator category: ${category.label}. ` +
    `${recommendations[type] || recommendations.public} ` +
    "This is an outdoor air assessment, not a building safety certification."
  );
}

// ============================================================
// INDOOR AIR CHECKER
// Readings must be entered by the user.
// No indoor sensor is assumed to be connected.
// ============================================================

function checkIndoorAir() {
  const pm25 = numericValue(el("indoorPM25")?.value);
  const co2 = numericValue(el("co2")?.value);
  const humidity = numericValue(el("humidity")?.value);

  if (pm25 === null && co2 === null && humidity === null) {
    showResult(
      "indoorResult",
      "Enter readings from an indoor monitor first. SAANS does not automatically measure indoor air."
    );
    return;
  }

  const notes = [];

  if (pm25 !== null) {
    if (pm25 < 0) {
      showResult("indoorResult", "PM2.5 cannot be negative.");
      return;
    }

    notes.push(
      `Indoor PM2.5: ${pm25} µg/m³. Compare with relevant health guidance.`
    );
  }

  if (co2 !== null) {
    if (co2 < 0) {
      showResult("indoorResult", "CO₂ cannot be negative.");
      return;
    }

    notes.push(
      `CO₂: ${co2} ppm. Interpret alongside ventilation, occupancy, and applicable guidance.`
    );
  }

  if (humidity !== null) {
    if (humidity < 0 || humidity > 100) {
      showResult(
        "indoorResult",
        "Relative humidity must be between 0 and 100 percent."
      );
      return;
    }

    notes.push(`Relative humidity: ${humidity}%.`);
  }

  showResult(
    "indoorResult",
    notes.join(" ") +
    " These are user-entered readings, not measurements collected automatically by SAANS."
  );
}

// ============================================================
// ASK SAANS
// Rule-based responses. This is not an AI model.
// ============================================================

function askSAANS() {
  const question = el("question")?.value.trim();

  if (!question) {
    showResult(
      "aiAnswer",
      "Enter a question about air quality, pollutants, exposure, school safety, indoor air, or fire hotspots."
    );
    return;
  }

  const q = question.toLowerCase();
  const place = locationLabel(selectedLocation);
  const category = getAirCategory(currentAir.aqi);
  const hasAirData = currentAir.aqi !== null;

  let answer;

  // Specific topics first to avoid overly broad matches.
  if (/stubble|crop burning|farm fire|fire hotspot|wildfire|burning field/.test(q)) {
    answer =
      "Stubble burning and fire hotspots: SAANS does not currently have a connected satellite hotspot feed. " +
      "It cannot confirm whether a fire is nearby. Check official satellite fire products and local government alerts. " +
      "High PM2.5 alone does not prove that stubble burning is the cause.";
  } else if (/what is saans|about saans|what can you do|what can you answer/.test(q)) {
    answer =
      "SAANS helps you explore estimated outdoor air quality, pollutant readings, personal exposure risk, school precautions, and outdoor conditions around places. " +
      "Indoor air requires entered monitor readings, and fire-hotspot confirmation requires a connected hotspot source.";
  } else if (/^hello[!. ]*$|^hi[!. ]*$|^hey[!. ]*$|^good morning|^good evening/.test(q)) {
    answer =
      "Hello. I can help you understand air-quality estimates, PM2.5 and PM10, outdoor activity precautions, school safety, and indoor air readings. What would you like to know?";
  } else if (/school|student|child|children|playground|college/.test(q)) {
    answer = hasAirData
      ? `School guidance for ${place}: ${el("schoolStatus")?.textContent || category.label}. ` +
        `${el("schoolAdvice")?.textContent || category.advice} ` +
        "This is guidance based on an approximate indicator, not an official school closure notice."
      : "Current air-quality data is unavailable, so I cannot assess school conditions. Refresh the dashboard and follow local school and public-health advisories.";
  } else if (/exposure|my risk|risk score|breathe|breathing|lung|health|symptom/.test(q)) {
    answer = hasAirData
      ? `For ${place}, the current SAANS indicator is ${displayNumber(currentAir.aqi)} (${category.label}). ` +
        `${category.advice} Personal exposure estimates also depend on your selected profile, activity, and duration. ` +
        "This tool cannot diagnose symptoms. Seek urgent medical help for severe breathing difficulty or chest pain."
      : "Current air-quality data is unavailable, so I cannot estimate exposure risk. Refresh the dashboard. Seek urgent medical help for severe breathing difficulty or chest pain.";
  } else if (/pm\s*2\.?5|pm25|fine particle|fine particulate/.test(q)) {
    answer = currentAir.pm25 !== null
      ? `The estimated outdoor PM2.5 level for ${place} is ${displayNumber(currentAir.pm25)} µg/m³. ` +
        "PM2.5 consists of fine particles that can penetrate deep into the lungs. This is a provider estimate, not necessarily a nearby station reading."
      : "PM2.5 data is unavailable for the selected location. Try refreshing the dashboard.";
  } else if (/pm\s*10|pm10|coarse particle/.test(q)) {
    answer = currentAir.pm10 !== null
      ? `The estimated outdoor PM10 level for ${place} is ${displayNumber(currentAir.pm10)} µg/m³. ` +
        "PM10 includes inhalable particles such as dust. This is a provider estimate, not necessarily a station measurement."
      : "PM10 data is unavailable for the selected location. Try refreshing the dashboard.";
  } else if (/\bno2\b|nitrogen dioxide/.test(q)) {
    answer = currentAir.no2 !== null
      ? `The estimated outdoor NO₂ level for ${place} is ${displayNumber(currentAir.no2)} µg/m³. ` +
        "Traffic and fuel combustion are common sources. This is a provider estimate."
      : "NO₂ data is unavailable for the selected location.";
  } else if (/\bo3\b|ozone/.test(q)) {
    answer = currentAir.o3 !== null
      ? `The estimated outdoor ozone (O₃) level for ${place} is ${displayNumber(currentAir.o3)} µg/m³. ` +
        "Ground-level ozone can irritate the airways, particularly during outdoor exertion. This is a provider estimate."
      : "Ozone data is unavailable for the selected location.";
  } else if (/indoor|room|ventilation|co2|carbon dioxide|humidity/.test(q)) {
    answer =
      "SAANS cannot automatically measure indoor air. Enter readings from an indoor monitor in the Indoor Air section. " +
      "Outdoor readings do not tell us the actual indoor PM2.5 or CO₂ level. Ventilate when outdoor air is cleaner and follow applicable guidance.";
  } else if (/hospital|office|home|building|place quality|public place/.test(q)) {
    answer = hasAirData
      ? `For ${place}, the outdoor SAANS indicator is ${displayNumber(currentAir.aqi)} (${category.label}), and estimated outdoor PM2.5 is ${displayNumber(currentAir.pm25)} µg/m³. ` +
        "Use Place Quality Checker for tailored precautions. These readings cannot certify a building or its indoor air."
      : "Use Place Quality Checker after air-quality data loads. It assesses estimated outdoor conditions and cannot certify indoor air or an entire building.";
  } else if (/location|where am i|which city|selected place/.test(q)) {
    answer = `The selected SAANS location is ${place}. Use location search to check another place in India.`;
  } else if (/exercise|running|walk|walking|cycling|outdoor|sports|play outside/.test(q)) {
    answer = hasAirData
      ? `For outdoor activity in ${place}: ${category.advice} Consider the activity's intensity and duration, and follow local health advisories.`
      : "Air-quality data is unavailable, so I cannot tailor outdoor-activity advice to your location. Check local air-quality and health advisories before strenuous activity.";
  } else if (/aqi|air quality|pollution|how bad|current condition|current status/.test(q)) {
    answer = hasAirData
      ? `For ${place}, the SAANS PM2.5-based indicator is ${displayNumber(currentAir.aqi)} (${category.label}). ` +
        `PM2.5: ${displayNumber(currentAir.pm25)} µg/m³; PM10: ${displayNumber(currentAir.pm10)} µg/m³; ` +
        `NO₂: ${displayNumber(currentAir.no2)} µg/m³; O₃: ${displayNumber(currentAir.o3)} µg/m³. ` +
        `${category.advice} This indicator is approximate, not an official AQI.`
      : "Air-quality data is unavailable. Try Refresh Air and check your internet connection.";
  } else {
    answer =
      "I can help with air-quality estimates, PM2.5, PM10, NO₂, ozone, personal exposure, school precautions, indoor air, locations, and stubble-burning data limitations. " +
      "Try asking: “What is PM2.5?”, “Is it safe for children to play outside?”, “What is the current air quality?”, or “Can you confirm a nearby fire?”";
  }

  showResult("aiAnswer", answer);
}

// ============================================================
// EVENT HANDLERS
// ============================================================

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

  // Display an initial message before the first request finishes.
  showResult(
    "exposureResult",
    "Loading air-quality data to estimate your exposure..."
  );

  loadAirQuality();

  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer);
  }

  refreshTimer = window.setInterval(
    loadAirQuality,
    REFRESH_INTERVAL
  );
}

// ============================================================
// START APP
// ============================================================

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeSaans);
} else {
  initializeSaans();
}
