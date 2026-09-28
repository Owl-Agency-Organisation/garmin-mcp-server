// ---------------------------------------------------------------------------
// Endpoint de téléchargement du FIT original : fonctions pures (sans import),
// testables hors Next. L'orchestration vit dans app/api/fit/.../route.ts.
// ---------------------------------------------------------------------------

// Identifiant d'activité Garmin : chiffres uniquement.
export function activityIdValide(id: string): boolean {
  return /^\d{1,20}$/.test(id);
}

// En-tête FIT : taille 12 ou 14 octets, signature « .FIT » aux octets 8 à 11.
// Garde-fou : une réponse Garmin inattendue (page d'erreur, JSON) ne doit
// jamais partir comme fichier .fit.
export function estFit(octets: Uint8Array): boolean {
  const taille = octets[0];
  return (
    (taille === 12 || taille === 14) &&
    octets.length > taille &&
    octets[8] === 0x2e && // .
    octets[9] === 0x46 && // F
    octets[10] === 0x49 && // I
    octets[11] === 0x54 // T
  );
}

export function reponseFit(fit: Uint8Array, activityId: string): Response {
  return new Response(new Uint8Array(fit), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${activityId}.fit"`,
      "Content-Length": String(fit.length),
      // Données personnelles : jamais de cache CDN ni navigateur.
      "Cache-Control": "no-store",
    },
  });
}

// Refus neutre : même corps pour mauvais secret, identifiant invalide ou
// échec Garmin. Aucun détail (ni secret, ni message d'erreur) n'est renvoyé.
export function introuvable(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}
