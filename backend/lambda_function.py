
import base64
import json
import os
import re
import statistics
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

# --------------------------------------------------
# Configuration
# --------------------------------------------------
AWS_REGION = os.getenv("AWS_REGION", "ap-south-1")
HISTORY_TABLE_NAME = os.getenv("HISTORY_TABLE_NAME", "SAANS-AirHistory")
COMMUNITY_TABLE_NAME = os.getenv("COMMUNITY_TABLE_NAME", "SAANS-CommunityReports")
INDOOR_TABLE_NAME = os.getenv("INDOOR_TABLE_NAME", "SAANS-IndoorReadings")
ALERTS_TABLE_NAME = os.getenv("ALERTS_TABLE_NAME", "SAANS-EmailAlerts")

BEDROCK_REGION = os.getenv("BEDROCK_REGION", "us-east-1")
BEDROCK_MANTLE_BASE_URL = os.getenv(
    "BEDROCK_MANTLE_BASE_URL",
    "https://bedrock-mantle.us-east-1.api.aws/v1"
).rstrip("/")
BEDROCK_MANTLE_API_KEY = os.getenv("BEDROCK_MANTLE_API_KEY", "")
BEDROCK_MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "nvidia.nemotron-nano-3-30b")

FRONTEND_ORIGIN = os.getenv(
    "FRONTEND_ORIGIN",
    "https://main.dzqynxwvp9m6q.amplifyapp.com"
)
SES_REGION = os.getenv("SES_REGION", AWS_REGION)
SES_FROM_EMAIL = os.getenv("SES_FROM_EMAIL", "")

dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
history_table = dynamodb.Table(HISTORY_TABLE_NAME)
community_table = dynamodb.Table(COMMUNITY_TABLE_NAME)
indoor_table = dynamodb.Table(INDOOR_TABLE_NAME)
alerts_table = dynamodb.Table(ALERTS_TABLE_NAME)
ses = boto3.client("ses", region_name=SES_REGION)


# --------------------------------------------------
# Common helpers
# --------------------------------------------------
def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def json_default(value):
    if isinstance(value, Decimal):
        return float(value)
    raise TypeError(f"Unsupported JSON value: {type(value).__name__}")


def response(status, payload):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Vary": "Origin",
        },
        "body": json.dumps(
            payload, default=json_default, ensure_ascii=False
        ),
    }


def get_params(event):
    return event.get("queryStringParameters") or {}


def get_body(event):
    body = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    if isinstance(body, dict):
        return body
    try:
        return json.loads(body)
    except (TypeError, json.JSONDecodeError):
        return {}


def get_path(event):
    return (event.get("rawPath") or event.get("path") or "/").rstrip("/") or "/"


def slug(value):
    import unicodedata
    value = unicodedata.normalize("NFKD", str(value or "kolkata"))
    value = "".join(c for c in value if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:100] or "kolkata"


def number(value, low=None, high=None):
    if value is None or value == "":
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ValueError("A numeric value is required.")
    if low is not None and result < low:
        raise ValueError(f"Value must be at least {low}.")
    if high is not None and result > high:
        raise ValueError(f"Value must be no more than {high}.")
    return result


def coordinates(params):
    lat = number(params.get("latitude", params.get("lat", 22.5726)), -90, 90)
    lon = number(params.get("longitude", params.get("lon", 88.3639)), -180, 180)
    return lat, lon


