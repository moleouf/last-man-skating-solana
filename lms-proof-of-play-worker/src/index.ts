import { getRtdbAccessToken } from "./firebaseAuth";
import { fetchCurrentTotals, fetchWallets } from "./rtdbQuery";
import {
  loadPreviousSnapshot,
  saveSnapshot,
  holdBackTotals,
  computeWeeklyDeltas,
  groupDeltasByWallet,
} from "./weekSnapshot";
import { computeWeeklyScore } from "./scoring";
import { submitWeeklyScoresOnChain } from "./solanaSubmit";
import { ensureWeeklyPoolInitialized } from "./poolLifecycle";
import { readPoolState, inspectPool } from "./poolInspect";

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

interface SettlementOptions {
  /** Calcule et renvoie le plan sans rien soumettre ni toucher au snapshot / au journal KV. */
  dryRun?: boolean;
  /** Ignore le garde-fou "pool absente / finalisée / non financée". */
  force?: boolean;
}

/**
 * Renvoie le rapport en JSON et, sauf dry-run, le conserve dans le KV
 * (clé settlement-log:<weekId>:<horodatage>) : les logs Observability
 * expirent vite, pas le KV. Relisible via GET /last-settlement?weekId=...
 */
async function respond(
  env: Env,
  weekId: string,
  report: Record<string, unknown>,
  persist: boolean
): Promise<Response> {
  const body = JSON.stringify(report, null, 2);
  if (persist) {
    try {
      await env.WEEK_SNAPSHOT_KV.put(`settlement-log:${weekId}:${new Date().toISOString()}`, body);
    } catch (err) {
      console.error("[settlement] écriture du journal KV impossible:", err);
    }
  }
  return new Response(body, { headers: { "Content-Type": "application/json" } });
}

