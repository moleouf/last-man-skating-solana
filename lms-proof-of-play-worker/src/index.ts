import { getRtdbAccessToken } from "./firebaseAuth";
import { fetchCurrentTotals, fetchWallets } from "./rtdbQuery";
import { loadPreviousSnapshot, saveSnapshot, computeWeeklyDeltas } from "./weekSnapshot";
import { computeWeeklyScore } from "./scoring";
import { submitWeeklyScoresOnChain } from "./solanaSubmit";
import { ensureWeeklyPoolInitialized } from "./poolLifecycle";

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
  // Ajoutés le 15/09/2026 pour l'ouverture automatique de la pool (voir
  // poolLifecycle.ts) :
  SOLANA_MINT_ADDRESS: string;
  // Optionnel — absent/vide = fund_pool reste manuel, seule l'init est auto.
  AUTO_FUND_AMOUNT?: string;
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

  // NOTE (mise à jour 15/09/2026) : initialize_weekly_pool + fund_pool pour
  // ce weekId sont maintenant déclenchés automatiquement par ce même
  // Worker, juste avant ce règlement (voir scheduled() ci-dessous et
  // poolLifecycle.ts) — mais concernent la semaine À VENIR, pas celle
  // qu'on règle ici. Rien à faire de spécial dans cette fonction.
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
  //
  // FIX (2026-09-14) : au tout premier run (KV jamais rempli),
  // previousSnapshot est null -> computeWeeklyDeltas renvoie 0 pour tout le
  // monde -> rien n'est éligible -> rien n'est soumis -> succeeded reste à
  // 0 -> sans ce cas particulier, le snapshot n'est JAMAIS sauvegardé, et le
  // run suivant repart avec previousSnapshot encore null : blocage permanent
  // dès le tout premier lancement du Worker, y compris en prod avec de
  // vrais joueurs actifs. On sauvegarde donc aussi au premier run, même
  // sans rien soumettre : ça ne "perd" aucun delta puisqu'il n'y avait de
  // toute façon rien de payable sans baseline — ça pose juste le point de
  // départ pour la semaine suivante.
  const isFirstRun = previousSnapshot === null;
  if (succeeded.length > 0 || isFirstRun) {
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
        snapshotAdvanced: succeeded.length > 0 || isFirstRun,
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
    const now = new Date();
    const weekBeingSettled = weekIdBeingSettled(now);
    ctx.waitUntil(
      runWeeklySettlement(env, weekBeingSettled)
        .then((r) => r.text())
        .then(console.log)
    );

    // Ouvre (et finance, si AUTO_FUND_AMOUNT est défini) la pool de la
    // semaine qui commence tout juste (celle qu'on est en train de vivre
    // au moment où ce cron tourne, 00:01 UTC lundi) — voir poolLifecycle.ts.
    // Séparé du waitUntil ci-dessus : un échec du règlement ne doit pas
    // empêcher l'ouverture de la nouvelle semaine, et inversement.
    const weekStarting = isoWeekId(now);
    ctx.waitUntil(
      ensureWeeklyPoolInitialized(env, weekStarting).then((r) =>
        console.log("[poolLifecycle]", JSON.stringify(r))
      )
    );
  },

  // Déclenchement HTTP manuel pour tester sans attendre le cron.
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const providedSecret = request.headers.get("X-Trigger-Secret");
    if (!env.MANUAL_TRIGGER_SECRET || providedSecret !== env.MANUAL_TRIGGER_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (url.pathname === "/run-settlement") {
      const weekId = url.searchParams.get("weekId") ?? weekIdBeingSettled(new Date());
      return runWeeklySettlement(env, weekId);
    }

    if (url.pathname === "/init-pool") {
      // weekId obligatoire ici (pas de défaut implicite) : on ne veut pas
      // qu'un appel sans paramètre initialise silencieusement la mauvaise
      // semaine par erreur de manip.
      const weekId = url.searchParams.get("weekId");
      if (!weekId) {
        return new Response("Paramètre weekId manquant (ex. ?weekId=2026-W39)", { status: 400 });
      }
      // ?amount=10 override AUTO_FUND_AMOUNT pour CET appel uniquement,
      // sans toucher au secret ni au comportement du cron.
      const amountOverride = url.searchParams.get("amount");
      const envForThisCall = amountOverride ? { ...env, AUTO_FUND_AMOUNT: amountOverride } : env;
      const result = await ensureWeeklyPoolInitialized(envForThisCall, weekId);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
