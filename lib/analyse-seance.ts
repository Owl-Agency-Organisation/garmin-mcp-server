// ---------------------------------------------------------------------------
// analyse_seance — téléchargement du FIT original d'une activité Garmin,
// décodage côté serveur (SDK FIT officiel) et calcul d'un JSON compact.
//
// Module séparé de la route : Next.js interdit d'exporter autre chose que les
// handlers depuis route.ts, et ce code doit pouvoir être testé hors Next.
// Traitement 100 % en mémoire : le FIT n'est jamais écrit sur disque.
// Aucune position GPS n'est lue ni renvoyée.
// ---------------------------------------------------------------------------
import { Decoder, Stream } from "@garmin/fitsdk";
import { unzipSync } from "fflate";
import type { GarminConnect } from "garmin-connect";

const GC_API = "https://connectapi.garmin.com";

type Msg = Record<string, any>;
type N = number | null;

// Sensations Garmin : auto-évaluation post-activité stockée 0-100 par pas de 25.
export const SENSATIONS: Record<number, string> = {
  0: "très mauvaises",
  25: "mauvaises",
  50: "neutres",
  75: "bonnes",
  100: "très bonnes",
};

// ---------------------------------------------------------------------------
// Téléchargement et décodage
// ---------------------------------------------------------------------------
export async function telechargerFit(
  client: GarminConnect,
  activityId: string
): Promise<Uint8Array> {
  // Service du bouton « Exporter l'original » : zip contenant le .fit.
  // garmin-connect expose downloadOriginalActivityData, mais il écrit sur
  // disque : appel direct en arraybuffer pour rester en mémoire.
  const data: any = await (client as any).get(
    `${GC_API}/download-service/files/activity/${activityId}`,
    { responseType: "arraybuffer" }
  );
  return extraireFit(new Uint8Array(data));
}

export function extraireFit(octets: Uint8Array): Uint8Array {
  if (octets[0] === 0x50 && octets[1] === 0x4b) {
    const fichiers = unzipSync(octets, {
      filter: (f) => f.name.toLowerCase().endsWith(".fit"),
    });
    const nom = Object.keys(fichiers).sort()[0];
    if (!nom) throw new Error("aucun fichier .fit dans l'archive Garmin");
    return fichiers[nom];
  }
  return octets; // déjà un FIT brut
}

