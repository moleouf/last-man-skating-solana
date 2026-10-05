import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
// Même wallet minimal que solanaSubmit.ts (anchor.Wallet plante dans les Workers).
import { walletFromSecretKey } from "./solanaSubmit";
import idl from "./idl/lms_proof_of_play.json";
import type { Env } from "./index"; // import de TYPE uniquement : pas de dépendance circulaire

// Miroir exact des constantes de lib.rs (split 75 % proportionnel / 25 % équitable).
const PROPORTIONAL_SHARE_PCT = 75n;
const EQUAL_SHARE_PCT = 25n;

function setup(env: Env) {
  const connection = new Connection(env.SOLANA_RPC_URL, { commitment: "confirmed" });
  const wallet = walletFromSecretKey(env.SOLANA_AUTHORITY_SECRET_KEY);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new anchor.Program(idl as anchor.Idl, provider);
  const programId = new PublicKey(env.SOLANA_PROGRAM_ID);
  return { connection, program, programId };
}

export interface PoolState {
  weekId: string;
  address: string;
  mint: string;
  vault: string;
  totalScore: bigint;
  totalPot: bigint;
  eligibleCount: bigint;
  finalized: boolean;
  decimals: number;
  /** Solde réel du vault (null si illisible). Doit être >= totalPot. */
  vaultBalanceRaw: bigint | null;
}

/** Lit la WeeklyPool on-chain. Renvoie null si la pool n'existe pas. Lève en cas d'erreur RPC. */
export async function readPoolState(env: Env, weekId: string): Promise<PoolState | null> {
  const { connection, program, programId } = setup(env);
  const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from("pool"), Buffer.from(weekId)], programId);
  const acc = await (program.account as any).weeklyPool.fetchNullable(poolPda, "confirmed");
  if (!acc) return null;

  const mintInfo = await getMint(connection, acc.mint);
  let vaultBalanceRaw: bigint | null = null;
  try {
    const bal = await connection.getTokenAccountBalance(acc.vault, "confirmed");
    vaultBalanceRaw = BigInt(bal.value.amount);
  } catch {
    /* vault illisible : on laisse null */
  }

  return {
    weekId,
    address: poolPda.toBase58(),
    mint: acc.mint.toBase58(),
    vault: acc.vault.toBase58(),
    totalScore: BigInt(acc.totalScore.toString()),
    totalPot: BigInt(acc.totalPot.toString()),
    eligibleCount: BigInt(acc.eligibleCount.toString()),
    finalized: !!acc.finalized,
    decimals: mintInfo.decimals,
    vaultBalanceRaw,
  };
}

/** Réplique la formule de claim_scratch (lib.rs) pour savoir ce que le joueur recevra. */
function expectedPayoutRaw(pool: PoolState, score: bigint, eligible: boolean): bigint {
  if (pool.totalScore === 0n) return 0n;
  const proportionalPot = (pool.totalPot * PROPORTIONAL_SHARE_PCT) / 100n;
  const equalPot = (pool.totalPot * EQUAL_SHARE_PCT) / 100n;
  const proportional = (proportionalPot * score) / pool.totalScore;
  const equal = eligible && pool.eligibleCount > 0n ? equalPot / pool.eligibleCount : 0n;
  return proportional + equal;
}

export async function inspectPool(
  env: Env,
  weekId: string,
  opts: { wallet?: string; all?: boolean }
): Promise<Record<string, unknown>> {
  const { program, programId } = setup(env);
  const pool = await readPoolState(env, weekId);
  if (!pool) return { weekId, exists: false, diagnostics: ["Pool introuvable on-chain (jamais initialisée)."] };

  const fmt = (raw: bigint) => ({ raw: raw.toString(), ui: Number(raw) / 10 ** pool.decimals });

  const diagnostics: string[] = [];
  if (pool.totalPot === 0n) {
    diagnostics.push(
      "totalPot = 0 : pool NON financée. Si elle est finalisée, fund_pool est refusé (PoolAlreadyFinalized) et claim_scratch échoue (PayoutTooSmall) pour tout le monde."
    );
  }
  if (pool.vaultBalanceRaw !== null && pool.vaultBalanceRaw < pool.totalPot) {
    diagnostics.push("Le solde réel du vault est inférieur à totalPot : les derniers claims échoueront.");
  }
  if (!pool.finalized) diagnostics.push("Pool non finalisée : claim_scratch impossible (PoolNotFinalized).");
  if (pool.totalScore === 0n) diagnostics.push("totalScore = 0 : aucun score enregistré (EmptyPool au claim).");

  const out: Record<string, unknown> = {
    weekId,
    exists: true,
    pool: {
      address: pool.address,
      finalized: pool.finalized,
      totalScore: pool.totalScore.toString(),
      eligibleCount: pool.eligibleCount.toString(),
      totalPot: fmt(pool.totalPot),
      vaultBalance: pool.vaultBalanceRaw === null ? null : fmt(pool.vaultBalanceRaw),
    },
    diagnostics,
  };

  if (opts.wallet) {
    const playerPk = new PublicKey(opts.wallet);
    const [scorePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("player_score"), Buffer.from(weekId), playerPk.toBuffer()],
      programId
    );
    const ps = await (program.account as any).playerScore.fetchNullable(scorePda, "confirmed");
    out.player = ps
      ? {
          wallet: opts.wallet,
          score: ps.score.toString(),
          eligible: !!ps.eligible,
          claimed: !!ps.claimed,
          expectedPayout: fmt(expectedPayoutRaw(pool, BigInt(ps.score.toString()), !!ps.eligible)),
        }
      : { wallet: opts.wallet, found: false, note: "Aucun score soumis pour ce wallet cette semaine-là." };
  }

  if (opts.all) {
    try {
      const all = await (program.account as any).playerScore.all();
      const rows = all
        .filter((a: any) => a.account.weekId === weekId)
        .map((a: any) => {
          const score = BigInt(a.account.score.toString());
          const eligible = !!a.account.eligible;
          return {
            player: a.account.player.toBase58(),
            score: score.toString(),
            eligible,
            claimed: !!a.account.claimed,
            expectedPayout: fmt(expectedPayoutRaw(pool, score, eligible)),
          };
        })
        .sort((x: any, y: any) => Number(BigInt(y.score) - BigInt(x.score)));
      const sum = rows.reduce((acc: bigint, r: any) => acc + BigInt(r.score), 0n);
      out.players = rows;
      out.sumOfPlayerScores = sum.toString();
      if (sum !== pool.totalScore) {
        diagnostics.push(`Somme des scores des joueurs (${sum}) différente de pool.totalScore (${pool.totalScore}).`);
      }
    } catch (err) {
      out.playersError = err instanceof Error ? err.message : String(err);
    }
  }

  return out;
}
