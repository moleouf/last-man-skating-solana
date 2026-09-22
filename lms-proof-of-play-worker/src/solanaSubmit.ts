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
export function walletFromSecretKey(secretKeyBase58: string) {
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
// v3 (22/09/2026) : sorti de submitWeeklyScoresOnChain pour être réutilisable
// depuis poolLifecycle.ts (initializeWeeklyPool/fundPool ont exactement le
// même problème de timeout mal classé que submitScore/finalizePool ici).
// web3.js inclut la signature dans le message d'erreur de timeout
// ("...Check signature <sig> using the Solana Explorer...") : on l'extrait
// et on vérifie l'état réel avant de conclure à un échec.
export async function resolveTimeoutSignature(connection: Connection, errMsg: string): Promise<string | null> {
  const match = errMsg.match(/signature ([1-9A-HJ-NP-Za-km-z]{32,88})/);
  if (!match) return null;
  try {
    const status = await connection.getSignatureStatus(match[1], { searchTransactionHistory: true });
    const confirmed =
      status.value &&
      !status.value.err &&
      (status.value.confirmationStatus === "confirmed" || status.value.confirmationStatus === "finalized");
    return confirmed ? match[1] : null;
  } catch {
    return null; // vérification elle-même en échec -> on ne peut pas confirmer, reste classé "failed" plus bas
  }
}

export async function submitWeeklyScoresOnChain(
  rpcUrl: string,
  programIdStr: string,
  authoritySecretKeyBase58: string,
  weekId: string,
  players: PlayerScoreInput[]
): Promise<SubmitResult[]> {
  // Timeout de confirmation augmenté à 60s (défaut 30s) — un RPC plus lent
  // (ou devnet congestionné) peut dépasser 30s pour confirmer alors que la
  // transaction a bien été acceptée on-chain (constaté en test : succès
  // confirmé sur Solana Explorer malgré un timeout à 30s côté client).
  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  });
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
      const msg = err instanceof Error ? err.message : String(err);
      const confirmedSig = await resolveTimeoutSignature(connection, msg);
      if (confirmedSig) {
        results.push({ walletAddress: p.walletAddress, score: p.score, signature: confirmedSig });
      } else {
        results.push({ walletAddress: p.walletAddress, score: p.score, error: msg });
      }
    }
  }

  // Finalise seulement si au moins un score a été soumis avec succès
  if (results.some((r) => r.signature)) {
    try {
      await program.methods
        .finalizePool(weekId)
        .accounts({ authority: wallet.publicKey, weeklyPool: weeklyPoolPda })
        .rpc({ commitment: "confirmed" });
    } catch (err) {
      // v3 (22/09/2026) : même classe de bug que submitScore ci-dessus, sur
      // finalizePool cette fois — un timeout de confirmation ici plantait
      // toute la requête (throw non attrapé -> 500 générique côté worker au
      // lieu du JSON de résultat), alors que la tx avait pu réussir quand
      // même. Même vérification via la signature avant de vraiment logger
      // un échec ; dans tous les cas on NE relance PAS l'exception, pour
      // que runWeeklySettlement() puisse quand même renvoyer le détail
      // des soumissions de score (qui, elles, ont réussi).
      const msg = err instanceof Error ? err.message : String(err);
      const confirmedSig = await resolveTimeoutSignature(connection, msg);
      if (confirmedSig) {
        console.log("[finalizePool] confirmé malgré le timeout, signature:", confirmedSig);
      } else {
        console.error("[finalizePool] échec réel:", msg);
      }
    }
  }

  return results;
}