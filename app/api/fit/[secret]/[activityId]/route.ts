import { getGarminClient } from "../../../../../lib/garmin-client";
import { telechargerFit } from "../../../../../lib/analyse-seance";
import {
  activityIdValide,
  estFit,
  introuvable,
  reponseFit,
} from "../../../../../lib/telechargement-fit";

// ---------------------------------------------------------------------------
// GET /api/fit/<MCP_SECRET>/<activityId> : FIT original d'une activité
// (extrait du zip « Exporter l'original »), en binaire. Lecture seule, rien
// n'est stocké. Protection identique au connecteur : secret en segment de
// chemin, tout refus en 404 (jamais de 401), corps neutre. Rien n'est loggé :
// le secret figure dans l'URL.
// ---------------------------------------------------------------------------
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  // Chemin brut, comme le connecteur : ["api", "fit", "<secret>", "<activityId>"].
  const segments = new URL(req.url).pathname.split("/").filter(Boolean);
  const secret = process.env.MCP_SECRET;
  if (!secret || segments[2] !== secret) return introuvable();

  const activityId = segments[3] ?? "";
  if (!activityIdValide(activityId)) return introuvable();

  try {
    const client = await getGarminClient();
    const fit = await telechargerFit(client, activityId);
    return estFit(fit) ? reponseFit(fit, activityId) : introuvable();
  } catch {
    // Activité inconnue, accès refusé par Garmin, login en échec : même 404.
    return introuvable();
  }
}

// Autres méthodes : 404 aussi (Next répondrait 405 ou 204, ce qui révélerait
// l'existence de la route sans secret).
async function refus(): Promise<Response> {
  return introuvable();
}
export const POST = refus;
export const PUT = refus;
export const PATCH = refus;
export const DELETE = refus;
export const OPTIONS = refus;
