import type { RawPlayerTotals } from "./rtdbQuery";
import type { WeeklyStats } from "./scoring";

/**
 * duelStats/ffaStats sont cumulatifs à vie (confirmé : la Rule RTDB impose
 * wins+losses >= ancien total, jamais de reset). Impossible d'isoler "les
 * victoires de cette semaine" sans comparer à une photo prise en début de
 * semaine. On stocke cette photo dans le KV Cloudflare (clé unique,
 * écrasée à chaque run — pas besoin d'historiser plus d'une semaine en arrière).
 *
 * Ajoute le binding KV dans wrangler.jsonc avant usage (voir commentaire
 * dans ce fichier), ex. :
 *   "kv_namespaces": [{ "binding": "WEEK_SNAPSHOT_KV", "id": "<id créé via wrangler>" }]
 */

const SNAPSHOT_KEY = "latest-totals-snapshot";

interface StoredSnapshot {
  takenAt: string; // ISO, pour debug/logs uniquement
  totals: RawPlayerTotals[];
}

export async function loadPreviousSnapshot(kv: KVNamespace): Promise<RawPlayerTotals[] | null> {
  const raw = await kv.get(SNAPSHOT_KEY);
  if (!raw) return null; // premier run jamais effectué -> pas de baseline
  const parsed = JSON.parse(raw) as StoredSnapshot;
  return parsed.totals;
}

export async function saveSnapshot(kv: KVNamespace, totals: RawPlayerTotals[]): Promise<void> {
  const payload: StoredSnapshot = { takenAt: new Date().toISOString(), totals };
  await kv.put(SNAPSHOT_KEY, JSON.stringify(payload));
}

export interface PlayerWeeklyDelta {
  uid: string;
  name: string;
  stats: WeeklyStats;
}

/**
 * Delta = totaux actuels - totaux au dernier snapshot.
 *
 * Deux cas particuliers volontairement traités "safe" plutôt qu'optimistes :
 *  - uid absent du snapshot précédent (nouveau joueur, ou tout premier run
 *    du Worker) -> delta = 0. On ne peut pas prouver que ses victoires
 *    cumulées actuelles datent de cette semaine, donc on ne les paye pas
 *    plutôt que de risquer de payer plusieurs mois d'historique d'un coup.
 *  - delta négatif (ne devrait pas arriver vu la Rule monotone croissante,
 *    sauf fusion de compte via un syncCode qui recopie des totaux d'un
 *    autre device — voir _lmsCopyProgressBetweenUids côté jeu) -> clampé à 0.
 */
export function computeWeeklyDeltas(
  currentTotals: RawPlayerTotals[],
  previousSnapshot: RawPlayerTotals[] | null
): PlayerWeeklyDelta[] {
  const previousByUid = new Map((previousSnapshot ?? []).map((p) => [p.uid, p]));

  return currentTotals.map((current) => {
    const prev = previousByUid.get(current.uid);
    const duelWins = prev ? Math.max(0, current.duelWins - prev.duelWins) : 0;
    const ffaWins = prev ? Math.max(0, current.ffaWins - prev.ffaWins) : 0;
    return { uid: current.uid, name: current.name, stats: { duelWins, ffaWins } };
  });
}
