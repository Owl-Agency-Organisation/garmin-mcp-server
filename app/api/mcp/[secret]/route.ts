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

// Date du jour (ou décalée de n jours) dans le fuseau de Phil.
// Indispensable : le serveur tourne en UTC, et Garmin indexe une nuit de
// sommeil par la date du réveil — « la nuit dernière » = date du jour.
function dateParis(offsetJours = 0): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
  }).format(new Date(Date.now() + offsetJours * 86400000));
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

async function fetchWeight(client: GarminConnect, date: string) {
  // Endpoint poids non enveloppé par la librairie : appel direct authentifié.
  // Retourne la dernière pesée enregistrée à la date donnée ou avant.
  const raw: any = await (client as any).get(
    `https://connectapi.garmin.com/weight-service/weight/latest?date=${date}`
  );
  const grams = raw?.weight ?? null;
  const ts = raw?.date ?? raw?.timestampGMT ?? null;
  return {
    date_pesee:
      raw?.calendarDate ??
      (typeof ts === "number"
        ? new Date(ts).toISOString().slice(0, 10)
        : null),
    heure_pesee:
      typeof ts === "number"
        ? new Date(ts).toISOString().slice(11, 16)
        : null,
    poids_kg: grams != null ? Math.round(grams / 10) / 100 : null,
    imc: raw?.bmi ?? null,
    masse_grasse_pct: raw?.bodyFat ?? null,
    masse_musculaire_kg:
      raw?.muscleMass != null ? Math.round(raw.muscleMass / 10) / 100 : null,
    source: raw?.sourceType ?? null,
  };
}

async function fetchActivities(client: GarminConnect, nombre: number) {
  const raw: any[] = await client.getActivities(0, nombre);
  return (raw ?? []).map((a: any) => ({
    date: a?.startTimeLocal ?? null,
    nom: a?.activityName ?? null,
    type: a?.activityType?.typeKey ?? null,
    duree: secondsToHM(a?.duration != null ? Math.round(a.duration) : null),
    distance_km:
      a?.distance != null ? Math.round(a.distance / 10) / 100 : null,
    calories: a?.calories != null ? Math.round(a.calories) : null,
    fc_moyenne: a?.averageHR != null ? Math.round(a.averageHR) : null,
  }));
}

let cachedDisplayName: string | null = null;

async function getDisplayName(client: GarminConnect): Promise<string> {
  if (cachedDisplayName) return cachedDisplayName;
  const profile: any = await client.getUserProfile();
  const dn = profile?.displayName;
  if (!dn) throw new Error("displayName introuvable dans le profil Garmin");
  cachedDisplayName = dn;
  return dn;
}

function nonNegatif(v: unknown): number | null {
  return typeof v === "number" && v >= 0 ? v : null;
}

async function fetchDailySummary(client: GarminConnect, date: string) {
  const dn = await getDisplayName(client);
  const [raw, resp] = await Promise.all([
    (client as any).get(
      `https://connectapi.garmin.com/usersummary-service/usersummary/daily/${dn}?calendarDate=${date}`
    ),
    (client as any)
      .get(
        `https://connectapi.garmin.com/wellness-service/wellness/daily/respiration/${date}`
      )
      .catch(() => null),
  ]);
  return {
    date,
    body_battery_haut: raw?.bodyBatteryHighestValue ?? null,
    body_battery_bas: raw?.bodyBatteryLowestValue ?? null,
    body_battery_actuel: raw?.bodyBatteryMostRecentValue ?? null,
    fc_repos: nonNegatif(raw?.restingHeartRate),
    fc_min: nonNegatif(raw?.minHeartRate),
    fc_max: nonNegatif(raw?.maxHeartRate),
    stress_moyen: nonNegatif(raw?.averageStressLevel),
    stress_max: nonNegatif(raw?.maxStressLevel),
    stress_qualificatif: raw?.stressQualifier ?? null,
    temps_repos: secondsToHM(nonNegatif(raw?.restStressDuration)),
    temps_stress_total: secondsToHM(nonNegatif(raw?.totalStressDuration)),
    temps_stress_bas: secondsToHM(nonNegatif(raw?.lowStressDuration)),
    temps_stress_moyen: secondsToHM(nonNegatif(raw?.mediumStressDuration)),
    temps_stress_haut: secondsToHM(nonNegatif(raw?.highStressDuration)),
    temps_actif: secondsToHM(nonNegatif(raw?.activityStressDuration)),
    fr_respiratoire_eveil: nonNegatif(resp?.avgWakingRespirationValue),
    fr_respiratoire_sommeil: nonNegatif(resp?.avgSleepRespirationValue),
    fr_respiratoire_min: nonNegatif(resp?.lowestRespirationValue),
    fr_respiratoire_max: nonNegatif(resp?.highestRespirationValue),
    pas: raw?.totalSteps ?? null,
    calories_totales: raw?.totalKilocalories ?? null,
    calories_actives: raw?.activeKilocalories ?? null,
  };
}

