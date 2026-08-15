import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { GarminConnect } from "garmin-connect";

export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Client Garmin — session mise en cache en mémoire (réutilisée tant que la
// lambda est chaude) pour limiter les logins répétés et le rate limiting.
// ---------------------------------------------------------------------------
let cachedClient: GarminConnect | null = null;
let cachedAt = 0;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function getGarminClient(): Promise<GarminConnect> {
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

// ---------------------------------------------------------------------------
// Helpers dates & formatage
// ---------------------------------------------------------------------------
function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return toDateString(d);
}

function secondsToHM(s: number | null | undefined): string | null {
  if (s == null) return null;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return `${h}h${String(m).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Accès données
// ---------------------------------------------------------------------------
async function fetchSleep(client: GarminConnect, date: string) {
  const raw: any = await client.getSleepData(new Date(`${date}T12:00:00Z`));
  const dto = raw?.dailySleepDTO ?? raw ?? {};
  return {
    date,
    score: dto?.sleepScores?.overall?.value ?? null,
    qualite: dto?.sleepScores?.overall?.qualifierKey ?? null,
    duree_totale: secondsToHM(dto?.sleepTimeSeconds),
    sommeil_profond: secondsToHM(dto?.deepSleepSeconds),
    sommeil_leger: secondsToHM(dto?.lightSleepSeconds),
    sommeil_paradoxal: secondsToHM(dto?.remSleepSeconds),
    eveil: secondsToHM(dto?.awakeSleepSeconds),
  };
}

async function fetchHrv(client: GarminConnect, date: string) {
  // Endpoint HRV non enveloppé par la librairie : appel direct authentifié.
  const raw: any = await (client as any).get(
    `https://connectapi.garmin.com/hrv-service/hrv/${date}`
  );
  const s = raw?.hrvSummary ?? {};
  return {
    date,
    vfc_nocturne_moyenne_ms: s?.lastNightAvg ?? null,
    vfc_pic_5min_ms: s?.lastNight5MinHigh ?? null,
    moyenne_7j_ms: s?.weeklyAvg ?? null,
    statut: s?.status ?? null,
    plage_equilibre_ms:
      s?.baseline?.balancedLow != null && s?.baseline?.balancedUpper != null
        ? `${s.baseline.balancedLow}-${s.baseline.balancedUpper}`
        : null,
  };
}

function asText(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function asError(e: unknown, contexte: string) {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Erreur lors de ${contexte} : ${msg}. ` +
          `Causes fréquentes : identifiants invalides, MFA activé sur le compte Garmin, ` +
          `ou rate limiting temporaire (réessayer dans quelques minutes).`,
      },
    ],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Serveur MCP — 3 tools en lecture seule
// ---------------------------------------------------------------------------
const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "sommeil_recent",
      {
        title: "Sommeil d'une nuit",
        description:
          "Récupère le détail du sommeil pour une date donnée (score, durée totale, phases profond/léger/paradoxal, éveil). Par défaut : la nuit dernière.",
        inputSchema: {
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("Date au format YYYY-MM-DD (défaut : hier)"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ date }) => {
        try {
          const client = await getGarminClient();
          return asText(await fetchSleep(client, date ?? yesterday()));
        } catch (e) {
          return asError(e, "la récupération du sommeil");
        }
      }
    );

    server.registerTool(
      "vfc_recente",
      {
        title: "VFC nocturne",
        description:
          "Récupère la variabilité de la fréquence cardiaque (VFC/HRV) nocturne pour une date donnée : moyenne, pic 5 min, moyenne 7 jours, statut. Par défaut : la nuit dernière.",
        inputSchema: {
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("Date au format YYYY-MM-DD (défaut : hier)"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ date }) => {
        try {
          const client = await getGarminClient();
          return asText(await fetchHrv(client, date ?? yesterday()));
        } catch (e) {
          return asError(e, "la récupération de la VFC");
        }
      }
    );

    server.registerTool(
      "resume_hebdo",
      {
        title: "Résumé 7 jours sommeil + VFC",
        description:
          "Synthèse des 7 derniers jours : score et durée de sommeil + VFC nocturne, jour par jour. Utile pour analyser tendance et récupération.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async () => {
        try {
          const client = await getGarminClient();
          const jours: any[] = [];
          for (let i = 7; i >= 1; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const date = toDateString(d);
            const [sommeil, vfc] = await Promise.all([
              fetchSleep(client, date).catch(() => null),
              fetchHrv(client, date).catch(() => null),
            ]);
            jours.push({
              date,
              sommeil_score: sommeil?.score ?? null,
              sommeil_duree: sommeil?.duree_totale ?? null,
              vfc_moyenne_ms: vfc?.vfc_nocturne_moyenne_ms ?? null,
              vfc_statut: vfc?.statut ?? null,
            });
          }
          return asText({ periode: "7 derniers jours", jours });
        } catch (e) {
          return asError(e, "la génération du résumé hebdomadaire");
        }
      }
    );
  },
  { serverInfo: { name: "garmin-mcp-server", version: "0.1.0" } }
);

// ---------------------------------------------------------------------------
// Protection de l'endpoint : clé secrète en paramètre d'URL (?key=...)
// claude.ai ne permettant pas de headers personnalisés sur les connecteurs.
// ---------------------------------------------------------------------------
function withAuth(h: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    const secret = process.env.MCP_SECRET;
    const key = new URL(req.url).searchParams.get("key");
    if (!secret || key !== secret) {
      return new Response("Unauthorized", { status: 401 });
    }
    return h(req);
  };
}

export const GET = withAuth(handler);
export const POST = withAuth(handler);
export const DELETE = withAuth(handler);
