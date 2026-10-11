
import json
import os
import re
import urllib.request
import urllib.parse
import urllib.error
import base64
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError


# ============================================================
# CONFIGURATION
# ============================================================

# DynamoDB and air-quality history remain in Mumbai.
AWS_REGION = os.environ.get("AWS_REGION", "ap-south-1")
TABLE_NAME = os.environ.get(
    "HISTORY_TABLE_NAME",
    "SAANS-AirHistory"
)

# Amazon Bedrock Mantle chatbot in N. Virginia.
BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")

MANTLE_BASE_URL = os.environ.get(
    "BEDROCK_MANTLE_BASE_URL",
    "https://bedrock-mantle.us-east-1.api.aws/v1"
).rstrip("/")

MANTLE_API_KEY = os.environ.get("BEDROCK_MANTLE_API_KEY", "")

MODEL_ID = os.environ.get(
    "BEDROCK_MODEL_ID",
    "nvidia.nemotron-nano-3-30b"
)

FRONTEND_ORIGIN = os.environ.get(
    "FRONTEND_ORIGIN",
    "https://main.dzqynxwvp9m6q.amplifyapp.com"
)

# DynamoDB client/resource in Mumbai.
dynamodb = boto3.resource(
    "dynamodb",
    region_name=AWS_REGION
)
history_table = dynamodb.Table(TABLE_NAME)


# ============================================================
# GENERAL HELPERS
# ============================================================

def json_default(value):
    if isinstance(value, Decimal):
        if value % 1 == 0:
            return int(value)
        return float(value)

    raise TypeError(
        f"Object of type {type(value).__name__} is not JSON serializable"
    )


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Vary": "Origin"
        },
        "body": json.dumps(
            body,
            default=json_default,
            ensure_ascii=False
        )
    }


def get_params(event):
    return event.get("queryStringParameters") or {}


def get_body(event):
    body = event.get("body")

    if not body:
        return {}

    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")

    if isinstance(body, dict):
        return body

    try:
        parsed = json.loads(body)
        return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def slug(value):
    value = str(value or "Kolkata").strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "kolkata"


def safe_float(value):
    try:
        if value is None:
            return None
        return float(value)
    except (ValueError, TypeError):
        return None


# ============================================================
# LIVE AIR QUALITY — OPEN-METEO
# ============================================================

def get_air_quality(latitude, longitude):
    query = urllib.parse.urlencode({
        "latitude": latitude,
        "longitude": longitude,
        "current": "pm2_5,pm10,nitrogen_dioxide,ozone,us_aqi",
        "timezone": "auto"
    })

    url = (
        "https://air-quality-api.open-meteo.com/v1/air-quality?"
        + query
    )

    request = urllib.request.Request(
        url,
        headers={"User-Agent": "SAANS-AirSafetySystem/1.0"}
    )

    try:
        with urllib.request.urlopen(request, timeout=15) as result:
            data = json.loads(result.read().decode("utf-8"))

    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(
            "Could not retrieve live air-quality data."
        ) from exc

    current = data.get("current")

    if not current:
        raise RuntimeError(
            "The air-quality provider returned no current measurements."
        )

    return {
        "pm25": safe_float(current.get("pm2_5")),
        "pm10": safe_float(current.get("pm10")),
        "no2": safe_float(current.get("nitrogen_dioxide")),
        "o3": safe_float(current.get("ozone")),
        "aqi_indicator": safe_float(current.get("us_aqi")),
        "observed_at": current.get("time")
    }


# ============================================================
# SAVE HISTORY — DYNAMODB
# ============================================================

def save_history(location, latitude, longitude, air):
    now = datetime.now(timezone.utc).isoformat()

    item = {
        "location_id": slug(location),
        "timestamp": now,
        "location": str(location),
        "latitude": Decimal(str(latitude)),
        "longitude": Decimal(str(longitude)),
        "observed_at": str(air.get("observed_at") or now)
    }

    for field in ("pm25", "pm10", "no2", "o3", "aqi_indicator"):
        value = air.get(field)
        if value is not None:
            item[field] = Decimal(str(value))

    history_table.put_item(Item=item)
    return True


# ============================================================
# GET /air
# ============================================================

def handle_air(event):
    params = get_params(event)

    location = str(
        params.get("location") or "Kolkata"
    ).strip() or "Kolkata"

    latitude = safe_float(params.get("lat"))
    longitude = safe_float(params.get("lon"))

    if latitude is None:
        latitude = 22.5726

    if longitude is None:
        longitude = 88.3639

    if not -90 <= latitude <= 90:
        return response(400, {
            "success": False,
            "error": "Latitude must be between -90 and 90."
        })

    if not -180 <= longitude <= 180:
        return response(400, {
            "success": False,
            "error": "Longitude must be between -180 and 180."
        })

    try:
        air = get_air_quality(latitude, longitude)
    except RuntimeError as exc:
        return response(502, {
            "success": False,
            "error": str(exc)
        })

    history_saved = False

    try:
        save_history(location, latitude, longitude, air)
        history_saved = True
    except Exception as exc:
        print("SAANS history save failed:", str(exc))

    return response(200, {
        "success": True,
        "location": location,
        "location_id": slug(location),
        "air": air,
        "history_saved": history_saved,
        "note": (
            "AQI indicator uses Open-Meteo's US AQI estimate, "
            "not India's official CPCB AQI."
        )
    })


# ============================================================
# GET /history
# ============================================================