async function runWeeklySettlement(
  env: Env,
  weekId: string,
  opts: SettlementOptions = {}
): Promise<Response> {
  const accessToken = await getRtdbAccessToken(env.FIREBASE_SERVICE_ACCOUNT_JSON);

  const [currentTotals, wallets, previousSnapshot] = await Promise.all([
    fetchCurrentTotals(env.FIREBASE_RTDB_URL, accessToken),
    fetchWallets(env.FIREBASE_RTDB_URL, accessToken),
    loadPreviousSnapshot(env.WEEK_SNAPSHOT_KV),
  ]);

  const deltas = computeWeeklyDeltas(currentTotals, previousSnapshot);

  // Regroupement par wallet : plusieurs uid pour un même wallet voient leurs deltas additionnés (sinon
  // submit_score, qui écrase, ne conservait que le dernier uid traité — voir groupDeltasByWallet).
  const { groups, noWallet } = groupDeltasByWallet(deltas, wallets);

  const withWallet = groups
    .map((g) => ({ ...g, score: computeWeeklyScore(g.stats) }))
    .filter((g) => g.score > 0); // pas de partie jouée cette semaine -> rien à soumettre
  const missingWallet = noWallet
    .map((d) => ({ ...d, score: computeWeeklyScore(d.stats) }))
    .filter((d) => d.score > 0);
  const mergedWallets = withWallet
    .filter((g) => g.uids.length > 1)
    .map((g) => ({ walletAddress: g.walletAddress, uids: g.uids, score: g.score }));

  const isFirstRun = previousSnapshot === null;

  // Rapport de base, commun à tous les cas de sortie. "plan" détaille, pour
  // chaque wallet, les uid regroupés, le delta brut et le score soumis : c'est
  // ce qui permet de vérifier les merges après coup.
  const report: Record<string, unknown> = {
    weekId,
    ranAt: new Date().toISOString(),
    dryRun: !!opts.dryRun,
    isFirstRun,
    eligiblePlayers: withWallet.length + missingWallet.length,
    plan: withWallet.map((g) => ({
      walletAddress: g.walletAddress,
      uids: g.uids,
      names: g.names,
      stats: g.stats,
      score: g.score,
    })),
    mergedWallets, // wallets dont plusieurs uid ont été additionnés (vide dans le cas normal)
    skippedNoWallet: missingWallet.map((d) => ({ uid: d.uid, name: d.name, stats: d.stats, score: d.score })),
  };

  if (opts.dryRun) return respond(env, weekId, report, false);

  // GARDE-FOU : finalize_pool est irréversible ET fund_pool refuse une pool
  // finalisée. Si on règle une pool non financée (totalPot = 0), elle devient
  // définitivement non financable et claim_scratch échoue pour tout le monde
  // (PayoutTooSmall). On s'arrête donc AVANT de soumettre/finaliser, sans
  // faire avancer le snapshot (sauf au tout premier run, pour poser la
  // baseline). Si la lecture on-chain elle-même échoue, on ne bloque pas.
  if (!opts.force && withWallet.length > 0) {
    let blockReason: string | null = null;
    try {
      const pool = await readPoolState(env, weekId);
      if (!pool) blockReason = "pool introuvable on-chain (jamais initialisée)";
      else if (pool.finalized) blockReason = "pool déjà finalisée";
      else if (pool.totalPot === 0n) blockReason = "pool non financée (totalPot = 0)";
    } catch (err) {
      console.error("[settlement] lecture de la pool impossible, garde-fou ignoré:", err);
    }
    if (blockReason) {
      if (isFirstRun) await saveSnapshot(env.WEEK_SNAPSHOT_KV, currentTotals);
      return respond(
        env,
        weekId,
        {
          ...report,
          aborted: true,
          abortReason: blockReason,
          hint:
            "Rien n'a été soumis ni finalisé. Finance la pool (/init-pool?weekId=" + weekId +
            "&amount=...) puis relance /run-settlement?weekId=" + weekId +
            " — ou ajoute &force=1 pour passer outre.",
          submitted: 0,
          failed: 0,
          snapshotAdvanced: isFirstRun,
        },
        true
      );
    }
  }

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

  // Le snapshot n'avance que si au moins une soumission a réussi (sinon un run
  // entièrement raté perdrait le delta de la semaine), ou au premier run (KV
  // jamais rempli : sans cette exception la baseline ne serait jamais posée).
  //
  // NOUVEAU : même quand il avance, il n'avance PAS pour les uid non payés :
  //  - wallet dont la soumission a échoué (les autres wallets ont réussi, mais
  //    celui-ci perdait sa semaine) ;
  //  - joueurs sans wallet (skippedNoWallet) : leurs victoires étaient perdues.
  // Leur delta reste dans le snapshot et sera repris au prochain règlement.
  const failedWallets = new Set(failed.map((r) => r.walletAddress));
  const holdBackUids = new Set<string>(missingWallet.map((d) => d.uid));
  for (const g of withWallet) {
    if (failedWallets.has(g.walletAddress)) for (const u of g.uids) holdBackUids.add(u);
  }

  const snapshotAdvanced = succeeded.length > 0 || isFirstRun;
  if (snapshotAdvanced) {
    await saveSnapshot(env.WEEK_SNAPSHOT_KV, holdBackTotals(currentTotals, previousSnapshot, holdBackUids));
  }

  return respond(
    env,
    weekId,
    {
      ...report,
      submitted: succeeded.length,
      failed: failed.length,
      failedDetails: failed,
      heldBackUids: [...holdBackUids], // uid dont le delta est reporté au prochain règlement
      snapshotAdvanced,
    },
    true
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
        .catch(async (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[settlement] crash:", msg);
          try {
            await env.WEEK_SNAPSHOT_KV.put(
              `settlement-log:${weekBeingSettled}:${new Date().toISOString()}`,
              JSON.stringify({ weekId: weekBeingSettled, crashed: msg }, null, 2)
            );
          } catch {
            /* rien de plus à faire */
          }
        })
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
      // ?dryRun=1 : plan seul, rien soumis. ?force=1 : ignore le garde-fou pool.
      return runWeeklySettlement(env, weekId, {
        dryRun: url.searchParams.get("dryRun") === "1",
        force: url.searchParams.get("force") === "1",
      });
    }

    // Relit les rapports de règlement conservés dans le KV (survivent aux logs Observability).
    if (url.pathname === "/last-settlement") {
      const weekId = url.searchParams.get("weekId");
      if (!weekId) return new Response("Paramètre weekId manquant (ex. ?weekId=2026-W40)", { status: 400 });
      const list = await env.WEEK_SNAPSHOT_KV.list({ prefix: `settlement-log:${weekId}:` });
      const logs = await Promise.all(
        list.keys.map(async (k) => ({
          key: k.name,
          report: JSON.parse((await env.WEEK_SNAPSHOT_KV.get(k.name)) ?? "null"),
        }))
      );
      return new Response(JSON.stringify({ weekId, count: logs.length, logs }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Lecture seule de l'état on-chain : pool (pot, vault, finalisée), score d'un
    // wallet (?wallet=...) ou de tous les wallets de la semaine (?all=1), avec le
    // montant que claim_scratch versera.
    if (url.pathname === "/inspect-pool") {
      const weekId = url.searchParams.get("weekId");
      if (!weekId) return new Response("Paramètre weekId manquant (ex. ?weekId=2026-W40)", { status: 400 });
      try {
        const out = await inspectPool(env, weekId, {
          wallet: url.searchParams.get("wallet") ?? undefined,
          all: url.searchParams.get("all") === "1",
        });
        return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(`inspect-pool: ${err instanceof Error ? err.message : String(err)}`, { status: 500 });
      }
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

    // DEBUG UNIQUEMENT — jamais appelé par le cron ni par l'app. Soumet un
    // score FIXE (pas calculé depuis Firebase) pour UN SEUL wallet/weekId,
    // via le même submitWeeklyScoresOnChain que le vrai règlement (donc
    // finalize_pool est aussi appelé automatiquement en cas de succès).
    // Sert à fabriquer de fausses semaines réclamables pour tester le
    // comportement du bouton RÉCLAMER (ex. plusieurs semaines d'affilée),
    // sans toucher au snapshot KV ni au calcul de delta réel — donc sans
    // effet de bord sur le vrai règlement des autres joueurs.
    // Requiert que la pool de ce weekId soit déjà initialisée (/init-pool)
    // et idéalement financée (sinon claim_scratch échoue côté client avec
    // PayoutTooSmall/EmptyPool).
    if (url.pathname === "/debug-submit-score") {
      const weekId = url.searchParams.get("weekId");
      const walletAddress = url.searchParams.get("wallet");
      const scoreRaw = url.searchParams.get("score");
      if (!weekId || !walletAddress || !scoreRaw) {
        return new Response(
          "Paramètres requis : weekId, wallet, score (ex. ?weekId=2026-W37&wallet=6pDn...&score=42)",
          { status: 400 }
        );
      }
      const score = Number(scoreRaw);
      if (!Number.isFinite(score) || score <= 0) {
        return new Response(`score invalide: "${scoreRaw}"`, { status: 400 });
      }
      const results = await submitWeeklyScoresOnChain(
        env.SOLANA_RPC_URL,
        env.SOLANA_PROGRAM_ID,
        env.SOLANA_AUTHORITY_SECRET_KEY,
        weekId,
        [{ walletAddress, score }]
      );
      return new Response(JSON.stringify(results, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
