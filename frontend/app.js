
"use strict";

// ============================================
// SAANS - Smart Air Awareness & Neighborhood Safety
// AWS Lambda + API Gateway + Open-Meteo
// ============================================

const API_URL =
  "https://q87la9nm10.execute-api.ap-south-1.amazonaws.com/air";

// City coordinates
const LOCATIONS = {
  Kolkata: { lat: 22.5726, lon: 88.3639 },
  Delhi: { lat: 28.6139, lon: 77.2090 },
  Mumbai: { lat: 19.0760, lon: 72.8777 },
  Bengaluru: { lat: 12.9716, lon: 77.5946 },
  Chennai: { lat: 13.0827, lon: 80.2707 },
  Indore: { lat: 22.7196, lon: 75.8577 }
};

let currentAir = {
  pm25: null,
  pm10: null,
  no2: null,
  o3: null,
  aqi: null
};

let currentCity = "Kolkata";

// ============================================
// DOM HELPERS
// ============================================

function getElement(...ids) {
  for (const id of ids) {
    const element = document.getElementById(id);
    if (element) return element;
  }
  return null;
}

function setText(ids, value) {
  const element = getElement(...ids);
  if (element) {
    element.textContent =
      value === null || value === undefined ? "--" : value;
  }
}

function setStatus(element, status, advice) {
  if (!element) return;

  element.textContent = status;
  element.classList.remove(
    "green", "yellow", "orange", "red",
    "low", "moderate", "high", "very-high"
  );

  element.classList.add(
    String(status).toLowerCase().replace(/\s+/g, "-")
  );

  if (advice) element.title = advice;
}

function showMessage(message) {
  console.log("[SAANS]", message);

  const element = getElement(
    "errorMessage",
    "statusMessage",
    "apiMessage"
  );

  if (element) element.textContent = message;
}

// ============================================
// AIR QUALITY FROM AWS API
// ============================================

async function loadAirQuality() {
  const citySelect = getElement("citySelect", "city", "locationSelect");

  currentCity = citySelect?.value || currentCity;
  const location = LOCATIONS[currentCity] || LOCATIONS.Kolkata;

  setText(["aqiValue", "currentAQI", "aqi"], "Loading...");
  showMessage("Loading air-quality data...");

  const params = new URLSearchParams({
    lat: String(location.lat),
    lon: String(location.lon),
    profile: "adult",
    activity: "outdoor",
    duration: "60"
  });

  try {
    const response = await fetch(`${API_URL}?${params.toString()}`);

    if (!response.ok) {
      throw new Error(`API returned HTTP ${response.status}`);
    }

    const result = await response.json();

    if (!result.success || !result.air) {
      throw new Error(result.error || "Air-quality data unavailable.");
    }

    currentAir = {
      pm25: result.air.pm25,
      pm10: result.air.pm10,
      no2: result.air.no2,
      o3: result.air.o3,
      aqi: result.air.aqi_indicator
    };

    updateAirDashboard(result);
    updateExposure();
    updateIndoorAir();
    updateFireSection();

    showMessage(
      `Air-quality data loaded for ${currentCity}.`
    );

    console.log("SAANS API response:", result);

  } catch (error) {
    console.error("SAANS API error:", error);

    setText(
      ["apiMessage", "statusMessage", "errorMessage"],
      "Unable to load live air-quality data. Check your internet connection, API route and CORS settings."
    );

    showMessage(
      "Could not load air-quality data. Please try again."
    );
  }
}

// ============================================
// UPDATE AIR DASHBOARD
// ============================================

function updateAirDashboard(result) {
  const air = result.air;
  const aqi = Number(air.aqi_indicator);

  setText(["aqiValue", "currentAQI", "aqi"], aqi);
  setText(["pm25Value", "pm25", "pm2_5"], air.pm25);
  setText(["pm10Value", "pm10"], air.pm10);
  setText(["no2Value", "no2", "nitrogenDioxide"], air.no2);
  setText(["o3Value", "o3", "ozone"], air.o3);

  const category = getAirCategory(aqi);

  setText(["aqiStatus", "airStatus", "riskLabel"], category.label);
  setText(["aqiAdvice", "airAdvice"], category.advice);

  const statusElement = getElement(
    "aqiStatus",
    "airStatus",
    "riskLabel"
  );

  setStatus(statusElement, category.label);

  const school = result.school || {};
  setText(["schoolStatus", "schoolSafetyStatus"], school.status);
  setText(["schoolAdvice", "schoolSafetyAdvice"], school.advice);

  setStatus(
    getElement("schoolStatus", "schoolSafetyStatus"),
    school.status,
    school.advice
  );

  // Label the number accurately: this is an estimate, not an
  // official AQI reading.
  setText(
    ["aqiDisclaimer", "aqiNote"],
    result.note ||
      "Approximate PM2.5-based indicator; not an official AQI reading."
  );
}

