// Analyse locale d'un export « original » Garmin (zip ou .fit), sans serveur ni identifiants.
// Usage : node --no-warnings scripts/analyse-locale.mjs local/<activityId>.zip [--json]
// Déposer les exports dans local/ (ignoré par git) : jamais de FIT dans le repo.
import fs from "node:fs";
import { analyserFit, extraireFit } from "../lib/analyse-seance.ts";

const chemin = process.argv[2];
if (!chemin) {
  console.error("Usage : node --no-warnings scripts/analyse-locale.mjs <fichier.zip|fichier.fit> [--json]");
  process.exit(1);
}
const t0 = Date.now();
const fit = extraireFit(new Uint8Array(fs.readFileSync(chemin)));
const t1 = Date.now();
const res = analyserFit(fit);
const t2 = Date.now();
const json = JSON.stringify(res);
console.error(
  `FIT ${fit.length} octets | dézip ${t1 - t0} ms | analyse ${t2 - t1} ms | JSON ${json.length} octets`
);
if (process.argv.includes("--json")) console.log(JSON.stringify(res, null, 2));
