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
 * CORRIGÉ : doit produire EXACTEMENT le même résultat que _lmsWeekKey() côté
 * jeu (ligne ~10087 de LMS_v2115.html) pour que le weekId sur lequel le
 * programme Anchor règle une cagnotte corresponde au weekId sous lequel le
 * client range ses stats. L'ancienne version de ce fichier utilisait une
 * formule différente (non ISO 8601) qui pouvait diverger de quelques
 * semaines selon la période de l'année.
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
 * Le cron tourne le lundi à 3h UTC, donc "maintenant" est déjà dans la
 * nouvelle semaine ISO. La semaine à régler est celle qui vient de finir
 * (hier, dimanche) — on prend une date 24h en arrière pour être sûr de
 * retomber dans la bonne semaine quelle que soit l'heure exacte du run.
 */
function weekIdBeingSettled(now: Date): string {
  return isoWeekId(new Date(now.getTime() - 24 * 3600 * 1000));
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

  // On ne sauvegarde le nouveau snapshot qu'APRÈS une soumission réussie
  // (même partielle) : si tout le run plante avant, on veut pouvoir relancer
  // avec le même snapshot de départ plutôt que de perdre le delta de la semaine.
  await saveSnapshot(env.WEEK_SNAPSHOT_KV, currentTotals);

  const failed = results.filter((r) => r.error);
  const succeeded = results.filter((r) => r.signature);

  return new Response(
    JSON.stringify(
      {
        weekId,
        eligiblePlayers: eligible.length,
        submitted: succeeded.length,
        failed: failed.length,
        failedDetails: failed,
        skippedNoWallet: missingWallet.map((d) => ({ uid: d.uid, name: d.name, score: d.score })),
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