function getAirCategory(aqi) {
  if (aqi <= 50) {
    return {
      label: "LOW",
      advice: "Lower pollution levels. Continue to monitor local conditions."
    };
  }

  if (aqi <= 100) {
    return {
      label: "MODERATE",
      advice: "Sensitive people should consider reducing prolonged outdoor exertion."
    };
  }

  if (aqi <= 150) {
    return {
      label: "HIGH",
      advice: "Reduce prolonged or strenuous outdoor activity, especially for sensitive people."
    };
  }

  return {
    label: "VERY HIGH",
    advice: "Reduce outdoor exposure and follow local health advisories."
  };
}

// ============================================
// PERSONAL EXPOSURE CALCULATOR
// ============================================

function calculateExposure(aqi, profile, activity, duration) {
  const multipliers = {
    child: 1.25,
    student: 1.25,
    adult: 1.0,
    elderly: 1.20,
    outdoor_worker: 1.10,
    sensitive: 1.25
  };

  let score = aqi * (multipliers[profile] || 1.0);

  if (activity === "outdoor") {
    score *= 1.25;
  } else {
    score *= 0.75;
  }

  if (duration >= 120) {
    score *= 1.20;
  } else if (duration >= 60) {
    score *= 1.10;
  }

  score = Math.min(100, Math.round(score));

  let level;

  if (score <= 25) {
    level = "LOW";
  } else if (score <= 50) {
    level = "MODERATE";
  } else if (score <= 75) {
    level = "HIGH";
  } else {
    level = "VERY HIGH";
  }

  return { score, level };
}

function updateExposure() {
  if (currentAir.aqi === null) return;

  const profileElement = getElement(
    "profileSelect", "profile", "personProfile"
  );

  const activityElement = getElement(
    "activitySelect", "activity"
  );

  const durationElement = getElement(
    "durationSelect", "duration"
  );

  const profile = profileElement?.value || "child";
  const activity = activityElement?.value || "outdoor";
  const duration = Number(durationElement?.value || 60);

  const exposure = calculateExposure(
    currentAir.aqi,
    profile,
    activity,
    duration
  );

  setText(
    ["exposureScore", "riskScore", "personalRiskScore"],
    exposure.score
  );

  setText(
    ["exposureLevel", "riskLevel", "personalRiskLevel"],
    exposure.level
  );

  setStatus(
    getElement("exposureLevel", "riskLevel", "personalRiskLevel"),
    exposure.level
  );

  setText(
    ["exposureAdvice", "riskAdvice"],
    getExposureAdvice(exposure.level, activity)
  );
}

function getExposureAdvice(level, activity) {
  if (level === "VERY HIGH") {
    return "Minimize exposure. Avoid strenuous outdoor activity and follow local health guidance.";
  }

  if (level === "HIGH") {
    return "Reduce time outdoors, particularly during exercise or heavy physical work.";
  }

  if (level === "MODERATE") {
    return "Consider reducing prolonged outdoor exertion if you are sensitive to air pollution.";
  }

  return activity === "outdoor"
    ? "Continue monitoring air quality and take breaks if you experience symptoms."
    : "Keep monitoring air quality and ventilate indoor spaces when outdoor air is cleaner.";
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
    advice = "Normal activities may continue while monitoring local conditions.";
  } else if (currentAir.aqi <= 100) {
    status = "YELLOW";
    advice = "Sensitive students should limit strenuous outdoor activity.";
  } else if (currentAir.aqi <= 150) {
    status = "ORANGE";
    advice = "Reduce prolonged outdoor activities and consider indoor alternatives.";
  } else {
    status = "RED";
    advice = "Move strenuous activities indoors and follow local health guidance.";
  }

  setText(["schoolStatus", "schoolSafetyStatus"], status);
  setText(["schoolAdvice", "schoolSafetyAdvice"], advice);

  setStatus(
    getElement("schoolStatus", "schoolSafetyStatus"),
    status,
    advice
  );
}

// ============================================
// INDOOR AIR SECTION
// No indoor sensor is connected yet.
// ============================================

function updateIndoorAir() {
  setText(["indoorPM25", "indoorPm25Value"], "Not measured");
  setText(["indoorCO2", "indoorCO2Value"], "Not measured");
  setText(["indoorHumidity", "indoorHumidityValue"], "Not measured");

  setText(
    ["indoorStatus", "indoorAirStatus"],
    "Sensor not connected"
  );

  setText(
    ["indoorAdvice", "indoorAirAdvice"],
    "Connect an indoor air-quality sensor to measure indoor PM2.5, CO₂ and humidity. Outdoor readings cannot determine indoor air quality."
  );
}

// ============================================
// FIRE / STUBBLE-BURNING SECTION
// Real hotspot data source is not connected yet.
// ============================================

