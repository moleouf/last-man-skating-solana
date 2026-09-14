import { getRtdbAccessToken } from "./firebaseAuth";
import { fetchCurrentTotals, fetchWallets } from "./rtdbQuery";
import { loadPreviousSnapshot, saveSnapshot, computeWeeklyDeltas } from "./weekSnapshot";
import { computeWeeklyScore } from "./scoring";
import { submitWeeklyScoresOnChain } from "./solanaSubmit";

export interface Env {
  SOLANA_RPC_URL: string;
  SOLANA_PROGRAM_ID: string;
  // URL complète de la RTDB (PAS juste le project id — le host dépend de la
  // région). Trouvée dans LMS_v2115.html (_lmsFirebaseConfig.databaseURL) :
  //   https://last-man-skating-default-rtdb.europe-west1.firebasedatabase.app
  FIREBASE_RTDB_URL: string;
  MANUAL_TRIGGER_SECRET: string;
  WEEK_SNAPSHOT_KV: KVNamespace;
  // Secrets (wrangler secret put) :
  FIREBASE_SERVICE_ACCOUNT_JSON: string;
  SOLANA_AUTHORITY_SECRET_KEY: string;
}

/**
 * week_id ISO 8601 (YYYY-Www, semaine Thursday-based, lundi = premier jour).
 * DOIT produire EXACTEMENT le même résultat que _lmsWeekKey() côté jeu
 * (LMS_v2157.html) et _lmsNextWeekRolloverUTC() (label de deadline settings) :
 * les trois s'accordent sur un changement de semaine à lundi 00:00 UTC pile.
 */
function isoWeekId(d: Date): string {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (dt.getUTCDay() + 6) % 7; // lundi = 0
  dt.setUTCDate(dt.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const week =
    1 + Math.round(((dt.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * CHANGEMENT : le cron tourne maintenant à 00:01 UTC le lundi (voir
 * wrangler.jsonc, "0 1 * * 1" en minutes/heure cron = 1 minute après minuit),
 * soit juste après le changement de semaine ISO côté client. On ne soustrait
 * donc plus 24h : "maintenant" (00:01 UTC lundi) tombe déjà dans la semaine
 * qui vient de se terminer au sens de isoWeekId (le calcul ISO bascule
 * exactement à 00:00 UTC lundi), sauf qu'on veut régler la semaine PRÉCÉDENTE,
 * donc on garde un léger recul (quelques minutes) pour rester bien à
 * l'intérieur de la semaine qui vient de finir, sans dépendre d'un décalage
 * de 24h qui laissait une fenêtre de 3h de désync avec le client (voir
 * discussion : avant, cron à 3h UTC alors que le client bascule de semaine à
 * 0h UTC -> during cette fenêtre le bouton RÉCLAMER de l'app ne trouvait plus
 * la pool de la semaine qui vient de se terminer, alors qu'elle n'était pas
 * encore réglée on-chain).
 */
function weekIdBeingSettled(now: Date): string {
  return isoWeekId(new Date(now.getTime() - 5 * 60 * 1000)); // recul de 5 min, marge de sécurité
}

async function runWeeklySettlement(env: Env, weekId: string): Promise<Response> {
  const accessToken = await getRtdbAccessToken(env.FIREBASE_SERVICE_ACCOUNT_JSON);

  const [currentTotals, wallets, previousSnapshot] = await Promise.all([
    fetchCurrentTotals(env.FIREBASE_RTDB_URL, accessToken),
    fetchWallets(env.FIREBASE_RTDB_URL, accessToken),
    loadPreviousSnapshot(env.WEEK_SNAPSHOT_KV),
  ]);

  const deltas = computeWeeklyDeltas(currentTotals, previousSnapshot);

  const eligible = deltas
    .map((d) => ({ ...d, walletAddress: wallets[d.uid], score: computeWeeklyScore(d.stats) }))
    .filter((d) => d.score > 0); // pas de partie jouée cette semaine -> rien à soumettre

  const withWallet = eligible.filter((d) => !!d.walletAddress);
  const missingWallet = eligible.filter((d) => !d.walletAddress);

  // NOTE : ce worker suppose que initialize_weekly_pool + fund_pool ont déjà
  // été appelés pour ce weekId (à faire toi-même, manuellement ou via un
  // autre script — ce ne sont pas des opérations hebdomadaires automatiques
  // tant que le montant de la cagnotte n'est pas déterminé automatiquement).
  const results = await submitWeeklyScoresOnChain(
    env.SOLANA_RPC_URL,
    env.SOLANA_PROGRAM_ID,
    env.SOLANA_AUTHORITY_SECRET_KEY,
    weekId,
    withWallet.map((d) => ({ walletAddress: d.walletAddress, score: d.score }))
  );

  const failed = results.filter((r) => r.error);
  const succeeded = results.filter((r) => r.signature);

  // FIX : on ne fait avancer le snapshot QUE si au moins une soumission a
  // réussi. Avant, saveSnapshot() était appelé inconditionnellement juste
  // après submitWeeklyScoresOnChain(), donc même un run où TOUTES les
  // soumissions échouaient (ex. PoolAlreadyFinalized sur 100% des joueurs)
  // faisait quand même avancer le snapshot vers currentTotals -> le delta
  // de cette semaine était perdu (ni payé, ni reporté à la semaine
  // suivante). Avec cette garde, un run entièrement raté laisse le
  // snapshot inchangé, donc le prochain run recalculera le même delta (ou
  // plus, si le joueur a continué à jouer) et pourra le soumettre.
  if (succeeded.length > 0) {
    await saveSnapshot(env.WEEK_SNAPSHOT_KV, currentTotals);
  }

  return new Response(
    JSON.stringify(
      {
        weekId,
        eligiblePlayers: eligible.length,
        submitted: succeeded.length,
        failed: failed.length,
        failedDetails: failed,
        skippedNoWallet: missingWallet.map((d) => ({ uid: d.uid, name: d.name, score: d.score })),
        snapshotAdvanced: succeeded.length > 0,
      },
      null,
      2
    ),
    { headers: { "Content-Type": "application/json" } }
  );
}

export default {
  // Déclenché automatiquement par le Cron Trigger défini dans wrangler.jsonc
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const weekId = weekIdBeingSettled(new Date());
    ctx.waitUntil(runWeeklySettlement(env, weekId).then((r) => r.text()).then(console.log));
  },

  // Déclenchement HTTP manuel pour tester sans attendre le cron.
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/run-settlement") {
      return new Response("Not found", { status: 404 });
    }

    const providedSecret = request.headers.get("X-Trigger-Secret");
    if (!env.MANUAL_TRIGGER_SECRET || providedSecret !== env.MANUAL_TRIGGER_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const weekId = url.searchParams.get("weekId") ?? weekIdBeingSettled(new Date());
    return runWeeklySettlement(env, weekId);
  },
};
