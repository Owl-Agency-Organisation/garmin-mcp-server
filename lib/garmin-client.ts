// ---------------------------------------------------------------------------
// Client Garmin pour les routes hors connecteur MCP (endpoint FIT).
//
// Copie conforme de getGarminClient de app/api/mcp/[secret]/route.ts, laissé
// intact (périmètre de la PR). Next.js interdit d'exporter une fonction depuis
// une route, d'où ce module. Aucune perte de cache : sur Vercel, chaque route
// est une fonction distincte avec sa propre mémoire.
// ---------------------------------------------------------------------------
import { GarminConnect } from "garmin-connect";

let cachedClient: GarminConnect | null = null;
let cachedAt = 0;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

export async function getGarminClient(): Promise<GarminConnect> {
  const now = Date.now();
  if (cachedClient && now - cachedAt < SESSION_TTL_MS) {
    return cachedClient;
  }
  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Variables GARMIN_EMAIL / GARMIN_PASSWORD absentes. " +
        "Ajoutez-les dans Vercel (Settings > Environment Variables) puis redéployez."
    );
  }
  const client = new GarminConnect({ username: email, password });
  await client.login();
  cachedClient = client;
  cachedAt = now;
  return client;
}