async function fetchTrainingLoad(client: GarminConnect, date: string) {
  const [statusRaw, maxmetRaw] = await Promise.all([
    (client as any)
      .get(
        `https://connectapi.garmin.com/metrics-service/metrics/trainingstatus/aggregated/${date}`
      )
      .catch(() => null),
    (client as any)
      .get(
        `https://connectapi.garmin.com/metrics-service/metrics/maxmet/latest/${date}`
      )
      .catch(() => null),
  ]);

  let statut: string | null = null;
  let charge: any = null;
  const tsd = statusRaw?.mostRecentTrainingStatus?.latestTrainingStatusData;
  if (tsd && typeof tsd === "object") {
    const first: any = Object.values(tsd)[0];
    statut =
      first?.trainingStatusFeedbackPhrase ?? first?.trainingStatus ?? null;
    const dto = first?.acuteTrainingLoadDTO;
    if (dto) {
      charge = {
        charge_aigue_7j: dto?.dailyTrainingLoadAcute ?? null,
        charge_chronique_28j: dto?.dailyTrainingLoadChronic ?? null,
        ratio_aigu_chronique: dto?.dailyAcuteChronicWorkloadRatio ?? null,
        statut_ratio: dto?.acwrStatus ?? null,
        plage_optimale:
          dto?.minTrainingLoadChronic != null &&
          dto?.maxTrainingLoadChronic != null
            ? `${Math.round(dto.minTrainingLoadChronic)}-${Math.round(dto.maxTrainingLoadChronic)}`
            : null,
      };
    }
  }

  const mm = Array.isArray(maxmetRaw)
    ? maxmetRaw[maxmetRaw.length - 1]
    : maxmetRaw;
  const vo2Course =
    mm?.generic?.vo2MaxPreciseValue ?? mm?.generic?.vo2MaxValue ?? null;
  const vo2Velo =
    mm?.cycling?.vo2MaxPreciseValue ?? mm?.cycling?.vo2MaxValue ?? null;

  return {
    date,
    statut_entrainement: statut,
    charge: charge,
    vo2max_course: vo2Course,
    vo2max_velo: vo2Velo,
  };
}

