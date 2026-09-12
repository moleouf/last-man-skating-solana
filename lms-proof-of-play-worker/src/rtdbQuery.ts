/**
 * Remplace firestoreQuery.ts : ta base est Realtime Database, pas Firestore.
 * L'API REST RTDB est bien plus simple — un GET par noeud, pas de pagination,
 * pas de format {fields:{integerValue...}} imbriqué, juste du JSON brut.
 *
 * Confirmé sur LMS_v2115.html + les Rules RTDB fournies :
 *   duelStats/{uid}  { name, wins, losses, ts }  — cumul total, jamais remis à zéro
 *   ffaStats/{uid}   { name, wins, losses, ts }  — idem
 * Les deux sont garantis 100% PvP en ligne (_lmsMaybeRecordDuelResult /
 * _lmsMaybeRecordFFAResult ne s'incrémentent jamais contre l'IA).
 *
 * MANQUANT dans le schéma actuel, à ajouter avant que ce Worker soit
 * utilisable en vrai : un noeud `wallets/{uid}: { address, ts }` écrit côté
 * client au moment du authorize() MWA, + la Rule RTDB correspondante
 * (".write": "auth.uid === $uid", même pattern que "presence"). Sans ça, ce
 * fichier ne peut pas savoir vers quelle adresse Solana envoyer les gains.
 */

export interface RawPlayerTotals {
  uid: string;
  name: string;
  duelWins: number;
  ffaWins: number;
}

async function fetchJson<T>(rtdbBaseUrl: string, path: string, accessToken: string): Promise<T | null> {
  const url = `${rtdbBaseUrl.replace(/\/$/, "")}/${path}.json`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`Erreur RTDB REST sur ${path}: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as T | null;
  return body;
}

/**
 * Récupère les totaux CUMULÉS actuels de duelStats + ffaStats pour tous les
 * joueurs. Ce ne sont PAS encore des stats hebdo — voir weekSnapshot.ts pour
 * le calcul du delta par rapport au snapshot de la semaine précédente.
 */
export async function fetchCurrentTotals(rtdbBaseUrl: string, accessToken: string): Promise<RawPlayerTotals[]> {
  type StatsNode = Record<string, { name?: string; wins?: number; losses?: number }>;

  const [duelStats, ffaStats] = await Promise.all([
    fetchJson<StatsNode>(rtdbBaseUrl, "duelStats", accessToken),
    fetchJson<StatsNode>(rtdbBaseUrl, "ffaStats", accessToken),
  ]);

  const uids = new Set<string>([...Object.keys(duelStats ?? {}), ...Object.keys(ffaStats ?? {})]);

  const results: RawPlayerTotals[] = [];
  for (const uid of uids) {
    const d = duelStats?.[uid];
    const f = ffaStats?.[uid];
    results.push({
      uid,
      name: d?.name ?? f?.name ?? uid,
      duelWins: d?.wins ?? 0,
      ffaWins: f?.wins ?? 0,
    });
  }
  return results;
}

/**
 * Récupère la table uid -> adresse wallet Solana. Voir le TODO en haut de
 * fichier : ce noeud n'existe pas encore dans tes Rules actuelles.
 */
export async function fetchWallets(rtdbBaseUrl: string, accessToken: string): Promise<Record<string, string>> {
  type WalletsNode = Record<string, { address?: string }>;
  const wallets = await fetchJson<WalletsNode>(rtdbBaseUrl, "wallets", accessToken);
  const out: Record<string, string> = {};
  for (const [uid, w] of Object.entries(wallets ?? {})) {
    if (w?.address) out[uid] = w.address;
  }
  return out;
}