function decoderFit(fit: Uint8Array): Record<string, Msg[]> {
  const decoder = new Decoder(Stream.fromByteArray(fit));
  if (!decoder.isFIT()) throw new Error("fichier non reconnu comme FIT");
  const { messages, errors } = decoder.read({
    includeUnknownData: true, // champs non documentés lus par numéro
    applyScaleAndOffset: true,
    expandComponents: true,
    expandSubFields: true,
    convertTypesToStrings: true,
    convertDateTimesToDates: true,
    mergeHeartRates: true,
  });
  const m = messages as unknown as Record<string, Msg[]>;
  if (!m?.recordMesgs?.length && !m?.sessionMesgs?.length && errors?.length) {
    throw new Error(`décodage FIT impossible : ${errors[0]?.message ?? errors[0]}`);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Helpers numériques
// ---------------------------------------------------------------------------
function num(v: unknown): N {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function arr(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}
function rnd(v: N, d = 0): N {
  if (v == null || !Number.isFinite(v)) return null;
  const k = 10 ** d;
  return Math.round(v * k) / k;
}
function moy(xs: N[]): N {
  let s = 0;
  let n = 0;
  for (const x of xs) {
    if (x != null) {
      s += x;
      n++;
    }
  }
  return n ? s / n : null;
}
function ecartType(xs: number[]): N {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}
function mediane(xs: number[]): N {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}
function pct(a: number, b: number): N {
  return b > 0 ? rnd((100 * a) / b, 1) : null;
}
function hms(s: N): string | null {
  if (s == null) return null;
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
function allure(secParKm: N): string | null {
  if (secParKm == null || !Number.isFinite(secParKm) || secParKm <= 0) return null;
  const t = Math.round(secParKm);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}
function regression(xs: number[], ys: number[]) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const pente = sxy / sxx;
  return {
    pente,
    origine: my - pente * mx,
    r: syy > 0 ? sxy / Math.sqrt(sxx * syy) : null,
  };
}

// Champ SDK par nom, repli sur le numéro brut (échelle appliquée à la main :
// le SDK ne met pas à l'échelle les champs qu'il ne connaît pas).
function champ(m: Msg | undefined, nom: string, numero?: number, echelle = 1): N {
  if (!m) return null;
  const v = num(m[nom]);
  if (v != null) return v;
  if (numero == null) return null;
  const brut = num(m[numero]);
  return brut != null ? brut / echelle : null;
}
function champTableau(m: Msg | undefined, nom: string, numero?: number, echelle = 1): N[] | null {
  if (!m) return null;
  const a = arr(m[nom]);
  if (a) return a.map((x) => num(x));
  const b = numero != null ? arr(m[numero]) : null;
  return b ? b.map((x) => (num(x) != null ? (x as number) / echelle : null)) : null;
}
function texte(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return null;
}

// Part droite (%) d'un champ left_right_balance. Bit « droite » : 0x80 sur
// 8 bits (record), 0x8000 sur 16 bits avec valeur ×100 (session, tour).
// Si le bit est absent, la valeur désigne la jambe gauche.
function partDroite8(v: unknown): N {
  if (typeof v !== "number") return null;
  const val = v & 0x7f;
  if (val > 100) return null;
  return v & 0x80 ? val : 100 - val;
}
function partDroite16(v: unknown): N {
  if (typeof v !== "number") return null;
  const val = (v & 0x3fff) / 100;
  if (val > 100) return null;
  return v & 0x8000 ? val : 100 - val;
}

// ---------------------------------------------------------------------------
// Série à 1 Hz
// ---------------------------------------------------------------------------
interface Seconde {
  t: number; // secondes écoulées depuis le premier record
  p: N; // puissance (W)
  c: N; // cadence (rpm, ou pas/min pour une jambe en course)
  cf: N; // cadence fractionnaire
  fc: N;
  bal: N; // part droite (%)
  teG: N;
  teD: N;
  psG: N;
  psD: N;
  pcoG: N;
  pcoD: N;
  fr: N; // fréquence respiratoire
  fcPoignet: N;
  fcCeinture: N;
  bb: N; // body battery
  alt: N;
  dist: N;
  v: N; // vitesse m/s
  dev: Record<string, number> | null;
}

// Au-delà de cet écart entre deux records, on considère une pause (non comblée).
const REMPLISSAGE_MAX_S = 5;

function construireSerie(records: Msg[], devNoms: Record<string, string>) {
  const recs = records
    .filter((r) => r?.timestamp instanceof Date)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const serie: Seconde[] = [];
  const pas: number[] = [];
  if (!recs.length) return { serie, pasMedian: null as N };
  const t0 = recs[0].timestamp.getTime() / 1000;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const ts = r.timestamp.getTime() / 1000;
    const suivant = recs[i + 1]?.timestamp?.getTime();
    const dt = suivant != null ? suivant / 1000 - ts : 1;
    if (dt > 0) pas.push(dt);
    if (dt <= 0) continue; // doublon d'horodatage : on garde le suivant
    let dev: Record<string, number> | null = null;
    if (r.developerFields && typeof r.developerFields === "object") {
      for (const [k, v] of Object.entries(r.developerFields)) {
        const x = num(v);
        if (x != null) {
          dev ??= {};
          dev[devNoms[k] ?? k] = x;
        }
      }
    }
    const s: Omit<Seconde, "t"> = {
      p: num(r.power),
      c: num(r.cadence),
      cf: num(r.fractionalCadence),
      fc: num(r.heartRate),
      bal: partDroite8(r.leftRightBalance ?? r[30]),
      teG: champ(r, "leftTorqueEffectiveness", 43, 2),
      teD: champ(r, "rightTorqueEffectiveness", 44, 2),
      psG: champ(r, "leftPedalSmoothness", 45, 2),
      psD: champ(r, "rightPedalSmoothness", 46, 2),
      pcoG: champ(r, "leftPco", 67),
      pcoD: champ(r, "rightPco", 68),
      fr: champ(r, "enhancedRespirationRate", 108, 100),
      fcPoignet: nonNul(num(r[136])),
      fcCeinture: nonNul(num(r[144])),
      bb: num(r[143]),
      alt: num(r.enhancedAltitude ?? r.altitude),
      dist: num(r.distance),
      v: num(r.enhancedSpeed ?? r.speed),
      dev,
    };
    const rep = dt <= REMPLISSAGE_MAX_S ? Math.max(1, Math.round(dt)) : 1;
    for (let k = 0; k < rep; k++) serie.push({ ...s, t: Math.round(ts - t0) + k });
  }
  return { serie, pasMedian: mediane(pas) };
}
function nonNul(v: N): N {
  return v != null && v > 0 ? v : null;
}

// NP : puissance 1 Hz zéros inclus, moyenne glissante 30 s, puissance 4,
// moyenne, racine quatrième.
function puissanceNormalisee(p: N[]): N {
  if (p.length < 30) return null;
  let somme = 0;
  let acc = 0;
  let n = 0;
  for (let i = 0; i < p.length; i++) {
    somme += p[i] ?? 0;
    if (i >= 30) somme -= p[i - 30] ?? 0;
    if (i >= 29) {
      acc += (somme / 30) ** 4;
      n++;
    }
  }
  return n ? (acc / n) ** 0.25 : null;
}

const pedale = (s: Seconde) => (s.p ?? 0) > 0 && (s.c ?? 0) > 0;
const couple = (s: Seconde) =>
  s.p != null && s.c ? s.p / ((2 * Math.PI * s.c) / 60) : null;

// ---------------------------------------------------------------------------
// Blocs de sortie
// ---------------------------------------------------------------------------
function blocMeta(
  m: Record<string, Msg[]>,
  session: Msg,
  serie: Seconde[],
  pasMedian: N,
  debutLocal: string | null
) {
  const fileId = m.fileIdMesgs?.[0] ?? {};
  const infos = m.deviceInfoMesgs ?? [];
  const createur =
    [...infos].reverse().find((d) => d?.deviceIndex === "creator" || d?.deviceIndex === 0) ??
    {};

  // Capteurs externes : dernier message par index (état batterie de fin).
  const parIndex = new Map<string, Msg>();
  for (const d of infos) {
    const src = texte(d?.sourceType);
    if (!src || src === "local") continue;
    if (d?.deviceIndex === "creator" || d?.deviceIndex === 0) continue;
    parIndex.set(String(d?.deviceIndex ?? parIndex.size), d);
  }
  const capteurs = [...parIndex.values()].map((d) => ({
    type:
      texte(d?.antplusDeviceType) ??
      texte(d?.bleDeviceType) ??
      texte(d?.antDeviceType) ??
      texte(d?.localDeviceType) ??
      texte(d?.deviceType),
    fabricant: texte(d?.manufacturer),
    produit:
      texte(d?.productName) ?? texte(d?.faveroProduct) ?? texte(d?.garminProduct) ?? texte(d?.product),
    protocole: texte(d?.sourceType),
    logiciel: num(d?.softwareVersion),
    batterie: texte(d?.batteryStatus),
    batterie_pct: num(d?.batteryLevel),
  }));

  const zt = m.zonesTargetMesgs?.[0];
  const up = m.userProfileMesgs?.[0];
  const tiz = (m.timeInZoneMesgs ?? []).find((z) => z?.referenceMesg === "session");

  const debut: Date | null = session?.startTime instanceof Date ? session.startTime : null;
  const n = serie.length;
  return {
    sport: texte(session?.sport),
    sous_sport: texte(session?.subSport),
    profil: texte(session?.sportProfileName),
    debut:
      debutLocal ??
      (debut
        ? new Intl.DateTimeFormat("sv-SE", {
            timeZone: "Europe/Paris",
            dateStyle: "short",
            timeStyle: "short",
          }).format(debut)
        : null),
    duree_timer: hms(num(session?.totalTimerTime)),
    duree_totale: hms(num(session?.totalElapsedTime)),
    duree_timer_s: rnd(num(session?.totalTimerTime)),
    appareil: {
      fabricant: texte(fileId?.manufacturer),
      produit:
        texte(fileId?.productName) ?? texte(fileId?.garminProduct) ?? texte(fileId?.product),
      logiciel: num(createur?.softwareVersion),
    },
    capteurs,
    reglages: {
      ftp: num(zt?.functionalThresholdPower) ?? num(tiz?.functionalThresholdPower) ?? num(session?.thresholdPower),
      fc_max: num(zt?.maxHeartRate) ?? num(tiz?.maxHeartRate),
      fc_seuil: num(zt?.thresholdHeartRate) ?? num(tiz?.thresholdHeartRate),
      fc_repos: num(tiz?.restingHeartRate) ?? num(up?.restingHeartRate),
      poids_kg: rnd(num(up?.weight), 1),
    },
    qualite: {
      echantillonnage_s: pasMedian,
      secondes: n,
      sans_puissance_pct: pct(serie.filter((s) => s.p == null).length, n),
      sans_cadence_pct: pct(serie.filter((s) => s.c == null).length, n),
      np_recalculee: rnd(puissanceNormalisee(serie.map((s) => s.p))),
    },
  };
}

function blocNatif(session: Msg, serie: Seconde[], meilleure20: N) {
  const km = (v: N) => (v != null ? rnd(v * 3.6, 1) : null);
  const phases = (nom: string, numero: number) => {
    const a = champTableau(session, nom, numero, 0.7111111);
    if (!a || a.every((x) => x == null)) return null;
    return { debut: rnd(a[0]), fin: rnd(a[1]), arc: rnd(a[2]), centre: rnd(a[3]) };
  };
  const eq = partDroite16(session?.leftRightBalance ?? session?.[37]);
  const pcoConstantZero = !serie.some(
    (s) => (s.pcoG != null && s.pcoG !== 0) || (s.pcoD != null && s.pcoD !== 0)
  );
  const pco = (nom: string, numero: number) => {
    const v = champ(session, nom, numero);
    return v == null || (v === 0 && pcoConstantZero) ? null : v;
  };
  const posP = champTableau(session, "avgPowerPosition", 120);
  const posPmax = champTableau(session, "maxPowerPosition", 121);
  const posC = champTableau(session, "avgCadencePosition", 122);
  const posCmax = champTableau(session, "maxCadencePosition", 123);
  const danseuse = champ(session, "timeStanding", 112, 1000);
  const timer = num(session?.totalTimerTime);
  const calTotal = num(session?.totalCalories);
  const calRepos = champ(session, "metabolicCalories", 196);
  const feel = champ(session, "workoutFeel", 192);
  const rpe = champ(session, "workoutRpe", 193);
  const bbs = serie.map((s) => s.bb).filter((x): x is number => x != null);
  const alts = serie.map((s) => s.alt).filter((x): x is number => x != null);

  return {
    distance_km: rnd(num(session?.totalDistance) != null ? session.totalDistance / 1000 : null, 2),
    d_plus_m: num(session?.totalAscent),
    d_moins_m: num(session?.totalDescent),
    // Souvent absentes de la session : repli sur les records.
    altitude_min_m: rnd(
      num(session?.enhancedMinAltitude ?? session?.minAltitude) ??
        (alts.length ? Math.min(...alts) : null)
    ),
    altitude_max_m: rnd(
      num(session?.enhancedMaxAltitude ?? session?.maxAltitude) ??
        (alts.length ? Math.max(...alts) : null)
    ),
    vitesse_moy_kmh: km(num(session?.enhancedAvgSpeed ?? session?.avgSpeed)),
    vitesse_max_kmh: km(num(session?.enhancedMaxSpeed ?? session?.maxSpeed)),
    fc_moy: num(session?.avgHeartRate),
    fc_max: num(session?.maxHeartRate),
    cadence_moy: num(session?.avgCadence),
    cadence_max: num(session?.maxCadence),
    puissance_moy: num(session?.avgPower),
    puissance_max: num(session?.maxPower),
    np: champ(session, "normalizedPower", 34),
    if: rnd(champ(session, "intensityFactor", 36, 1000), 3),
    tss: rnd(champ(session, "trainingStressScore", 35, 10), 1),
    travail_kj: rnd((champ(session, "totalWork", 48) ?? NaN) / 1000, 1),
    meilleure_20min_w: meilleure20,
    equilibre: eq != null ? { gauche: rnd(100 - eq, 1), droite: rnd(eq, 1) } : null,
    efficacite_couple: {
      gauche: rnd(champ(session, "avgLeftTorqueEffectiveness", 101, 2), 1),
      droite: rnd(champ(session, "avgRightTorqueEffectiveness", 102, 2), 1),
    },
    fluidite: {
      gauche: rnd(champ(session, "avgLeftPedalSmoothness", 103, 2), 1),
      droite: rnd(champ(session, "avgRightPedalSmoothness", 104, 2), 1),
    },
    pco_mm: { gauche: pco("avgLeftPco", 114), droite: pco("avgRightPco", 115) },
    phase_puissance: {
      gauche: phases("avgLeftPowerPhase", 116),
      gauche_pic: phases("avgLeftPowerPhasePeak", 117),
      droite: phases("avgRightPowerPhase", 118),
      droite_pic: phases("avgRightPowerPhasePeak", 119),
    },
    position: {
      assis_s: timer != null && danseuse != null ? rnd(timer - danseuse) : null,
      danseuse_s: rnd(danseuse),
      passages_danseuse: champ(session, "standCount", 113),
      puissance_moy_assis: posP?.[0] ?? null,
      puissance_moy_danseuse: posP?.[1] ?? null,
      puissance_max_assis: posPmax?.[0] ?? null,
      puissance_max_danseuse: posPmax?.[1] ?? null,
      cadence_moy_assis: posC?.[0] ?? null,
      cadence_moy_danseuse: posC?.[1] ?? null,
      cadence_max_assis: posCmax?.[0] ?? null,
      cadence_max_danseuse: posCmax?.[1] ?? null,
    },
    calories: {
      total: calTotal,
      repos: calRepos,
      actives: calTotal != null && calRepos != null ? calTotal - calRepos : null,
    },
    transpiration_ml: num(session?.[178]),
    effet_aerobie: rnd(num(session?.totalTrainingEffect), 1),
    effet_anaerobie: rnd(num(session?.totalAnaerobicTrainingEffect), 1),
    charge: rnd(champ(session, "trainingLoadPeak", 168, 65536), 1),
    freq_respiratoire: {
      moy: rnd(champ(session, "enhancedAvgRespirationRate", 169, 100), 1),
      min: rnd(champ(session, "enhancedMinRespirationRate", 180, 100), 1),
      max: rnd(champ(session, "enhancedMaxRespirationRate", 170, 100), 1),
    },
    rpe: rpe != null ? rnd(rpe / 10, 1) : null,
    sensations: feel != null ? (SENSATIONS[feel] ?? String(feel)) : null,
    tours_pedale: num(session?.totalCycles),
    impact_body_battery: bbs.length >= 2 ? bbs[bbs.length - 1] - bbs[0] : null,
  };
}

function blocZones(m: Record<string, Msg[]>, session: Msg) {
  const tiz = (m.timeInZoneMesgs ?? []).find((z) => z?.referenceMesg === "session");
  const zones = (temps: N[] | null, bornes: N[] | null) => {
    if (!temps || temps.every((x) => x == null)) return null;
    const total = temps.reduce<number>((a, b) => a + (b ?? 0), 0);
    return temps.map((t, i) => ({
      zone: i,
      de: i === 0 ? 0 : (bornes?.[i - 1] ?? null),
      a: bornes?.[i] ?? null,
      temps_s: rnd(t),
      pct: t != null ? pct(t, total) : null,
    }));
  };
  return {
    puissance: zones(
      champTableau(tiz, "timeInPowerZone") ?? champTableau(session, "timeInPowerZone"),
      champTableau(tiz, "powerZoneHighBoundary")
    ),
    fc: zones(
      champTableau(tiz, "timeInHrZone") ?? champTableau(session, "timeInHrZone"),
      champTableau(tiz, "hrZoneHighBoundary")
    ),
  };
}

const DUREES_COURBE: [string, number][] = [
  ["5s", 5],
  ["15s", 15],
  ["30s", 30],
  ["1min", 60],
  ["2min", 120],
  ["3min", 180],
  ["5min", 300],
  ["10min", 600],
  ["20min", 1200],
  ["30min", 1800],
  ["60min", 3600],
];

function blocCourbe(serie: Seconde[]) {
  const n = serie.length;
  const cumul = (f: (s: Seconde) => N, filtre?: (s: Seconde) => boolean) => {
    const somme = new Float64Array(n + 1);
    const compte = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const v = f(serie[i]);
      const ok = v != null && (!filtre || filtre(serie[i]));
      somme[i + 1] = somme[i] + (ok ? (v as number) : 0);
      compte[i + 1] = compte[i] + (ok ? 1 : 0);
    }
    return (a: number, b: number) => {
      const c = compte[b] - compte[a];
      return c > 0 ? (somme[b] - somme[a]) / c : null;
    };
  };
  const cumP = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cumP[i + 1] = cumP[i] + (serie[i].p ?? 0);
  const fcMoy = cumul((s) => s.fc);
  const cadMoy = cumul((s) => s.c, (s) => (s.c ?? 0) > 0);
  const courbe: Record<string, { w: N; fc: N; cadence: N }> = {};
  for (const [cle, d] of DUREES_COURBE) {
    if (d > n) continue;
    let best = -1;
    let ib = 0;
    for (let i = 0; i + d <= n; i++) {
      const s = cumP[i + d] - cumP[i];
      if (s > best) {
        best = s;
        ib = i;
      }
    }
    courbe[cle] = {
      w: rnd(best / d),
      fc: rnd(fcMoy(ib, ib + d)),
      cadence: rnd(cadMoy(ib, ib + d)),
    };
  }
  return courbe;
}

const TRANCHES_PUISSANCE: [string, number, number][] = [
  ["<100", 0, 100],
  ["100-150", 100, 150],
  ["150-200", 150, 200],
  ["200-250", 200, 250],
  ["250-300", 250, 300],
  [">300", 300, Infinity],
];
const TRANCHES_CADENCE: [string, number, number][] = [
  ["<60", 0, 60],
  ["60-70", 60, 70],
  ["70-80", 70, 80],
  ["80-90", 80, 90],
  ["90-100", 90, 100],
  [">100", 100, Infinity],
];

function statsPedalage(ss: Seconde[]) {
  return {
    secondes: ss.length,
    puissance: rnd(moy(ss.map((s) => s.p))),
    cadence: rnd(moy(ss.map((s) => s.c))),
    part_droite: rnd(moy(ss.map((s) => s.bal)), 1),
    te_g: rnd(moy(ss.map((s) => s.teG)), 1),
    te_d: rnd(moy(ss.map((s) => s.teD)), 1),
    fc: rnd(moy(ss.map((s) => s.fc))),
  };
}

function blocPedalage(serie: Seconde[]) {
  const ped = serie.filter(pedale);
  const parPuissance = TRANCHES_PUISSANCE.map(([nom, a, b]) => {
    const ss = ped.filter((s) => (s.p as number) >= a && (s.p as number) < b);
    return {
      tranche_w: nom,
      secondes: ss.length,
      cadence: rnd(moy(ss.map((s) => s.c))),
      couple_nm: rnd(moy(ss.map(couple)), 1),
      part_droite: rnd(moy(ss.map((s) => s.bal)), 1),
      te_g: rnd(moy(ss.map((s) => s.teG)), 1),
      te_d: rnd(moy(ss.map((s) => s.teD)), 1),
      ps_g: rnd(moy(ss.map((s) => s.psG)), 1),
      ps_d: rnd(moy(ss.map((s) => s.psD)), 1),
      fc: rnd(moy(ss.map((s) => s.fc))),
      fr: rnd(moy(ss.map((s) => s.fr)), 1),
    };
  });
  const parCadence = TRANCHES_CADENCE.map(([nom, a, b]) => {
    const k = ped.filter((s) => (s.c as number) >= a && (s.c as number) < b).length;
    return { tranche_rpm: nom, secondes: k, pct: pct(k, ped.length) };
  });
  return {
    secondes_pedalees: ped.length,
    par_puissance: parPuissance,
    par_cadence: parCadence,
  };
}

function blocSymetrie(serie: Seconde[], laps: Msg[], ftp: N) {
  const n = serie.length;
  const dansCible = (s: Seconde) =>
    ftp != null && pedale(s) && (s.p as number) >= 0.74 * ftp && (s.p as number) <= 1.08 * ftp;
  const quarts = [0, 1, 2, 3].map((q) => {
    const ss = serie.slice(Math.floor((q * n) / 4), Math.floor(((q + 1) * n) / 4)).filter(dansCible);
    return { quart: q + 1, ...statsPedalage(ss) };
  });
  const moitie1 = statsPedalage(serie.slice(0, Math.floor(n / 2)).filter(dansCible));
  const q4 = quarts[3]?.part_droite ?? null;
  return {
    plage_w: ftp != null ? [Math.round(0.74 * ftp), Math.round(1.08 * ftp)] : null,
    quarts,
    part_droite_premiere_moitie: moitie1.part_droite,
    ecart_q4_vs_moitie1: q4 != null && moitie1.part_droite != null ? rnd(q4 - moitie1.part_droite, 1) : null,
    tours: laps.map((l, i) => ({
      tour: i + 1,
      duree_s: rnd(num(l?.totalTimerTime)),
      puissance: num(l?.avgPower),
      part_droite: rnd(partDroite16(l?.leftRightBalance ?? l?.[34]), 1),
    })),
  };
}

// ---------------------------------------------------------------------------
// Cardio : RR, DFA-alpha1, découplement
// ---------------------------------------------------------------------------
const FENETRE_S = 120;
const PAS_FENETRE_S = 30;

function extraireRR(hrv: Msg[]): number[] {
  const rr: number[] = [];
  for (const m of hrv) {
    const t = arr(m?.time) ?? arr(m?.[0]) ?? (num(m?.time) != null ? [m.time] : []);
    for (const x of t) {
      const v = num(x);
      // Valeur invalide FIT (0xFFFF → 65,535 s) ou nulle : ignorée.
      if (v == null || v <= 0 || v >= 65.5) continue;
      rr.push(Math.round(v * 1000));
    }
  }
  return rr;
}

function marquerArtefacts(rr: number[]): boolean[] {
  const art: boolean[] = new Array(rr.length);
  const demi = 5; // médiane glissante centrée sur 11 battements
  for (let i = 0; i < rr.length; i++) {
    const v = rr[i];
    if (v < 300 || v > 2000) {
      art[i] = true;
      continue;
    }
    const med = mediane(rr.slice(Math.max(0, i - demi), Math.min(rr.length, i + demi + 1))) as number;
    art[i] = Math.abs(v - med) > 0.2 * med;
  }
  return art;
}

export function dfaAlpha1(rr: number[]): N {
  const n = rr.length;
  if (n < 32) return null;
  const m = rr.reduce((a, b) => a + b, 0) / n;
  const y = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += rr[i] - m;
    y[i] = acc;
  }
  const lx: number[] = [];
  const ly: number[] = [];
  for (let s = 4; s <= 16; s++) {
    const boites = Math.floor(n / s);
    if (boites < 1) continue;
    // Abscisses 0..s-1 : moyenne et variance constantes par taille de boîte.
    const mx = (s - 1) / 2;
    let sxx = 0;
    for (let k = 0; k < s; k++) sxx += (k - mx) ** 2;
    let sse = 0;
    for (let b = 0; b < boites; b++) {
      const o = b * s;
      let my = 0;
      for (let k = 0; k < s; k++) my += y[o + k];
      my /= s;
      let sxy = 0;
      for (let k = 0; k < s; k++) sxy += (k - mx) * (y[o + k] - my);
      const pente = sxy / sxx;
      for (let k = 0; k < s; k++) {
        const res = y[o + k] - (my + pente * (k - mx));
        sse += res * res;
      }
    }
    const F = Math.sqrt(sse / (boites * s));
    if (F > 0) {
      lx.push(Math.log(s));
      ly.push(Math.log(F));
    }
  }
  const reg = regression(lx, ly);
  return reg ? reg.pente : null;
}