def get_json_url(url, timeout=15):
    request = urllib.request.Request(
        url, headers={"User-Agent": "SAANS-AirSafety/2.0"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as result:
        return json.loads(result.read().decode("utf-8"))


def fetch_air(lat, lon):
    query = urllib.parse.urlencode({
        "latitude": lat,
        "longitude": lon,
        "current": "pm2_5,pm10,nitrogen_dioxide,ozone,us_aqi",
        "timezone": "auto",
    })
    data = get_json_url(
        f"https://air-quality-api.open-meteo.com/v1/air-quality?{query}"
    )
    current = data.get("current") or {}
    return {
        "pm25": current.get("pm2_5"),
        "pm10": current.get("pm10"),
        "no2": current.get("nitrogen_dioxide"),
        "o3": current.get("ozone"),
        "aqi_indicator": current.get("us_aqi"),
        "observed_at": current.get("time"),
    }


def save_history(location, air):
    # Preserve the existing SAANS-AirHistory partition/sort key schema.
    item = {
        "location_id": slug(location),
        "timestamp": air.get("observed_at") or utc_now(),
        "location": location,
    }
    for field in ("pm25", "pm10", "no2", "o3", "aqi_indicator"):
        if air.get(field) is not None:
            item[field] = Decimal(str(air[field]))
    history_table.put_item(Item=item)


def external_error(exc):
    print(f"External service error: {type(exc).__name__}: {exc}")
    return response(502, {
        "success": False,
        "error": "An external service could not provide the requested data."
    })


# --------------------------------------------------
# Existing API: GET /air
# --------------------------------------------------
def handle_air(event):
    params = get_params(event)
    lat, lon = coordinates(params)
    location = str(params.get("location") or "Kolkata")[:120]
    air = fetch_air(lat, lon)

    history_saved = True
    try:
        save_history(location, air)
    except Exception as exc:
        print(f"History save failed: {type(exc).__name__}: {exc}")
        history_saved = False

    return response(200, {
        "success": True,
        "location": location,
        "location_id": slug(location),
        "coordinates": {"latitude": lat, "longitude": lon},
        "air": air,
        "history_saved": history_saved,
        "note": (
            "AQI indicator is Open-Meteo's estimated US AQI, "
            "not India's official CPCB AQI."
        ),
    })


# --------------------------------------------------
# Existing API: GET /history
# --------------------------------------------------
def handle_history(event):
    params = get_params(event)
    location_id = (
        params.get("location_id")
        or slug(params.get("location", "Kolkata"))
    )[:100]
    limit = max(1, min(100, int(params.get("limit", "48"))))

    result = history_table.query(
        KeyConditionExpression=Key("location_id").eq(location_id),
        ScanIndexForward=False,
        Limit=limit,
    )
    return response(200, {
        "success": True,
        "location_id": location_id,
        "history": result.get("Items", []),
    })


# --------------------------------------------------
# New API: GET /forecast
# --------------------------------------------------
def handle_forecast(event):
    params = get_params(event)
    lat, lon = coordinates(params)
    location = str(params.get("location") or "Kolkata")[:120]

    query = urllib.parse.urlencode({
        "latitude": lat,
        "longitude": lon,
        "hourly": "pm2_5,pm10,nitrogen_dioxide,ozone,us_aqi",
        "forecast_days": 3,
        "timezone": "auto",
    })
    data = get_json_url(
        f"https://air-quality-api.open-meteo.com/v1/air-quality?{query}"
    )
    hourly = data.get("hourly") or {}
    times = hourly.get("time") or []
    forecast = []

    for i, when in enumerate(times[:72]):
        row = {"time": when}
        for source, target in (
            ("pm2_5", "pm25"),
            ("pm10", "pm10"),
            ("nitrogen_dioxide", "no2"),
            ("ozone", "o3"),
            ("us_aqi", "us_aqi"),
        ):
            values = hourly.get(source) or []
            row[target] = values[i] if i < len(values) else None
        forecast.append(row)

    return response(200, {
        "success": True,
        "location": location,
        "forecast": forecast,
        "source": "Open-Meteo Air Quality API",
        "note": "Forecast values are estimates, not observations or official CPCB AQI.",
    })


# --------------------------------------------------
# New API: GET /patterns
# --------------------------------------------------
def handle_patterns(event):
    params = get_params(event)
    location_id = (
        params.get("location_id")
        or slug(params.get("location", "Kolkata"))
    )[:100]
    limit = max(2, min(100, int(params.get("limit", "100"))))

    result = history_table.query(
        KeyConditionExpression=Key("location_id").eq(location_id),
        ScanIndexForward=False,
        Limit=limit,
    )
    rows = list(reversed(result.get("Items", [])))
    values = [
        float(row.get("aqi_indicator", row.get("aqi")))
        for row in rows
        if row.get("aqi_indicator", row.get("aqi")) is not None
    ]

    if not values:
        patterns = {
            "count": 0,
            "mean_aqi": None,
            "max_aqi": None,
            "trend": "insufficient data",
            "summary": "No saved readings are available yet.",
        }
    else:
        split = max(1, len(values) // 2)
        earlier = values[:split]
        later = values[split:]
        delta = (
            statistics.mean(later) - statistics.mean(earlier)
            if later else 0
        )
        trend = "rising" if delta > 5 else "falling" if delta < -5 else "roughly stable"
        patterns = {
            "count": len(values),
            "mean_aqi": round(statistics.mean(values), 1),
            "max_aqi": round(max(values), 1),
            "min_aqi": round(min(values), 1),
            "trend": trend,
            "summary": (
                f"Across {len(values)} saved readings, the average estimate "
                f"was {statistics.mean(values):.1f}. The recent readings are "
                f"{trend} compared with the earlier readings. This describes "
                "saved history; it is not a validated forecast."
            ),
        }

    return response(200, {
        "success": True, "location_id": location_id, "patterns": patterns
    })


# --------------------------------------------------
# New API: GET and POST /community
# --------------------------------------------------
def handle_community_get(event):
    params = get_params(event)
    limit = max(1, min(30, int(params.get("limit", "10"))))

    result = community_table.scan(Limit=100)
    rows = sorted(
        result.get("Items", []),
        key=lambda row: row.get("created_at", ""),
        reverse=True,
    )

    lat = number(params["latitude"], -90, 90) if params.get("latitude") else None
    lon = number(params["longitude"], -180, 180) if params.get("longitude") else None

    if lat is not None and lon is not None:
        # Approximate geographic box, not a precise distance/radius.
        rows = [
            row for row in rows
            if row.get("latitude") is not None
            and row.get("longitude") is not None
            and abs(float(row["latitude"]) - lat) <= 0.5
            and abs(float(row["longitude"]) - lon) <= 0.5
        ]

    fields = (
        "report_id", "location", "report_type",
        "notes", "created_at", "status"
    )
    return response(200, {
        "success": True,
        "reports": [
            {key: row.get(key) for key in fields}
            for row in rows[:limit]
        ],
        "note": "Community reports are unverified.",
    })


def handle_community_post(event):
    body = get_body(event)
    report_type = str(body.get("report_type") or "smoke")
    allowed = {"smoke", "dust", "indoor", "stubble_burning", "other"}
    if report_type not in allowed:
        return response(400, {
            "success": False, "error": "Unsupported report type."
        })

    location = str(body.get("location") or "Unknown location")[:120]
    lat = number(body.get("latitude"), -90, 90) if body.get("latitude") is not None else None
    lon = number(body.get("longitude"), -180, 180) if body.get("longitude") is not None else None

    record = {
        "report_id": str(uuid.uuid4()),
        "created_at": utc_now(),
        "location": location,
        "report_type": report_type,
        "notes": str(body.get("notes") or "")[:500],
        "status": "unverified",
    }
    if lat is not None:
        record["latitude"] = Decimal(str(lat))
    if lon is not None:
        record["longitude"] = Decimal(str(lon))

    community_table.put_item(Item=record)
    return response(201, {
        "success": True, "report": record,
        "note": "Report stored as unverified.",
    })


# --------------------------------------------------
# New API: GET and POST /indoor
# --------------------------------------------------
def handle_indoor_get(event):
    params = get_params(event)
    location_id = slug(params.get("location", "Kolkata"))
    limit = max(1, min(30, int(params.get("limit", "10"))))

    result = indoor_table.scan(Limit=100)
    rows = [
        row for row in result.get("Items", [])
        if row.get("location_id") == location_id
    ]
    rows.sort(key=lambda row: row.get("timestamp", ""), reverse=True)
    return response(200, {"success": True, "records": rows[:limit]})


def handle_indoor_post(event):
    body = get_body(event)
    location = str(body.get("location") or "Unknown location")[:120]
    pm25 = number(body.get("pm25"), 0, 5000)
    co2 = number(body.get("co2"), 250, 10000)
    source = str(body.get("source") or "observation")

    if source not in {"sensor", "observation"}:
        return response(400, {
            "success": False, "error": "Source must be sensor or observation."
        })

    record = {
        "record_id": str(uuid.uuid4()),
        "location_id": slug(location),
        "timestamp": utc_now(),
        "location": location,
        "source": source,
        "notes": str(body.get("notes") or "")[:500],
    }
    if pm25 is not None:
        record["pm25"] = Decimal(str(pm25))
    if co2 is not None:
        record["co2"] = Decimal(str(co2))

    indoor_table.put_item(Item=record)
    return response(201, {
        "success": True,
        "record": record,
        "note": "User-provided indoor reading; separate from outdoor data.",
    })


# --------------------------------------------------
# New API: POST /alerts/subscribe
# --------------------------------------------------
def handle_alert_subscribe(event):
    body = get_body(event)
    email = str(body.get("email") or "").strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return response(400, {
            "success": False, "error": "Enter a valid email address."
        })

    threshold = number(body.get("threshold", 100), 1, 500)
    lat = number(body.get("latitude", 22.5726), -90, 90)
    lon = number(body.get("longitude", 88.3639), -180, 180)
    location = str(body.get("location") or "Kolkata")[:120]

    item = {
        "email": email,
        "location_id": slug(location),
        "location": location,
        "latitude": Decimal(str(lat)),
        "longitude": Decimal(str(lon)),
        "threshold": Decimal(str(threshold)),
        "enabled": bool(body.get("enabled", True)),
        "updated_at": utc_now(),
        "last_alert_key": "",
    }
    alerts_table.put_item(Item=item)
    return response(200, {
        "success": True,
        "message": (
            "Alert settings saved. SES recipient verification may be "
            "required while your AWS account is in the SES sandbox."
        ),
    })


# --------------------------------------------------
# New API: POST /alerts/check
# Called by EventBridge Scheduler
# --------------------------------------------------
def send_email_alert(email, location, value, threshold, observed_at):
    if not SES_FROM_EMAIL:
        raise RuntimeError("SES_FROM_EMAIL is not configured.")

    ses.send_email(
        Source=SES_FROM_EMAIL,
        Destination={"ToAddresses": [email]},
        Message={
            "Subject": {
                "Data": f"SAANS air safety alert: {location}",
                "Charset": "UTF-8",
            },
            "Body": {
                "Text": {
                    "Data": (
                        f"SAANS air safety alert\n\nLocation: {location}\n"
                        f"Estimated US AQI: {value}\nThreshold: {threshold}\n"
                        f"Observation time: {observed_at}\n\n"
                        "This is an Open-Meteo US AQI estimate, not official "
                        "CPCB AQI or medical advice. Follow local guidance."
                    ),
                    "Charset": "UTF-8",
                }
            },
        },
    )


def handle_alert_check():
    if not SES_FROM_EMAIL:
        return response(500, {
            "success": False,
            "error": "Configure SES_FROM_EMAIL before sending alerts.",
        })

    subscriptions = alerts_table.scan(Limit=100).get("Items", [])
    sent, skipped, errors = 0, 0, []

    for sub in subscriptions:
        if not sub.get("enabled"):
            skipped += 1
            continue
        try:
            air = fetch_air(
                float(sub["latitude"]), float(sub["longitude"])
            )
            value = air.get("aqi_indicator")
            threshold = float(sub.get("threshold", 100))
            if value is None or float(value) < threshold:
                skipped += 1
                continue

            alert_key = (
                f'{air.get("observed_at")}:{int(float(value))}:{int(threshold)}'
            )
            if sub.get("last_alert_key") == alert_key:
                skipped += 1
                continue

            send_email_alert(
                sub["email"], sub["location"], value,
                threshold, air.get("observed_at", "unknown")
            )
            alerts_table.update_item(
                Key={
                    "email": sub["email"],
                    "location_id": sub["location_id"],
                },
                UpdateExpression="SET last_alert_key=:k, last_alert_at=:t",
                ExpressionAttributeValues={
                    ":k": alert_key, ":t": utc_now()
                },
            )
            sent += 1
        except Exception as exc:
            print(f"Alert failed: {type(exc).__name__}: {exc}")
            errors.append({
                "location_id": sub.get("location_id"),
                "error": "Alert failed; check Lambda logs.",
            })

    return response(200, {
        "success": True, "sent": sent, "skipped": skipped, "errors": errors
    })


# --------------------------------------------------
# Existing API: POST /chat — Bedrock Mantle
# --------------------------------------------------
def handle_chat(event):
    body = get_body(event)
    question = str(body.get("question") or body.get("message") or "").strip()

    if not question:
        return response(400, {
            "success": False, "error": "Please provide a question."
        })
    if not BEDROCK_MANTLE_API_KEY:
        return response(500, {
            "success": False, "error": "AI assistant is not configured."
        })

    location = str(body.get("location") or "Kolkata")
    air = body.get("air") or {}
    language = {
        "bn": "Bengali (বাংলা)",
        "hi": "Hindi (हिन्दी)",
        "en": "English",
    }.get(body.get("language"), "English")

    system = (
        "You are SAANS, an air-safety assistant. Reply in " + language + ". "
        "Use supplied readings as context; never invent live readings. "
        "Clearly say that Open-Meteo's US AQI estimate is not official CPCB AQI. "
        "Distinguish forecasts from observations. Community reports are unverified. "
        "Give practical, non-medical precautions; do not diagnose or issue school "
        "closure orders. Encourage following local public-health guidance."
    )

    messages = [{"role": "system", "content": system}]
    for item in (body.get("history") or [])[-8:]:
        role = item.get("role")
        content = str(item.get("content") or "")
        if role in {"user", "assistant"} and content:
            messages.append({"role": role, "content": content[:3000]})

    context = {
        "location": location,
        "current_air": air,
        "aqi_caveat": "estimated US AQI, not official CPCB AQI",
    }
    messages.append({
        "role": "user",
        "content": question + "\n\nDashboard context: " +
                   json.dumps(context, default=json_default),
    })

    payload = json.dumps({
        "model": BEDROCK_MODEL_ID,
        "messages": messages,
        "max_tokens": 700,
        "temperature": 0.4,
        "stream": False,
    }).encode("utf-8")

    request = urllib.request.Request(
        f"{BEDROCK_MANTLE_BASE_URL}/chat/completions",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {BEDROCK_MANTLE_API_KEY}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=35) as result:
            data = json.loads(result.read().decode("utf-8"))
        answer = data["choices"][0]["message"]["content"]
        return response(200, {
            "success": True, "answer": answer,
            "used_air_context": bool(air),
        })
    except urllib.error.HTTPError as exc:
        print(f"Bedrock Mantle HTTP error: {exc.code}")
        return response(502, {
            "success": False,
            "error": f"AI service returned HTTP {exc.code}. Check Lambda logs.",
        })
    except Exception as exc:
        print(f"Bedrock request failed: {type(exc).__name__}: {exc}")
        return response(502, {
            "success": False,
            "error": "AI request failed. Check Lambda logs and configuration.",
        })


# --------------------------------------------------
# Lambda router — existing and new APIs
# --------------------------------------------------
def lambda_handler(event, context):
    method = (
        event.get("requestContext", {}).get("http", {}).get("method")
        or event.get("httpMethod")
        or "GET"
    ).upper()
    path = get_path(event).lower()

    if method == "OPTIONS":
        return response(204, {})

    try:
        if path.endswith("/air") and method == "GET":
            return handle_air(event)
        if path.endswith("/history") and method == "GET":
            return handle_history(event)
        if path.endswith("/chat") and method == "POST":
            return handle_chat(event)
        if path.endswith("/forecast") and method == "GET":
            return handle_forecast(event)
        if path.endswith("/patterns") and method == "GET":
            return handle_patterns(event)
        if path.endswith("/community") and method == "GET":
            return handle_community_get(event)
        if path.endswith("/community") and method == "POST":
            return handle_community_post(event)
        if path.endswith("/indoor") and method == "GET":
            return handle_indoor_get(event)
        if path.endswith("/indoor") and method == "POST":
            return handle_indoor_post(event)
        if path.endswith("/alerts/subscribe") and method == "POST":
            return handle_alert_subscribe(event)
        if path.endswith("/alerts/check") and method == "POST":
            return handle_alert_check()

        return response(404, {
            "success": False,
            "error": f"Route not found: {method} {path}",
        })
    except ValueError as exc:
        return response(400, {"success": False, "error": str(exc)})
    except urllib.error.HTTPError as exc:
        return external_error(exc)
    except Exception as exc:
        print(f"SAANS handler error: {type(exc).__name__}: {exc}")
        return response(500, {
            "success": False,
            "error": "Internal server error. Check Lambda CloudWatch logs.",
        })
