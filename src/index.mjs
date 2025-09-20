import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const REGION = process.env.AWS_REGION || "sa-east-1";
const SECRET_NAME = process.env.SECRET_NAME || "google/places";
const GOOGLE_PLACE_ID = process.env.GOOGLE_PLACE_ID;
const CACHE_MAX_AGE = Number(process.env.CACHE_MAX_AGE || 21600); // segundos
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const sm = new SecretsManagerClient({ region: REGION });

// Cache en memoria (se conserva entre invocaciones en el mismo warm container)
let cache = { ts: 0, data: null };

async function getGoogleApiKey() {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
  const json = res.SecretString ? JSON.parse(res.SecretString) : {};
  const key = json.GOOGLE_API_KEY;
  if (!key) throw new Error("Missing GOOGLE_API_KEY in secret");
  return key;
}

function response(statusCode, bodyObj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Cache-Control": `public, max-age=${CACHE_MAX_AGE}`
    },
    body: JSON.stringify(bodyObj),
  };
}

export const handler = async (event) => {
  // Preflight CORS
  if (event.requestContext?.http?.method === "OPTIONS") {
    return response(200, { ok: true });
  }

  try {
    if (!GOOGLE_PLACE_ID) {
      return response(500, { error: "GOOGLE_PLACE_ID env is missing" });
    }

    // Cache válido?
    const now = Math.floor(Date.now() / 1000);
    if (cache.data && (now - cache.ts) < CACHE_MAX_AGE) {
      return response(200, cache.data);
    }

    const apiKey = await getGoogleApiKey();
    const fields = "name,rating,user_ratings_total,url,reviews";
    const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
    url.searchParams.set("place_id", GOOGLE_PLACE_ID);
    url.searchParams.set("fields", fields);
    url.searchParams.set("key", apiKey);

    const r = await fetch(url, { method: "GET" });
    const json = await r.json();

    if (json.status !== "OK") {
      // Log detallado para troubleshooting
      console.error("Google Places error:", json);
      return response(502, { error: "Upstream error from Google Places", details: json.status });
    }

    // Minimizar payload si es necesario (aquí pasamos directo)
    const data = {
      name: json.result?.name,
      rating: json.result?.rating,
      user_ratings_total: json.result?.user_ratings_total,
      url: json.result?.url,
      reviews: json.result?.reviews || []
    };

    cache = { ts: now, data };
    return response(200, data);
  } catch (err) {
    console.error("Lambda error:", err);
    return response(500, { error: "Internal Server Error" });
  }
};