const TRANCHES_FC: [number, number][] = [
  [100, 120],
  [120, 126],
  [126, 130],
  [130, 134],
  [134, 137],
  [137, 140],
  [140, 145],
];
function trancheFc(fc: number): string | null {
  if (fc < 100) return "<100";
  for (const [a, b] of TRANCHES_FC) if (fc >= a && fc < b) return `${a}-${b}`;
  const a = 145 + 5 * Math.floor((fc - 145) / 5);
  return `${a}-${a + 5}`;
}
function ordreTranche(nom: string): number {
  return nom.startsWith("<") ? -1 : parseInt(nom, 10);
}

const R_MIN = 0.3;

interface Fenetre {
  fc: number;
  a1: number;
  p: N;
  cv: N;
}

function seuils(fenetres: Fenetre[]) {
  const f = fenetres.filter((w) => w.fc > 110);
  const regFc = regression(
    f.map((w) => w.fc),
    f.map((w) => w.a1)
  );
  const fp = f.filter((w) => w.p != null);
  const regP = regression(
    fp.map((w) => w.p as number),
    fp.map((w) => w.a1)
  );
  // Seuil résolu seulement si la relation est décroissante et non négligeable.
  const resoudre = (reg: ReturnType<typeof regression>, a1: number) =>
    reg && reg.pente < 0 && reg.r != null && reg.r <= -R_MIN
      ? (a1 - reg.origine) / reg.pente
      : null;
  return {
    fenetres: f.length,
    // Seuils arrondis au bpm (décision Phil) : la FC étant entière, une seconde
    // à 135 bpm est « au seuil » et non « sous le seuil » de 135.
    fc_a1_075: rnd(resoudre(regFc, 0.75)),
    fc_a1_050: rnd(resoudre(regFc, 0.5)),
    r_fc: rnd(regFc?.r ?? null, 2),
    puissance_a1_075: rnd(resoudre(regP, 0.75)),
    puissance_a1_050: rnd(resoudre(regP, 0.5)),
    r_puissance: rnd(regP?.r ?? null, 2),
  };
}