function updateFireSection() {
  setText(
    ["fireStatus", "stubbleStatus", "hotspotStatus"],
    "Data source not connected"
  );

  setText(
    ["fireCount", "hotspotCount", "nearbyHotspots"],
    "Unavailable"
  );

  setText(
    ["fireAdvice", "stubbleAdvice", "hotspotAdvice"],
    "Satellite fire-hotspot data has not been connected. SAANS is not currently detecting or verifying nearby fires."
  );
}

// ============================================
// ASK SAANS
// Rule-based guidance; not an AI model yet.
// ============================================

function askSaans(question) {
  const q = question.toLowerCase();

  const aqi = currentAir.aqi;
  const pm25 = currentAir.pm25;

  if (aqi === null) {
    return "Air-quality data is not loaded yet. Please try again shortly.";
  }

  if (
    q.includes("school") ||
    q.includes("child") ||
    q.includes("student")
  ) {
    if (aqi > 150) {
      return "School safety: RED. Consider moving strenuous activities indoors, reducing outdoor exposure and following local health advisories.";
    }

    if (aqi > 100) {
      return "School safety: ORANGE. Reduce prolonged outdoor activities, especially for sensitive students.";
    }

    if (aqi > 50) {
      return "School safety: YELLOW. Sensitive students should consider reducing strenuous outdoor activity.";
    }

    return "Current estimated air indicator is in the lower range. Continue monitoring conditions and follow school health guidance.";
  }

  if (
    q.includes("exercise") ||
    q.includes("running") ||
    q.includes("outdoor")
  ) {
    if (aqi > 100) {
      return "Consider postponing strenuous outdoor exercise or moving it indoors. Check local air-quality advisories before going out.";
    }

    return "Check the latest local conditions before exercising. Reduce intensity if you are sensitive to air pollution or develop symptoms.";
  }

  if (
    q.includes("pm2.5") ||
    q.includes("pm25") ||
    q.includes("particle")
  ) {
    return `The reported outdoor PM2.5 concentration is ${pm25} µg/m³. This is an outdoor measurement and does not tell us the indoor concentration.`;
  }

  if (
    q.includes("indoor") ||
    q.includes("room") ||
    q.includes("home")
  ) {
    return "SAANS does not have an indoor sensor connected yet. Keep indoor pollution sources low, and ventilate when outdoor air is cleaner. A sensor is needed to measure indoor PM2.5 and CO₂.";
  }

  if (
    q.includes("fire") ||
    q.includes("stubble") ||
    q.includes("burning")
  ) {
    return "Satellite fire-hotspot data is not connected yet, so SAANS cannot confirm nearby stubble burning. Check official local fire and air-quality advisories.";
  }

  if (
    q.includes("aqi") ||
    q.includes("air quality") ||
    q.includes("pollution")
  ) {
    return `For ${currentCity}, the current PM2.5-based indicator is ${aqi}. This is an approximation, not an official AQI reading. PM2.5 is ${pm25} µg/m³. ${getAirCategory(aqi).advice}`;
  }

  return `For ${currentCity}, the current PM2.5-based indicator is ${aqi}. ${getAirCategory(aqi).advice} You can ask about school safety, outdoor exercise, PM2.5, indoor air or stubble burning.`;
}

function handleAskSaans() {
  const input = getElement(
    "questionInput", "saansQuestion", "userQuestion", "chatInput"
  );

  const answerElement = getElement(
    "saansAnswer", "chatAnswer", "aiResponse", "chatMessages"
  );

  if (!input || !answerElement) {
    console.warn(
      "Ask SAANS: check the question input and answer element IDs in index.html."
    );
    return;
  }

  const question = input.value.trim();

  if (!question) {
    answerElement.textContent = "Please enter a question first.";
    return;
  }

  answerElement.textContent = askSaans(question);
  input.value = "";
}

// ============================================
// EVENT LISTENERS
// ============================================

function initializeSaans() {
  const citySelect = getElement(
    "citySelect", "city", "locationSelect"
  );

  if (citySelect) {
    citySelect.addEventListener("change", loadAirQuality);
  }

  const profileSelect = getElement(
    "profileSelect", "profile", "personProfile"
  );

  const activitySelect = getElement(
    "activitySelect", "activity"
  );

  const durationSelect = getElement(
    "durationSelect", "duration"
  );

  [profileSelect, activitySelect, durationSelect].forEach(element => {
    if (element) {
      element.addEventListener("change", updateExposure);
    }
  });

  const askButton = getElement(
    "askButton", "askSaansButton", "sendQuestion", "chatSend"
  );

  if (askButton) {
    askButton.addEventListener("click", handleAskSaans);
  }

  const questionInput = getElement(
    "questionInput", "saansQuestion", "userQuestion", "chatInput"
  );

  if (questionInput) {
    questionInput.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleAskSaans();
      }
    });
  }

  loadAirQuality();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeSaans);
} else {
  initializeSaans();
}
