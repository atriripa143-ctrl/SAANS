
import json
import urllib.request
import urllib.parse

def get_air_quality(lat, lon):
    params = urllib.parse.urlencode({
        "latitude": lat,
        "longitude": lon,
        "current": "pm2_5,pm10,nitrogen_dioxide,ozone"
    })

    url = f"https://air-quality-api.open-meteo.com/v1/air-quality?{params}"

    with urllib.request.urlopen(url, timeout=15) as response:
        data = json.loads(response.read().decode("utf-8"))

    current = data.get("current", {})

    pm25 = current.get("pm2_5", 0)
    pm10 = current.get("pm10", 0)

    # Approximate PM2.5-based indicator, not official AQI
    if pm25 <= 12:
        aqi = round(pm25 * 50 / 12)
    elif pm25 <= 35.4:
        aqi = round(50 + (pm25 - 12.1) * 50 / 23.3)
    elif pm25 <= 55.4:
        aqi = round(100 + (pm25 - 35.5) * 50 / 19.9)
    elif pm25 <= 150.4:
        aqi = round(150 + (pm25 - 55.5) * 100 / 94.9)
    else:
        aqi = min(500, round(250 + (pm25 - 150.5) * 250 / 349.5))

    return {
        "pm25": pm25,
        "pm10": pm10,
        "no2": current.get("nitrogen_dioxide"),
        "o3": current.get("ozone"),
        "aqi_indicator": aqi
    }


def calculate_exposure(aqi, profile, activity, duration):
    multipliers = {
        "child": 1.25,
        "adult": 1.0,
        "elderly": 1.2,
        "outdoor_worker": 1.1,
        "sensitive": 1.25
    }

    score = aqi * multipliers.get(profile, 1.0)

    if activity == "outdoor":
        score *= 1.25

    score *= min(max(duration, 15) / 60, 2)

    score = min(100, round(score))

    if score <= 25:
        level = "LOW"
    elif score <= 50:
        level = "MODERATE"
    elif score <= 75:
        level = "HIGH"
    else:
        level = "VERY HIGH"

    return {"score": score, "level": level}


def lambda_handler(event, context):
    try:
        params = event.get("queryStringParameters") or {}

        lat = float(params.get("lat", 22.5726))
        lon = float(params.get("lon", 88.3639))
        profile = params.get("profile", "adult")
        activity = params.get("activity", "outdoor")
        duration = int(params.get("duration", 60))

        air = get_air_quality(lat, lon)
        exposure = calculate_exposure(
            air["aqi_indicator"], profile, activity, duration
        )

        aqi = air["aqi_indicator"]

        if aqi <= 50:
            school = {"status": "GREEN", "advice": "Normal outdoor activities may continue."}
        elif aqi <= 100:
            school = {"status": "YELLOW", "advice": "Sensitive students should limit strenuous outdoor activity."}
        elif aqi <= 150:
            school = {"status": "ORANGE", "advice": "Reduce prolonged outdoor activities."}
        else:
            school = {"status": "RED", "advice": "Move activities indoors and follow local health guidance."}

        return {
            "statusCode": 200,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Allow-Methods": "GET,OPTIONS"
            },
            "body": json.dumps({
                "success": True,
                "air": air,
                "exposure": exposure,
                "school": school,
                "note": "AQI indicator is an approximation based on PM2.5, not an official AQI reading."
            })
        }

    except Exception as error:
        return {
            "statusCode": 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Allow-Methods": "GET,OPTIONS"
            },
            "body": json.dumps({
                "success": False,
                "error": str(error)
            })
        }