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

export interface WalletWeeklyGroup {
  walletAddress: string;
  uids: string[];
  names: string[];
  /** Somme des deltas de TOUS les uid rattachés à ce wallet (le plafond de scoring.ts s'applique ensuite sur ce total). */
  stats: WeeklyStats;
}

/**
 * Regroupe les deltas par ADRESSE WALLET. submit_score écrase le PlayerScore (PDA dérivé de weekId + wallet) :
 * avec un envoi par uid, deux uid du même wallet (réinstallation, changement d'appareil en cours de semaine)
 * s'écrasaient et seul le dernier traité survivait, quel que soit son score. En additionnant les deltas AVANT
 * de calculer le score, le plafond hebdomadaire (21 duels / 14 FFA) reste appliqué par wallet.
 * Un wallet associé à un seul uid donne exactement le même résultat qu'avant.
 */
export function groupDeltasByWallet(
  deltas: PlayerWeeklyDelta[],
  wallets: Record<string, string>
): { groups: WalletWeeklyGroup[]; noWallet: PlayerWeeklyDelta[] } {
  const byWallet = new Map<string, WalletWeeklyGroup>();
  const noWallet: PlayerWeeklyDelta[] = [];
  for (const d of deltas) {
    const walletAddress = wallets[d.uid];
    if (!walletAddress) {
      noWallet.push(d);
      continue;
    }
    const g = byWallet.get(walletAddress);
    if (g) {
      g.uids.push(d.uid);
      g.names.push(d.name);
      g.stats = { duelWins: g.stats.duelWins + d.stats.duelWins, ffaWins: g.stats.ffaWins + d.stats.ffaWins };
    } else {
      byWallet.set(walletAddress, { walletAddress, uids: [d.uid], names: [d.name], stats: { ...d.stats } });
    }
  }
  return { groups: [...byWallet.values()], noWallet };
}
