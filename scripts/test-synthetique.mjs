// FIT synthétiques (course avec Stryd en champs développeur, natation en bassin) :
// test de fumée des blocs course et natation, sans donnée personnelle.
// Usage : node --no-warnings scripts/test-synthetique.mjs
import { Encoder, Profile } from "@garmin/fitsdk";
import { analyserFit } from "../lib/analyse-seance.ts";
const M = Profile.MesgNum;
const d0 = new Date("2026-09-20T07:00:00Z");
const ts = (s) => new Date(d0.getTime() + s * 1000);

function course() {
  const devId = { mesgNum: M.DEVELOPER_DATA_ID, developerDataIndex: 0, applicationId: Array(16).fill(1), applicationVersion: 1 };
  const fdPower = { mesgNum: M.FIELD_DESCRIPTION, developerDataIndex: 0, fieldDefinitionNumber: 0, fitBaseTypeId: 132, fieldName: "Power", units: "Watts", nativeMesgNum: 20 };
  const fdLss = { mesgNum: M.FIELD_DESCRIPTION, developerDataIndex: 0, fieldDefinitionNumber: 1, fitBaseTypeId: 136, fieldName: "Leg Spring Stiffness", units: "KN/m", nativeMesgNum: 20 };
  const e = new Encoder({ fieldDescriptions: { 0: { developerDataIdMesg: devId, fieldDescriptionMesg: fdPower }, 1: { developerDataIdMesg: devId, fieldDescriptionMesg: fdLss } } });
  e.writeMesg({ mesgNum: M.FILE_ID, type: "activity", manufacturer: "garmin", product: 4315, timeCreated: d0 });
  e.writeMesg(devId); e.writeMesg(fdPower); e.writeMesg(fdLss);
  const N = 3600; let dist = 0;
  for (let s = 0; s < N; s++) {
    const v = 3.2 + 0.2 * Math.sin(s / 300); dist += v;
    const fc = Math.round(120 + 30 * s / N);
    e.writeMesg({ mesgNum: M.RECORD, timestamp: ts(s), distance: dist, enhancedSpeed: v, heartRate: fc, cadence: 86, fractionalCadence: 0.5, developerFields: { 0: 240 + Math.round(10 * Math.sin(s / 200)), 1: 10.5 } });
  }
  e.writeMesg({ mesgNum: M.LAP, timestamp: ts(N), startTime: d0, totalTimerTime: N, totalDistance: dist });
  e.writeMesg({ mesgNum: M.SESSION, timestamp: ts(N), startTime: d0, sport: "running", subSport: "generic", totalTimerTime: N, totalElapsedTime: N, totalDistance: dist, enhancedAvgSpeed: dist / N, avgHeartRate: 135, maxHeartRate: 150, avgCadence: 86, maxCadence: 92 });
  return e.close();
}

function natation() {
  const e = new Encoder();
  e.writeMesg({ mesgNum: M.FILE_ID, type: "activity", manufacturer: "garmin", product: 4315, timeCreated: d0 });
  let t = 0; const nages = ["freestyle", "freestyle", "breaststroke", "freestyle"];
  for (let i = 0; i < 40; i++) {
    const idle = i % 10 === 9;
    const dur = idle ? 30 : 28 + (i % 3);
    e.writeMesg({ mesgNum: M.LENGTH, timestamp: ts(t + dur), startTime: ts(t), totalElapsedTime: dur, totalTimerTime: dur, totalStrokes: idle ? 0 : 14, swimStroke: nages[i % 4], lengthType: idle ? "idle" : "active", messageIndex: i });
    e.writeMesg({ mesgNum: M.RECORD, timestamp: ts(t), heartRate: 130 });
    t += dur;
  }
  e.writeMesg({ mesgNum: M.LAP, timestamp: ts(t), startTime: d0, totalTimerTime: t, totalDistance: 900, swimStroke: "freestyle", avgSwolf: 43 });
  e.writeMesg({ mesgNum: M.SESSION, timestamp: ts(t), startTime: d0, sport: "swimming", subSport: "lapSwimming", poolLength: 25, totalTimerTime: t, totalElapsedTime: t, totalDistance: 900, numLengths: 40, numActiveLengths: 36, avgSwolf: 43 });
  return e.close();
}

for (const [nom, f] of [["course", course], ["natation", natation]]) {
  try {
    const r = analyserFit(f());
    const out = JSON.stringify(r);
    console.log(`== ${nom} (${out.length} octets)`);
    console.log(JSON.stringify(r[nom], null, 0).slice(0, 1500));
    console.log("courbe:", JSON.stringify(r.courbe?.["5min"] ?? null), "cardio.rr:", JSON.stringify(r.cardio.rr));
  } catch (err) { console.log(nom, "ERREUR", err.stack); }
}