def handle_history(event):
    params = get_params(event)

    location = str(
        params.get("location") or "Kolkata"
    ).strip() or "Kolkata"

    location_id = slug(location)

    try:
        result = history_table.query(
            KeyConditionExpression=Key(
                "location_id"
            ).eq(location_id),
            ScanIndexForward=False,
            Limit=100
        )

        items = result.get("Items", [])

        return response(200, {
            "success": True,
            "location": location,
            "location_id": location_id,
            "count": len(items),
            "history": items
        })

    except ClientError as exc:
        error_code = exc.response.get(
            "Error", {}
        ).get("Code", "Unknown")

        print("SAANS history error:", error_code)

        return response(500, {
            "success": False,
            "error": "Could not retrieve air-quality history."
        })


# ============================================================
# POST /chat — AMAZON BEDROCK MANTLE
# ============================================================

def handle_chat(event):
    body = get_body(event)

    user_message = (
        body.get("message")
        or body.get("question")
        or body.get("prompt")
    )

    if (
        not isinstance(user_message, str)
        or not user_message.strip()
    ):
        return response(400, {
            "success": False,
            "error": "Please provide a message."
        })

    user_message = user_message.strip()

    if len(user_message) > 10000:
        return response(400, {
            "success": False,
            "error": "Message is too long."
        })

    if not MANTLE_API_KEY:
        print("SAANS configuration error: Mantle API key is missing.")

        return response(500, {
            "success": False,
            "error": "The chatbot API key is not configured in Lambda."
        })

    system_prompt = """
You are SAANS, an air-quality and pollution-safety assistant
for the SAANS Air Safety System in India.

Help school students, teachers, families, and outdoor workers
understand air pollution and reduce exposure.

Explain PM2.5, PM10, ozone, nitrogen dioxide, indoor air pollution,
stubble burning, and school safety in clear, practical language.

Give actionable advice for high-pollution days. Encourage people
to consult CPCB and relevant state pollution-control-board advisories
for official local information.

Never invent live readings or claim to have checked current conditions
unless actual measurements are supplied in the conversation.
The system's Open-Meteo AQI indicator is a US AQI estimate, not
India's official CPCB AQI.

Do not diagnose illnesses or prescribe medicines. For severe breathing
difficulty, recommend urgent medical care. Keep responses friendly,
accurate, and concise.
"""

    request_body = {
        "model": MODEL_ID,
        "messages": [
            {
                "role": "system",
                "content": system_prompt
            },
            {
                "role": "user",
                "content": user_message
            }
        ],
        "max_tokens": 700,
        "temperature": 0.4,
        "stream": False
    }

    request = urllib.request.Request(
        f"{MANTLE_BASE_URL}/chat/completions",
        data=json.dumps(request_body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {MANTLE_API_KEY}"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(request, timeout=60) as result:
            model_response = json.loads(
                result.read().decode("utf-8")
            )

        choices = model_response.get("choices", [])
        answer = ""

        if choices:
            message = choices[0].get("message", {})
            answer = message.get("content", "")

        if isinstance(answer, list):
            answer = "\n".join(
                part.get("text", "")
                for part in answer
                if isinstance(part, dict)
            )

        answer = str(answer).strip()

        if not answer:
            print(
                "SAANS Mantle returned no answer. Response keys:",
                list(model_response.keys())
            )

            return response(502, {
                "success": False,
                "error": "The AI model returned an empty response.",
                "model": MODEL_ID,
                "region": BEDROCK_REGION
            })

        return response(200, {
            "success": True,
            "answer": answer,
            "provider": "Amazon Bedrock Mantle",
            "model": MODEL_ID,
            "region": BEDROCK_REGION
        })

    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")

        # Log the response body for debugging, but never log the API key.
        print(
            "SAANS Mantle HTTP error:",
            exc.code,
            error_body[:3000]
        )

        try:
            error_data = json.loads(error_body)
        except json.JSONDecodeError:
            error_data = {"message": error_body[:1000]}

        return response(502, {
            "success": False,
            "error": "The SAANS AI assistant could not process the request.",
            "http_status": exc.code,
            "details": error_data,
            "model": MODEL_ID,
            "region": BEDROCK_REGION
        })

    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        print("SAANS Mantle connection error:", str(exc))

        return response(502, {
            "success": False,
            "error": "Could not connect to the Bedrock Mantle endpoint.",
            "region": BEDROCK_REGION
        })

    except Exception as exc:
        print("SAANS chatbot unexpected error:", str(exc))

        return response(500, {
            "success": False,
            "error": "An unexpected chatbot error occurred."
        })


# ============================================================
# MAIN LAMBDA HANDLER — API GATEWAY
# ============================================================

def lambda_handler(event, context):
    method = (
        event.get("requestContext", {})
        .get("http", {})
        .get("method")
        or event.get("httpMethod")
        or "GET"
    ).upper()

    raw_path = (
        event.get("rawPath")
        or event.get("path")
        or "/"
    )

    path = raw_path.rstrip("/") or "/"

    if method == "OPTIONS":
        return response(200, {"success": True})

    if method == "GET" and path.endswith("/air"):
        return handle_air(event)

    if method == "GET" and path.endswith("/history"):
        return handle_history(event)

    if method == "POST" and path.endswith("/chat"):
        return handle_chat(event)

    return response(404, {
        "success": False,
        "error": "Route not found.",
        "path": path,
        "method": method,
        "available_routes": [
            "GET /air",
            "GET /history",
            "POST /chat"
        ]
    })