function blocCardio(hrv: Msg[], serie: Seconde[]) {
  const n = serie.length;
  const moitie = Math.floor(n / 2);
  const ratio = (ss: Seconde[]) => {
    const np = puissanceNormalisee(ss.map((s) => s.p));
    const fc = moy(ss.map((s) => s.fc));
    return np != null && fc ? np / fc : null;
  };
  const r1 = ratio(serie.slice(0, moitie));
  const r2 = ratio(serie.slice(moitie));

  // Écart FC poignet / ceinture (records 136 / 144).
  let ecartMax: N = null;
  const ecarts: number[] = [];
  for (const s of serie) {
    if (s.fcPoignet != null && s.fcCeinture != null) {
      const e = Math.abs(s.fcPoignet - s.fcCeinture);
      ecarts.push(e);
      if (ecartMax == null || e > ecartMax) ecartMax = e;
    }
  }

  const frParFc = new Map<string, Seconde[]>();
  for (const s of serie) {
    if (s.fc == null || s.fr == null) continue;
    const k = trancheFc(s.fc) as string;
    if (!frParFc.has(k)) frParFc.set(k, []);
    frParFc.get(k)!.push(s);
  }

  const base = {
    np_sur_fc: {
      moitie1: rnd(r1, 3),
      moitie2: rnd(r2, 3),
      decouplement_pct: r1 && r2 != null ? rnd(((r1 - r2) / r1) * 100, 1) : null,
    },
    fr_par_tranche_fc: [...frParFc.entries()]
      .sort((a, b) => ordreTranche(a[0]) - ordreTranche(b[0]))
      .map(([k, ss]) => ({ tranche_fc: k, secondes: ss.length, fr: rnd(moy(ss.map((s) => s.fr)), 1) })),
    ecart_fc_poignet_ceinture: ecarts.length
      ? {
          max: ecartMax,
          p95: [...ecarts].sort((a, b) => a - b)[Math.floor(ecarts.length * 0.95)],
          moyen: rnd(moy(ecarts), 1),
          secondes: ecarts.length,
        }
      : null,
  };

  const rr = extraireRR(hrv);
  if (rr.length < 100) return { rr: rr.length ? { battements: rr.length } : null, ...base, dfa_alpha1: null };

  const art = marquerArtefacts(rr);
  const nbArt = art.filter(Boolean).length;
  const temps = new Float64Array(rr.length); // instant de chaque battement (s)
  let acc = 0;
  for (let i = 0; i < rr.length; i++) {
    acc += rr[i] / 1000;
    temps[i] = acc;
  }

  // Alignement RR ↔ records : corrélation FC instantanée / FC record.
  const duree = Math.floor(acc);
  const fcRR = new Float64Array(duree + 1).fill(NaN);
  {
    const somme = new Float64Array(duree + 1);
    const cpt = new Float64Array(duree + 1);
    for (let i = 0; i < rr.length; i++) {
      if (art[i]) continue;
      const s = Math.floor(temps[i]);
      if (s > duree) continue;
      somme[s] += 60000 / rr[i];
      cpt[s]++;
    }
    for (let s = 0; s <= duree; s++) if (cpt[s]) fcRR[s] = somme[s] / cpt[s];
  }
  const tMax = serie.length ? serie[serie.length - 1].t : 0;
  const idxParT = new Int32Array(tMax + 1).fill(-1);
  serie.forEach((s, i) => {
    if (s.t >= 0 && s.t <= tMax) idxParT[s.t] = i;
  });
  const fcRec = (t: number) => {
    if (t < 0 || t > tMax) return NaN;
    const i = idxParT[t];
    return i >= 0 && serie[i].fc != null ? (serie[i].fc as number) : NaN;
  };
  let decalage = 0;
  let meilleurR = -Infinity;
  for (let lag = -30; lag <= 30; lag++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let s = 0; s <= duree; s++) {
      const a = fcRR[s];
      const b = fcRec(s + lag);
      if (!Number.isNaN(a) && !Number.isNaN(b)) {
        xs.push(a);
        ys.push(b);
      }
    }
    const reg = regression(xs, ys);
    if (reg?.r != null && reg.r > meilleurR) {
      meilleurR = reg.r;
      decalage = lag;
    }
  }

  // Fenêtres DFA-alpha1.
  const fenetres: Fenetre[] = [];
  let rejetees = 0;
  let i0 = 0;
  for (let t0 = 0; t0 + FENETRE_S <= acc; t0 += PAS_FENETRE_S) {
    while (i0 < rr.length && temps[i0] < t0) i0++;
    const valides: number[] = [];
    let total = 0;
    let artW = 0;
    for (let i = i0; i < rr.length && temps[i] < t0 + FENETRE_S; i++) {
      total++;
      if (art[i]) artW++;
      else valides.push(rr[i]);
    }
    if (!total || artW / total > 0.05 || valides.length < 100) {
      rejetees++;
      continue;
    }
    const a1 = dfaAlpha1(valides);
    if (a1 == null) {
      rejetees++;
      continue;
    }
    const fc = 60000 / (valides.reduce((a, b) => a + b, 0) / valides.length);
    const ps: number[] = [];
    for (let t = Math.ceil(t0 + decalage); t < t0 + decalage + FENETRE_S; t++) {
      if (t < 0 || t > tMax) continue;
      const i = idxParT[t];
      if (i >= 0) ps.push(serie[i].p ?? 0);
    }
    const pm = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null;
    const sd = ecartType(ps);
    fenetres.push({ fc, a1, p: pm, cv: pm && sd != null ? sd / pm : null });
  }

  const parTranche = new Map<string, Fenetre[]>();
  for (const w of fenetres) {
    const k = trancheFc(w.fc) as string;
    if (!parTranche.has(k)) parTranche.set(k, []);
    parTranche.get(k)!.push(w);
  }
  const tous = seuils(fenetres);
  const stables = seuils(fenetres.filter((w) => w.cv != null && w.cv < 0.4));

  let sous = 0;
  let entre = 0;
  let dessus = 0;
  if (tous.fc_a1_075 != null && tous.fc_a1_050 != null) {
    for (const s of serie) {
      if (s.fc == null) continue;
      if (s.fc < tous.fc_a1_075) sous++;
      else if (s.fc < tous.fc_a1_050) entre++;
      else dessus++;
    }
  }

  return {
    rr: {
      battements: rr.length,
      artefacts: nbArt,
      artefacts_pct: rnd((100 * nbArt) / rr.length, 2),
      decalage_s: decalage,
      correlation_alignement: rnd(meilleurR, 3),
    },
    ...base,
    dfa_alpha1: {
      fenetres_valides: fenetres.length,
      fenetres_rejetees: rejetees,
      par_tranche_fc: [...parTranche.entries()]
        .sort((a, b) => ordreTranche(a[0]) - ordreTranche(b[0]))
        .map(([k, ws]) => ({
          tranche_fc: k,
          fenetres: ws.length,
          alpha1: rnd(moy(ws.map((w) => w.a1)), 2),
          puissance: rnd(moy(ws.map((w) => w.p))),
        })),
      seuils: tous,
      seuils_fenetres_stables: stables,
      temps_par_seuil_s:
        tous.fc_a1_075 != null && tous.fc_a1_050 != null
          ? { sous_a1_075: sous, entre: entre, au_dessus_a1_050: dessus }
          : null,
      fiabilite:
        "DFA-alpha1 : méthode émergente. Les seuils (0,75 ≈ seuil aérobie, 0,50 ≈ seuil anaérobie, arrondis au bpm) sont des estimations par régression, sensibles aux artefacts RR et nettement moins fiables en sortie vallonnée (effort non stationnaire). Seuil non calculé (null) si |r| < 0,3. À recouper avec r, le nombre de fenêtres, les fenêtres stables et les sensations.",
    },
  };
}

