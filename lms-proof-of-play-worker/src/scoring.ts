export interface WeeklyStats {
  /** Delta de duelStats.wins sur la semaine (victoires duel 1v1 en ligne uniquement). */
  duelWins: number;
  /** Delta de ffaStats.wins sur la semaine (victoires FFA 2-4 joueurs en ligne uniquement). */
  ffaWins: number;
}

/**
 * Formule simplifiée pour le hackathon (deadline 8 octobre) : seuls duelWins
 * et ffaWins sont synchronisés côté Firebase et garantis 100% PvP en ligne
 * (voir _lmsMaybeRecordDuelResult / _lmsMaybeRecordFFAResult dans le jeu —
 * jamais déclenchés contre l'IA).
 *
 * Volontairement RETIRÉS par rapport à la formule d'origine, faute de
 * données synchronisées serveur :
 *  - ffaEliminations : aucun champ équivalent nulle part dans les Rules RTDB
 *  - missionsCompleted : système 100% localStorage (_lmsAddMissionProgress),
 *    jamais poussé vers Firebase
 * Les deux peuvent être ajoutés après le 8 octobre en créant un nouveau
 * noeud RTDB synchronisé pour chacun.
 */
export function computeWeeklyScore(stats: WeeklyStats): number {
  const duelPart = Math.min(stats.duelWins, 21) * 10;
  const ffaWinPart = Math.min(stats.ffaWins, 14) * 6;
  const total = duelPart + ffaWinPart;

  // Le programme Anchor stocke le score en entier (u64) — on arrondit ici,
  // une seule fois, pour que le calcul soit déterministe et reproductible.
  return Math.round(total);
}