async function fetchReadiness(client: GarminConnect, date: string) {
  const raw: any = await (client as any).get(
    `https://connectapi.garmin.com/metrics-service/metrics/trainingreadiness/${date}`
  );
  const r = Array.isArray(raw) ? raw[0] : raw;
  return {
    date,
    score: r?.score ?? null,
    niveau: r?.level ?? null,
    message: r?.feedbackShort ?? null,
    temps_recuperation_h:
      r?.recoveryTime != null
        ? Math.round((r.recoveryTime / 60) * 10) / 10
        : null,
    score_sommeil: r?.sleepScore ?? null,
    facteur_vfc_pct: r?.hrvFactorPercent ?? null,
    facteur_sommeil_pct: r?.sleepScoreFactorPercent ?? null,
    facteur_recuperation_pct: r?.recoveryTimeFactorPercent ?? null,
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
          "Récupère le détail du sommeil pour une date donnée (score, durée totale, phases profond/léger/paradoxal, éveil). Par défaut : la nuit dernière (= date du jour, Garmin indexant une nuit par sa date de réveil).",
        inputSchema: {
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("Date au format YYYY-MM-DD (défaut : aujourd'hui, Garmin indexant une nuit par la date du réveil)"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ date }) => {
        try {
          const client = await getGarminClient();
          return asText(await fetchSleep(client, date ?? dateParis()));
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
          "Récupère la variabilité de la fréquence cardiaque (VFC/HRV) nocturne pour une date donnée : moyenne, pic 5 min, moyenne 7 jours, statut. Par défaut : la nuit dernière (= date du jour, Garmin indexant une nuit par sa date de réveil).",
        inputSchema: {
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("Date au format YYYY-MM-DD (défaut : aujourd'hui, Garmin indexant une nuit par la date du réveil)"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ date }) => {
        try {
          const client = await getGarminClient();
          return asText(await fetchHrv(client, date ?? dateParis()));
        } catch (e) {
          return asError(e, "la récupération de la VFC");
        }
      }
    );

    server.registerTool(
      "poids_recent",
      {
        title: "Dernière pesée",
        description:
          "Récupère la dernière pesée enregistrée (poids en kg, IMC, masse grasse et masse musculaire si disponibles) à une date donnée ou avant. Par défaut : aujourd'hui.",
        inputSchema: {
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("Date au format YYYY-MM-DD (défaut : aujourd'hui)"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ date }) => {
        try {
          const client = await getGarminClient();
          return asText(
            await fetchWeight(client, date ?? dateParis())
          );
        } catch (e) {
          return asError(e, "la récupération du poids");
        }
      }
    );

    server.registerTool(
      "activites_recentes",
      {
        title: "Activités récentes",
        description:
          "Liste les dernières activités enregistrées (course, natation, etc.) avec date, type, durée, distance, calories dépensées et fréquence cardiaque moyenne. Utile pour ajuster la prise alimentaire.",
        inputSchema: {
          nombre: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe("Nombre d'activités à retourner (défaut : 5, max : 20)"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ nombre }) => {
        try {
          const client = await getGarminClient();
          return asText({
            activites: await fetchActivities(client, nombre ?? 5),
          });
        } catch (e) {
          return asError(e, "la récupération des activités");
        }
      }
    );

    server.registerTool(
      "sante_jour",
      {
        title: "Santé du jour",
        description:
          "Résumé santé d'une journée : body battery (haut, bas, actuel), fréquence cardiaque de repos, stress moyen et max, temps passé en repos / stress / actif (états Garmin dérivés de la VFC), fréquence respiratoire (éveil, sommeil, min, max), pas, calories totales et actives. Par défaut : aujourd'hui.",
        inputSchema: {
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("Date au format YYYY-MM-DD (défaut : aujourd'hui)"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ date }) => {
        try {
          const client = await getGarminClient();
          return asText(
            await fetchDailySummary(client, date ?? dateParis())
          );
        } catch (e) {
          return asError(e, "la récupération du résumé santé du jour");
        }
      }
    );

    server.registerTool(
      "charge_entrainement",
      {
        title: "Charge d'entraînement et VO2 max",
        description:
          "Statut d'entraînement Garmin (productif, maintien, etc.), charge aiguë 7 jours, charge chronique 28 jours, ratio aigu/chronique avec plage optimale, et VO2 max course et vélo. Par défaut : aujourd'hui.",
        inputSchema: {
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("Date au format YYYY-MM-DD (défaut : aujourd'hui)"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ date }) => {
        try {
          const client = await getGarminClient();
          return asText(
            await fetchTrainingLoad(client, date ?? dateParis())
          );
        } catch (e) {
          return asError(e, "la récupération de la charge d'entraînement");
        }
      }
    );

    server.registerTool(
      "training_readiness",
      {
        title: "Training readiness",
        description:
          "Score de préparation à l'entraînement Garmin (0-100) avec niveau, message, temps de récupération restant et facteurs contributifs (VFC, sommeil, récupération). Par défaut : aujourd'hui.",
        inputSchema: {
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("Date au format YYYY-MM-DD (défaut : aujourd'hui)"),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ date }) => {
        try {
          const client = await getGarminClient();
          return asText(
            await fetchReadiness(client, date ?? dateParis())
          );
        } catch (e) {
          return asError(e, "la récupération du training readiness");
        }
      }
    );

    server.registerTool(
      "resume_hebdo",
      {
        title: "Résumé 7 jours sommeil + VFC",
        description:
          "Synthèse des 7 derniers jours (aujourd'hui inclus, fuseau Europe/Paris) : score et durée de sommeil + VFC nocturne, jour par jour. Utile pour analyser tendance et récupération.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async () => {
        try {
          const client = await getGarminClient();
          const jours: any[] = [];
          for (let i = 6; i >= 0; i--) {
            const date = dateParis(-i);
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
// Protection de l'endpoint : clé secrète dans le chemin (/api/mcp/<secret>).
// Le paramètre ?key=... reste accepté en secours. Refus en 404 (et non 401)
// pour ne pas déclencher le flux d'enregistrement OAuth de claude.ai.
// ---------------------------------------------------------------------------
function withAuth(h: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    const secret = process.env.MCP_SECRET;
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean); // ["api","mcp","<secret>"]
    const provided = segments[2] ?? url.searchParams.get("key");
    if (!secret || provided !== secret) {
      return new Response("Not found", { status: 404 });
    }
    return h(req);
  };
}

export const GET = withAuth(handler);
export const POST = withAuth(handler);
export const DELETE = withAuth(handler);