// ---------------------------------------------------------------------------
// Course à pied : puissance Stryd (champs développeur), splits, découplement
// ---------------------------------------------------------------------------
const NOMS_STRYD: Record<string, string> = {
  power: "puissance",
  "form power": "puissance_forme",
  "air power": "puissance_air",
  "leg spring stiffness": "raideur_jambe",
  "ground time": "temps_contact",
  "vertical oscillation": "oscillation_verticale",
  cadence: "cadence",
  "impact loading rate": "taux_charge_impact",
};
function cleDev(nom: string): string {
  const k = nom.trim().toLowerCase();
  return NOMS_STRYD[k] ?? k.normalize("NFD").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
const cadencePas = (s: Seconde) => (s.c != null && s.c > 0 ? (s.c + (s.cf ?? 0)) * 2 : null);

function blocCourse(serie: Seconde[], session: Msg) {
  // Moyennes des champs développeur (Stryd et autres applis Connect IQ).
  const sommes = new Map<string, { s: number; n: number }>();
  for (const x of serie) {
    if (!x.dev) continue;
    for (const [nom, v] of Object.entries(x.dev)) {
      const k = cleDev(nom);
      const acc = sommes.get(k) ?? { s: 0, n: 0 };
      acc.s += v;
      acc.n++;
      sommes.set(k, acc);
    }
  }
  const dev: Record<string, N> = {};
  for (const [k, { s, n }] of sommes) dev[k] = rnd(s / n, 1);

  const pMoy = moy(serie.map((s) => s.p));
  const fcMoy = moy(serie.map((s) => s.fc));

  // Splits par km (séries à 1 Hz : une entrée = une seconde).
  const splits: Record<string, N>[] = [];
  let km = 0;
  let debut = 0;
  const fermer = (fin: number, distance: number) => {
    const ss = serie.slice(debut, fin);
    if (!ss.length || distance <= 0) return;
    splits.push({
      km: km + 1,
      distance_m: rnd(distance),
      duree_s: ss.length,
      allure_s_km: rnd((ss.length / distance) * 1000),
      fc: rnd(moy(ss.map((s) => s.fc))),
      puissance: rnd(moy(ss.map((s) => s.p))),
      cadence_spm: rnd(moy(ss.map(cadencePas))),
    });
  };
  let dernierDist = 0;
  for (let i = 0; i < serie.length; i++) {
    const d = serie[i].dist;
    if (d == null) continue;
    dernierDist = d;
    if (d >= (km + 1) * 1000) {
      fermer(i, 1000);
      km++;
      debut = i;
    }
  }
  fermer(serie.length, dernierDist - km * 1000);

  // Découplement hors premier km : puissance (ou vitesse) sur FC, 1re vs 2e moitié.
  const apres = serie.filter((s) => s.dist != null && s.dist >= 1000);
  const aP = apres.some((s) => (s.p ?? 0) > 0);
  const ratio = (ss: Seconde[]) => {
    const fc = moy(ss.map((s) => s.fc));
    const x = aP ? moy(ss.map((s) => s.p)) : moy(ss.map((s) => s.v));
    return x != null && fc ? x / fc : null;
  };
  const h = Math.floor(apres.length / 2);
  const r1 = ratio(apres.slice(0, h));
  const r2 = ratio(apres.slice(h));

  return {
    puissance_moy: rnd(pMoy),
    puissance_max: rnd(serie.reduce<N>((m, s) => (s.p != null && (m == null || s.p > m) ? s.p : m), null)),
    np: rnd(puissanceNormalisee(serie.map((s) => s.p))),
    source_puissance: serie.some((s) => s.dev && Object.keys(s.dev).some((k) => cleDev(k) === "puissance"))
      ? "stryd (champ développeur)"
      : pMoy != null
        ? "native"
        : null,
    cadence_moy_spm: rnd(moy(serie.map(cadencePas))),
    cadence_max_spm:
      num(session?.maxRunningCadence ?? session?.maxCadence) != null
        ? rnd(((session.maxRunningCadence ?? session.maxCadence) + (num(session?.maxFractionalCadence) ?? 0)) * 2)
        : null,
    allure_moy: allure(
      num(session?.enhancedAvgSpeed ?? session?.avgSpeed) ? 1000 / (session.enhancedAvgSpeed ?? session.avgSpeed) : null
    ),
    puissance_sur_fc: pMoy != null && fcMoy ? rnd(pMoy / fcMoy, 2) : null,
    champs_developpeur: Object.keys(dev).length ? dev : null,
    splits_km: splits,
    decouplement_hors_km1: {
      base: aP ? "puissance/fc" : "vitesse/fc",
      moitie1: rnd(r1, 4),
      moitie2: rnd(r2, 4),
      pct: r1 && r2 != null ? rnd(((r1 - r2) / r1) * 100, 1) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Natation : longueurs, type de nage, SWOLF, allure par 100 m
// ---------------------------------------------------------------------------
function blocNatation(m: Record<string, Msg[]>, session: Msg) {
  const bassin = num(session?.poolLength);
  const longueurs = m.lengthMesgs ?? [];
  const actives = longueurs.filter((l) => l?.lengthType === "active" || l?.lengthType === 1);
  const parLongueur = actives.map((l) => {
    const t = num(l?.totalTimerTime);
    const coups = num(l?.totalStrokes);
    return {
      nage: texte(l?.swimStroke),
      t,
      coups,
      swolf: t != null && coups != null ? t + coups : null,
    };
  });
  const parNage = new Map<string, typeof parLongueur>();
  for (const l of parLongueur) {
    const k = l.nage ?? "inconnue";
    if (!parNage.has(k)) parNage.set(k, []);
    parNage.get(k)!.push(l);
  }
  const allure100 = (ls: typeof parLongueur) => {
    const t = moy(ls.map((l) => l.t));
    return bassin && t != null ? allure((t / bassin) * 100) : null;
  };
  const distance = num(session?.totalDistance);
  const timer = num(session?.totalTimerTime);
  return {
    bassin_m: bassin,
    longueurs: num(session?.numLengths) ?? longueurs.length,
    longueurs_actives: num(session?.numActiveLengths) ?? actives.length,
    swolf_moy: num(session?.avgSwolf) ?? rnd(moy(parLongueur.map((l) => l.swolf)), 1),
    coups_par_longueur: rnd(num(session?.avgStrokesPerLength), 1),
    distance_par_coup_m: rnd(num(session?.avgStrokeDistance), 2),
    allure_moy_100m: actives.length
      ? allure100(parLongueur)
      : distance && timer
        ? allure((timer / distance) * 100)
        : null,
    par_nage: [...parNage.entries()].map(([nage, ls]) => ({
      nage,
      longueurs: ls.length,
      allure_100m: allure100(ls),
      swolf: rnd(moy(ls.map((l) => l.swolf)), 1),
      coups: rnd(moy(ls.map((l) => l.coups)), 1),
    })),
    series: (m.lapMesgs ?? [])
      .filter((l) => (num(l?.totalDistance) ?? 0) > 0)
      .map((l, i) => ({
        serie: i + 1,
        nage: texte(l?.swimStroke),
        distance_m: rnd(num(l?.totalDistance)),
        duree_s: rnd(num(l?.totalTimerTime)),
        allure_100m:
          num(l?.totalDistance) && num(l?.totalTimerTime) != null
            ? allure((l.totalTimerTime / l.totalDistance) * 100)
            : null,
        swolf: num(l?.avgSwolf),
        fc: num(l?.avgHeartRate),
      })),
  };
}

// ---------------------------------------------------------------------------
// Analyse complète
// ---------------------------------------------------------------------------
export function analyserFit(fit: Uint8Array, contexte: { debutLocal?: string | null } = {}) {
  const m = decoderFit(fit);
  const session: Msg = m.sessionMesgs?.[0] ?? {};

  const devNoms: Record<string, string> = {};
  for (const fd of m.fieldDescriptionMesgs ?? []) {
    const nom = Array.isArray(fd?.fieldName) ? fd.fieldName.join(" ") : fd?.fieldName;
    if (fd?.key != null && typeof nom === "string") devNoms[String(fd.key)] = nom;
  }

  const { serie, pasMedian } = construireSerie(m.recordMesgs ?? [], devNoms);
  const sportSession = texte(session?.sport) ?? "";
  if (sportSession === "running") {
    // Puissance Stryd en champ développeur : utilisée si pas de puissance native.
    for (const s of serie) {
      if (s.p == null && s.dev) {
        const k = Object.keys(s.dev).find((n) => cleDev(n) === "puissance");
        if (k) s.p = s.dev[k];
      }
    }
  }
  const courbe = blocCourbe(serie);
  const meta = blocMeta(m, session, serie, pasMedian, contexte.debutLocal ?? null);
  const sport = meta.sport ?? "";
  const aPuissance = serie.some((s) => (s.p ?? 0) > 0);

  const resultat: Record<string, unknown> = {
    meta,
    natif: blocNatif(session, serie, courbe["20min"]?.w ?? null),
    zones: blocZones(m, session),
  };
  if (aPuissance) resultat.courbe = courbe;
  if (sport === "cycling" && aPuissance) {
    resultat.pedalage = blocPedalage(serie);
    resultat.symetrie = blocSymetrie(serie, m.lapMesgs ?? [], meta.reglages.ftp);
  }
  if (sport === "running") resultat.course = blocCourse(serie, session);
  if (sport === "swimming") resultat.natation = blocNatation(m, session);
  resultat.cardio = blocCardio(m.hrvMesgs ?? [], serie);
  return resultat;
}
