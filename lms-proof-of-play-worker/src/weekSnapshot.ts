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
// Copie de l'avant-dernier snapshot, écrite juste avant d'écraser SNAPSHOT_KEY.
// Permet de recalculer a posteriori les deltas d'un règlement déjà passé
// (current - previous) au lieu de les perdre définitivement.
const SNAPSHOT_PREV_KEY = "previous-totals-snapshot";

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
  const existing = await kv.get(SNAPSHOT_KEY);
  if (existing) await kv.put(SNAPSHOT_PREV_KEY, existing);
  const payload: StoredSnapshot = { takenAt: new Date().toISOString(), totals };
  await kv.put(SNAPSHOT_KEY, JSON.stringify(payload));
}

/**
 * Totaux à sauvegarder quand certains uid n'ont PAS été payés ce run (soumission
 * en échec, ou joueur sans wallet). Pour ces uid on garde les anciennes valeurs
 * du snapshot : leur delta n'est pas "consommé" et sera recalculé (cumulé) au
 * prochain règlement. Un uid absent de l'ancien snapshot (nouveau joueur) est
 * enregistré à 0/0 : sa baseline théorique, cohérente avec computeWeeklyDeltas
 * qui compte ses totaux entiers comme delta. Ses victoires non payées ce run
 * seront donc payées au suivant.
 */
export function holdBackTotals(
  currentTotals: RawPlayerTotals[],
  previousSnapshot: RawPlayerTotals[] | null,
  holdBackUids: Set<string>
): RawPlayerTotals[] {
  if (!previousSnapshot || holdBackUids.size === 0) return currentTotals;
  const previousByUid = new Map(previousSnapshot.map((p) => [p.uid, p]));
  return currentTotals.map((c) => {
    if (!holdBackUids.has(c.uid)) return c;
    const prev = previousByUid.get(c.uid);
    return prev
      ? { ...c, duelWins: prev.duelWins, ffaWins: prev.ffaWins }
      : { ...c, duelWins: 0, ffaWins: 0 };
  });
}

export interface PlayerWeeklyDelta {
  uid: string;
  name: string;
  stats: WeeklyStats;
}

/**
 * Delta = totaux actuels - totaux au dernier snapshot.
 *
 * Nouveau joueur (uid absent du snapshot précédent) : son delta = ses totaux
 * ACTUELS (baseline 0/0), pour qu'un joueur qui crée son compte et joue pendant
 * la semaine soit payé dès le premier lundi.
 *
 * Pourquoi c'est sûr : duelStats/ffaStats/{uid} n'existent qu'à partir du premier
 * résultat de match en ligne enregistré par ce uid. Un uid absent du snapshot de
 * la semaine précédente n'avait donc encore joué aucun match en ligne à ce moment-là :
 * toutes ses victoires datent d'après. Exception : un uid qui reçoit un historique
 * COPIÉ (code de synchro / migration, voir _lmsCopyProgressBetweenUids côté jeu) —
 * il serait payé pour cet historique, mais le plafond hebdomadaire par wallet de
 * scoring.ts (21 duels / 14 FFA) borne le gain à un seul "plein" de semaine.
 *
 * Exception volontaire : au TOUT premier run (previousSnapshot === null), personne
 * n'est payé — on n'a pas de baseline, on la pose seulement (voir isFirstRun dans index.ts).
 *
 * Delta négatif (ne devrait pas arriver vu la Rule monotone croissante, sauf copie
 * de totaux via syncCode) -> clampé à 0.
 */
export function computeWeeklyDeltas(
  currentTotals: RawPlayerTotals[],
  previousSnapshot: RawPlayerTotals[] | null
): PlayerWeeklyDelta[] {
  const hasBaseline = previousSnapshot !== null;
  const previousByUid = new Map((previousSnapshot ?? []).map((p) => [p.uid, p]));

  return currentTotals.map((current) => {
    const prev = previousByUid.get(current.uid);
    let duelWins = 0;
    let ffaWins = 0;
    if (prev) {
      duelWins = Math.max(0, current.duelWins - prev.duelWins);
      ffaWins = Math.max(0, current.ffaWins - prev.ffaWins);
    } else if (hasBaseline) {
      duelWins = current.duelWins; // nouveau joueur : tout ce qu'il a gagné date d'après le dernier snapshot
      ffaWins = current.ffaWins;
    }
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
