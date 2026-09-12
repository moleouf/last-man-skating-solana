import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
// Copie ton IDL exporté depuis Solana Playground (bouton "Export IDL" ou
// target/idl/lms_proof_of_play.json) dans src/idl/lms_proof_of_play.json
import idl from "./idl/lms_proof_of_play.json";

/**
 * Wallet minimal compatible AnchorProvider, construit depuis une clé secrète.
 *
 * CORRIGÉ : `new anchor.Wallet(keypair)` plante dans l'environnement
 * Cloudflare Workers ("(void 0) is not a constructor") — le bundling de
 * @coral-xyz/anchor par Wrangler ne résout pas correctement cet export
 * précis (les autres, AnchorProvider/Program/BN, passent bien). La classe
 * anchor.Wallet est triviale (publicKey + 2 méthodes de signature) donc on
 * la réimplémente à la main plutôt que de dépendre de cet export cassé.
 */
function walletFromSecretKey(secretKeyBase58: string) {
  const keypair = Keypair.fromSecretKey(bs58.decode(secretKeyBase58));
  return {
    publicKey: keypair.publicKey,
    payer: keypair,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      if (tx instanceof VersionedTransaction) {
        tx.sign([keypair]);
      } else {
        tx.partialSign(keypair);
      }
      return tx;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
      for (const tx of txs) {
        if (tx instanceof VersionedTransaction) {
          tx.sign([keypair]);
        } else {
          tx.partialSign(keypair);
        }
      }
      return txs;
    },
  };
}

export interface PlayerScoreInput {
  walletAddress: string;
  score: number;
}

export interface SubmitResult {
  walletAddress: string;
  score: number;
  signature?: string;
  error?: string;
}

/**
 * Soumet le score de chaque joueur (submit_score), puis finalise la cagnotte
 * (finalize_pool) une fois tous les scores envoyés.
 *
 * Les échecs individuels n'interrompent pas la boucle — un joueur en erreur
 * ne doit pas bloquer les autres. La liste des erreurs est retournée pour
 * logging/alerte, à toi de décider si tu relances manuellement pour ceux en échec.
 */
export async function submitWeeklyScoresOnChain(
  rpcUrl: string,
  programIdStr: string,
  authoritySecretKeyBase58: string,
  weekId: string,
  players: PlayerScoreInput[]
): Promise<SubmitResult[]> {
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = walletFromSecretKey(authoritySecretKeyBase58);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const programId = new PublicKey(programIdStr); // toujours utile plus bas pour les PDA
  // Anchor 0.30+ : signature (idl, provider) — plus de programId en 2e argument.
  // L'adresse doit venir du champ "address" au niveau racine du JSON de
  // l'IDL (format nouveau spec 0.30+, celui exporté par défaut par Solana
  // Playground/anchor build aujourd'hui). Si ton idl.json vient d'une
  // ancienne version d'Anchor et n'a pas ce champ "address", régénère-le ou
  // convertis-le avec `anchor idl convert`.
  const program = new anchor.Program(idl as anchor.Idl, provider);

  const [weeklyPoolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.from(weekId)],
    programId
  );

  const results: SubmitResult[] = [];

  for (const p of players) {
    try {
      const playerPubkey = new PublicKey(p.walletAddress);
      const [playerScorePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("player_score"), Buffer.from(weekId), playerPubkey.toBuffer()],
        programId
      );

      const sig = await program.methods
        .submitScore(weekId, new anchor.BN(p.score))
        .accounts({
          authority: wallet.publicKey,
          player: playerPubkey,
          weeklyPool: weeklyPoolPda,
          playerScore: playerScorePda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

      results.push({ walletAddress: p.walletAddress, score: p.score, signature: sig });
    } catch (err) {
      results.push({
        walletAddress: p.walletAddress,
        score: p.score,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Finalise seulement si au moins un score a été soumis avec succès
  if (results.some((r) => r.signature)) {
    await program.methods
      .finalizePool(weekId)
      .accounts({ authority: wallet.publicKey, weeklyPool: weeklyPoolPda })
      .rpc({ commitment: "confirmed" });
  }

  return results;
}
