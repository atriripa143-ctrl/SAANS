"use strict";
const API = "https://q87la9nm10.execute-api.ap-south-1.amazonaws.com";
const AIR = `${API}/air`,
    CHAT = `${API}/chat`,
    HISTORY = `${API}/history`;
const $ = (id) => document.getElementById(id);
let locationNow = { name: "Kolkata", admin1: "West Bengal", country: "India", lat: 22.5726, lon: 88.3639 };
let searchResults = [],
    airNow = { pm25: null, pm10: null, no2: null, o3: null, aqi: null },
    chart = null,
    chatTurns = [],
    requestNo = 0,
    timer = null;
const txt = (id, v) => {
    if ($(id)) $(id).textContent = v == null || v === "" ? "--" : String(v);
};
const n = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
};
const fmt = (v) => (n(v) === null ? "--" : n(v).toFixed(1));
const locLabel = (l) => [l.name, l.admin1, l.country || "India"].filter(Boolean).join(", ");
function busy(id, on, label) {
    const b = $(id);
    if (!b) return;
    if (on) {
        if (!b.dataset.old) b.dataset.old = b.textContent;
        b.disabled = true;
        b.textContent = label || b.textContent;
    } else {
        b.disabled = false;
        if (b.dataset.old) {
            b.textContent = b.dataset.old;
            delete b.dataset.old;
        }
    }
}
function statusClass(s) {
    const x = $("aqiStatus");
    x.className = "status";
    const k = String(s).toLowerCase().replace(/\s+/g, "-");
    if (["green", "yellow", "orange", "red", "low", "moderate", "high", "very-high"].includes(k)) x.classList.add(k);
}
function cat(v) {
    if (v === null) return { label: "UNAVAILABLE", advice: "No usable air-quality indicator is available." };
    if (v <= 50) return { label: "LOW", advice: "Continue monitoring local conditions." };
    if (v <= 100)
        return { label: "MODERATE", advice: "Sensitive people should consider reducing prolonged outdoor exertion." };
    if (v <= 150)
        return {
            label: "HIGH",
            advice: "Reduce prolonged or strenuous outdoor activity, especially if sensitive to pollution.",
        };
    return { label: "VERY HIGH", advice: "Reduce outdoor exposure and follow local health advisories." };
}
async function searchLocations() {
    const q = $("locationSearch").value.trim();
    if (q.length < 2) {
        txt("locationMessage", "Enter at least two characters.");
        return;
    }
    busy("searchLocationBtn", true, "Searching…");
    txt("locationMessage", "Searching Indian locations…");
    const sel = $("locationResults");
    sel.hidden = true;
    sel.innerHTML = '<option value="">Select a location</option>';
    try {
        const p = new URLSearchParams({ name: q, count: "100", language: "en", format: "json" });
        const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${p}`);
        if (!r.ok) throw Error("Location search failed");
        const d = await r.json();
        searchResults = (d.results || []).filter(
            (x) =>
                String(x.country_code).toUpperCase() === "IN" &&
                Number.isFinite(Number(x.latitude)) &&
                Number.isFinite(Number(x.longitude))
        );
        if (!searchResults.length) {
            txt("locationMessage", "No matching Indian locations found.");
            return;
        }
        searchResults.forEach((x, i) => {
            const o = document.createElement("option");
            o.value = i;
            o.textContent = [x.name, x.admin1, x.admin2, "India"].filter(Boolean).join(", ");
            sel.append(o);
        });
        sel.hidden = false;
        txt("locationMessage", `Found ${searchResults.length} locations. Select one below.`);
    } catch (e) {
        console.error(e);
        txt("locationMessage", "Search failed. Check your connection and try again.");
    } finally {
        busy("searchLocationBtn", false);
    }
}
function chooseLocation() {
    const p = searchResults[Number($("locationResults").value)];
    if (!p) return;
    locationNow = {
        name: p.name,
        admin1: p.admin1 || p.admin2 || "",
        country: "India",
        lat: +p.latitude,
        lon: +p.longitude,
    };
    txt("selectedLocation", locLabel(locationNow));
    txt("locationMessage", "Location selected.");
    loadAir();
}
function myLocation() {
    if (!navigator.geolocation) {
        txt("locationMessage", "Browser location is unsupported.");
        return;
    }
    txt("locationMessage", "Requesting permission…");
    navigator.geolocation.getCurrentPosition(
        (p) => {
            locationNow = {
                name: "Selected coordinates",
                admin1: "",
                country: "India",
                lat: p.coords.latitude,
                lon: p.coords.longitude,
            };
            txt("selectedLocation", `${locationNow.lat.toFixed(4)}, ${locationNow.lon.toFixed(4)}`);
            loadAir();
        },
        () => txt("locationMessage", "Location unavailable. Search for a place instead."),
        { timeout: 10000, maximumAge: 300000 }
    );
}
async function loadAir() {
    const version = ++requestNo;
    busy("refreshAir", true, "Refreshing…");
    txt("aqiStatus", "Loading");
    txt("aqiDescription", "Fetching current provider data…");
    const p = new URLSearchParams({
        lat: locationNow.lat,
        lon: locationNow.lon,
        profile: $("profile").value,
        activity: $("activity").value,
        duration: $("duration").value,
        location_name: locLabel(locationNow),
    });
    try {
        const r = await fetch(`${AIR}?${p}`);
        const d = await r.json();
        if (!r.ok || !d.success || !d.air) throw Error(d.error || "Air API unavailable");
        if (version !== requestNo) return;
        const a = d.air;
        airNow = { pm25: n(a.pm25), pm10: n(a.pm10), no2: n(a.no2), o3: n(a.o3), aqi: n(a.aqi_indicator) };
        renderAir(d);
        updateExposure();
        updatePlace();
        txt(
            "refreshMessage",
            d.history_saved === false
                ? "Air data loaded, but history could not be stored. Check DynamoDB permissions."
                : "Reading retrieved. Provider data may update less frequently."
        );
        await loadHistory();
    } catch (e) {
        console.error(e);
        if (version !== requestNo) return;
        airNow = { pm25: null, pm10: null, no2: null, o3: null, aqi: null };
        ["aqi", "pm25", "pm10", "no2", "o3", "riskScore"].forEach((id) => txt(id, "--"));
        txt("aqiStatus", "Data unavailable");
        txt("aqiDescription", "SAANS could not retrieve readings. Check the API and retry.");
        txt("dataTimestamp", "Unavailable");
        txt("refreshMessage", "Request failed. Check API Gateway and Lambda logs.");
        txt("exposureResult", "Exposure cannot be estimated without readings.");
        txt("placeResult", "Air-quality data unavailable.");
    } finally {
        if (version === requestNo) busy("refreshAir", false);
    }
}
function renderAir(d) {
    const a = d.air;
    ["aqi", "pm25", "pm10", "no2", "o3"].forEach((id) => txt(id, fmt(id === "aqi" ? a.aqi_indicator : a[id])));
    const c = cat(airNow.aqi);
    txt("aqiStatus", c.label);
    statusClass(c.label);
    txt("aqiDescription", `${c.advice} ${d.note || ""}`);
    txt("dataSource", "Source: Open-Meteo Air Quality API via SAANS. Values are provider estimates.");
    const ts = a.time || d.retrieved_at;
    txt("dataTimestamp", ts ? `${new Date(ts).toLocaleString()} (timestamp)` : "Source timestamp unavailable");
}
function updateExposure() {
    if (airNow.aqi === null) {
        txt("riskScore", "--");
        txt("exposureResult", "Exposure cannot be estimated without readings.");
        return;
    }
    const mult = { child: 1.25, adult: 1, elderly: 1.2, worker: 1.1, sensitive: 1.25 };
    const mins = Math.max(1, Math.min(720, +$("duration").value || 60));
    let score = Math.min(
        100,
        Math.round(
            airNow.aqi *
                (mult[$("profile").value] || 1) *
                ($("activity").value === "outdoor" ? 1.25 : 0.75) *
                (mins >= 120 ? 1.2 : mins >= 60 ? 1.1 : 1)
        )
    );
    const level = score > 75 ? "VERY HIGH" : score > 50 ? "HIGH" : score > 25 ? "MODERATE" : "LOW";
    txt("riskScore", score);
    txt(
        "exposureResult",
        `Estimated screening score ${score}/100 — ${level}. ${level === "VERY HIGH" ? "Minimize outdoor exposure where possible and follow local guidance." : level === "HIGH" ? "Reduce prolonged or strenuous outdoor activity." : level === "MODERATE" ? "Sensitive people should consider limiting prolonged exertion." : "Continue monitoring local conditions."} This is not a measured dose or medical assessment.`
    );
}
function updatePlace() {
    if (airNow.pm25 === null) {
        txt("placeResult", "No PM₂.₅ data is available for this location.");
        return;
    }
    const pm = airNow.pm25;
    const rating = pm <= 15 ? "GREEN" : pm <= 35 ? "YELLOW" : "RED";
    const advice =
        rating === "GREEN"
            ? "Lower of the three SAANS screening bands; continue monitoring."
            : rating === "YELLOW"
              ? "Elevated screening band; sensitive people may reduce prolonged outdoor exertion."
              : "Higher screening band; reduce prolonged outdoor exposure where practical and follow local advisories.";
    const types = {
        home: "Home",
        hospital: "Hospital",
        office: "Office",
        school: "School or college",
        public: "Public place",
    };
    const name = $("placeName").value.trim();
    txt(
        "placeResult",
        `${types[$("placeType").value]}${name ? ` “${name}”` : ""} — ${locLabel(locationNow)}. Rating: ${rating}. Estimated outdoor PM₂.₅: ${pm.toFixed(1)} µg/m³. ${advice} Outdoor screening only; it cannot certify indoor air or a building as safe.`
    );
    $("placeResult").style.borderLeft =
        `6px solid ${rating === "GREEN" ? "#22945a" : rating === "YELLOW" ? "#d7ad20" : "#d94a4a"}`;
}
async function loadHistory() {
    txt("historyTitle", locLabel(locationNow));
    txt("historyMessage", "Loading stored readings…");
    try {
        const p = new URLSearchParams({ lat: locationNow.lat, lon: locationNow.lon, limit: 48 });
        const r = await fetch(`${HISTORY}?${p}`);
        const d = await r.json();
        if (!r.ok || !d.success) throw Error(d.error || "History unavailable");
        const a = d.readings || [];
        txt("historyCount", `${a.length} stored readings`);
        if (a.length < 2) {
            if (chart) {
                chart.destroy();
                chart = null;
            }
            txt(
                "historyMessage",
                a.length
                    ? "Only one reading is stored. More readings are needed to show a trend."
                    : "No readings stored yet. The chart populates after SAANS stores real readings over time."
            );
            return;
        }
        if (!window.Chart) {
            txt("historyMessage", "Chart library failed to load. Refresh the page.");
            return;
        }
        if (chart) chart.destroy();
        chart = new Chart($("historyChart"), {
            type: "line",
            data: {
                labels: a.map((x) => new Date(x.timestamp).toLocaleString()),
                datasets: [
                    {
                        label: "PM₂.₅ (µg/m³)",
                        data: a.map((x) => n(x.pm25)),
                        borderColor: "#176b52",
                        tension: 0.25,
                        spanGaps: true,
                    },
                    {
                        label: "PM₁₀ (µg/m³)",
                        data: a.map((x) => n(x.pm10)),
                        borderColor: "#d3a72e",
                        tension: 0.25,
                        spanGaps: true,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: "index", intersect: false },
                plugins: { legend: { position: "bottom" } },
                scales: {
                    x: { ticks: { maxTicksLimit: 6, maxRotation: 0 } },
                    y: { beginAtZero: true, title: { display: true, text: "µg/m³" } },
                },
            },
        });
        txt(
            "historyMessage",
            "These are readings SAANS actually retrieved and stored, not continuous sensor measurements."
        );
    } catch (e) {
        console.error(e);
        txt("historyCount", "Unavailable");
        txt(
            "historyMessage",
            "History could not load. Check the /history route, DynamoDB table and Lambda permissions."
        );
    }
}
async function askSAANS() {
    const question = $("question").value.trim();
    if (!question) {
        txt("aiAnswer", "Enter a question first.");
        return;
    }
    busy("askButton", true, "Thinking…");
    txt("aiAnswer", "SAANS is preparing an answer…");
    try {
        const r = await fetch(CHAT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                question,
                location: { name: locLabel(locationNow), lat: locationNow.lat, lon: locationNow.lon },
                air: airNow,
                history: chatTurns.slice(-6),
            }),
        });
        const d = await r.json();
        if (!r.ok || !d.success) throw Error(d.error || "Chat failed");
        txt("aiAnswer", d.answer || "No answer returned.");
        chatTurns.push({ role: "user", content: question }, { role: "assistant", content: d.answer || "" });
        chatTurns = chatTurns.slice(-8);
    } catch (e) {
        console.error(e);
        txt(
            "aiAnswer",
            "AI service unavailable. Check /chat route, Bedrock model access, Lambda IAM permissions and CloudWatch logs."
        );
    } finally {
        busy("askButton", false);
    }
}
function init() {
    $("searchLocationBtn").addEventListener("click", searchLocations);
    $("locationSearch").addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            searchLocations();
        }
    });
    $("locationResults").addEventListener("change", chooseLocation);
    $("useMyLocation").addEventListener("click", myLocation);
    $("refreshAir").addEventListener("click", loadAir);
    $("calculateExposureBtn").addEventListener("click", updateExposure);
    ["profile", "activity", "duration"].forEach((id) => $(id).addEventListener("change", updateExposure));
    $("checkPlace").addEventListener("click", updatePlace);
    ["placeType", "placeName"].forEach((id) => $(id).addEventListener("change", updatePlace));
    $("placeName").addEventListener("input", updatePlace);
    $("refreshHistory").addEventListener("click", loadHistory);
    $("askButton").addEventListener("click", askSAANS);
    $("question").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            askSAANS();
        }
    });
    txt("selectedLocation", locLabel(locationNow));
    loadAir();
    if (timer) clearInterval(timer);
    timer = setInterval(loadAir, 15 * 60 * 1000);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
