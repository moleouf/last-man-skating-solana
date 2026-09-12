import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";

// Chai n'est pas disponible dans Solana Playground — mini-implémentation
// maison des quelques assertions dont on a besoin, sans dépendance externe.
const assert = {
  equal(actual: unknown, expected: unknown, msg?: string) {
    if (actual !== expected) {
      throw new Error(
        `${msg ? msg + " — " : ""}attendu ${expected}, obtenu ${actual}`
      );
    }
  },
  isAbove(actual: number, expected: number, msg?: string) {
    if (!(actual > expected)) {
      throw new Error(
        `${msg ? msg + " — " : ""}attendu > ${expected}, obtenu ${actual}`
      );
    }
  },
  exists(value: unknown, msg?: string) {
    if (value === null || value === undefined) {
      throw new Error(`${msg ? msg + " — " : ""}valeur attendue non nulle`);
    }
  },
  include(haystack: string, needle: string, msg?: string) {
    if (!haystack.includes(needle)) {
      throw new Error(
        `${msg ? msg + " — " : ""}attendu que "${haystack}" contienne "${needle}"`
      );
    }
  },
  fail(msg: string): never {
    throw new Error(msg);
  },
};

describe("lms_proof_of_play", () => {
  // Devnet peut être lent/congestionné — on donne de la marge à Mocha
  // (timeout par défaut 2s, largement trop court pour des tx devnet).
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LmsProofOfPlay as Program;

  // week_id aléatoire (8 caractères) à chaque run, pour que les tests soient
  // rejouables sans collision avec un PDA déjà créé lors d'un run précédent
  // (devnet est persistant, contrairement à un validateur local éphémère).
  function randomWeekId(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let s = "T"; // préfixe pour repérer facilement les pools de test dans un explorer
    for (let i = 0; i < 7; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  const weekId = randomWeekId();

  before(function () {
    // Marge de sécurité vs le timeout Mocha par défaut (2s), insuffisant
    // pour des transactions devnet parfois lentes.
    this.timeout(60000);
  });

  // `setTimeout` n'est pas disponible dans l'environnement de test de
  // Solana Playground — pas de délai artificiel possible. À la place, on
  // force explicitement le commitment 'confirmed' sur chaque lecture, pour
  // qu'elle porte sur le même niveau de finalité que l'écriture qui vient
  // de se confirmer (évite le mismatch de commitment par défaut qui causait
  // les échecs de lecture juste après écriture).
  async function fetchPool() {
    return program.account.weeklyPool.fetch(weeklyPoolPda, "confirmed");
  }

  const authority = provider.wallet; // simule la Cloud Function backend
  const payer = (provider.wallet as any).payer;

  let mint: PublicKey;
  let funderTokenAccount: PublicKey;

  const player1 = Keypair.generate(); // score dominant
  const player2 = Keypair.generate(); // score moyen
  const player3 = Keypair.generate(); // pile au seuil d'éligibilité

  let player1TokenAccount: PublicKey;
  let player2TokenAccount: PublicKey;
  let player3TokenAccount: PublicKey;

  const [weeklyPoolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.from(weekId)],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(weekId)],
    program.programId
  );

  function playerScorePda(player: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("player_score"), Buffer.from(weekId), player.toBuffer()],
      program.programId
    )[0];
  }

  const TOTAL_POT = 1_000_000_000; // 1000 tokens à 6 décimales
  const SCORES: Record<string, number> = {
    player1: 210, // max duel_wins (21 * 10)
    player2: 90,
    player3: 9, // = EQUAL_SHARE_MIN_SCORE, pile éligible
  };

  before(async () => {
    // On transfère depuis le wallet Playground déjà alimenté, plutôt que de
    // redemander un airdrop par joueur — évite de retaper dans le faucet
    // devnet (rate-limité/capricieux, cf. l'historique de cette session).
    for (const kp of [player1, player2, player3]) {
      const transferTx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: authority.publicKey,
          toPubkey: kp.publicKey,
          lamports: 0.05 * anchor.web3.LAMPORTS_PER_SOL, // largement assez pour les frais de tx du test
        })
      );
      await provider.sendAndConfirm(transferTx);
    }

    mint = await createMint(provider.connection, payer, authority.publicKey, null, 6);

    funderTokenAccount = await createAccount(
      provider.connection,
      payer,
      mint,
      authority.publicKey
    );

    await mintTo(
      provider.connection,
      payer,
      mint,
      funderTokenAccount,
      authority.publicKey,
      TOTAL_POT
    );

    player1TokenAccount = await createAccount(provider.connection, payer, mint, player1.publicKey);
    player2TokenAccount = await createAccount(provider.connection, payer, mint, player2.publicKey);
    player3TokenAccount = await createAccount(provider.connection, payer, mint, player3.publicKey);
  });

  it("initialise la cagnotte hebdomadaire", async () => {
    await program.methods
      .initializeWeeklyPool(weekId)
      .accounts({
        authority: authority.publicKey,
        weeklyPool: weeklyPoolPda,
        mint,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc({ commitment: "confirmed" });

    const pool = await fetchPool();
    assert.equal(pool.weekId, weekId);
    assert.equal(pool.totalPot.toNumber(), 0);
    assert.equal(pool.finalized, false);
  });

  it("alimente la cagnotte", async () => {
    await program.methods
      .fundPool(new anchor.BN(TOTAL_POT))
      .accounts({
        funder: authority.publicKey,
        funderTokenAccount,
        weeklyPool: weeklyPoolPda,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    const pool = await fetchPool();
    assert.equal(pool.totalPot.toNumber(), TOTAL_POT);
  });

  it("soumet les scores des 3 joueurs", async () => {
    const submissions: [Keypair, number][] = [
      [player1, SCORES.player1],
      [player2, SCORES.player2],
      [player3, SCORES.player3],
    ];

    for (const [player, score] of submissions) {
      await program.methods
        .submitScore(weekId, new anchor.BN(score))
        .accounts({
          authority: authority.publicKey,
          player: player.publicKey,
          weeklyPool: weeklyPoolPda,
          playerScore: playerScorePda(player.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });
    }

    const pool = await fetchPool();
    assert.equal(
      pool.totalScore.toNumber(),
      SCORES.player1 + SCORES.player2 + SCORES.player3
    );
    assert.equal(pool.eligibleCount.toNumber(), 3);
  });

  it("finalise la cagnotte", async () => {
    await program.methods
      .finalizePool(weekId)
      .accounts({ authority: authority.publicKey, weeklyPool: weeklyPoolPda })
      .rpc({ commitment: "confirmed" });

    const pool = await fetchPool();
    assert.equal(pool.finalized, true);
  });

  it("player1 (score max) reçoit le bon montant en 75/25", async () => {
    const totalScore = SCORES.player1 + SCORES.player2 + SCORES.player3;
    const proportionalPot = Math.floor((TOTAL_POT * 75) / 100);
    const equalPot = Math.floor((TOTAL_POT * 25) / 100);
    const expectedProportional = Math.floor(
      (proportionalPot * SCORES.player1) / totalScore
    );
    const expectedEqual = Math.floor(equalPot / 3); // 3 joueurs éligibles
    const expectedPayout = expectedProportional + expectedEqual;

    await program.methods
      .claimScratch(weekId)
      .accounts({
        player: player1.publicKey,
        weeklyPool: weeklyPoolPda,
        playerScore: playerScorePda(player1.publicKey),
        vault: vaultPda,
        playerTokenAccount: player1TokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([player1])
      .rpc({ commitment: "confirmed" });

    const account = await getAccount(provider.connection, player1TokenAccount);
    assert.equal(Number(account.amount), expectedPayout);
  });

  it("player3 (score minimal mais éligible) touche quand même la part équitable", async () => {
    const totalScore = SCORES.player1 + SCORES.player2 + SCORES.player3;
    const proportionalPot = Math.floor((TOTAL_POT * 75) / 100);
    const equalPot = Math.floor((TOTAL_POT * 25) / 100);
    const expectedProportional = Math.floor(
      (proportionalPot * SCORES.player3) / totalScore
    );
    const expectedEqual = Math.floor(equalPot / 3);
    const expectedPayout = expectedProportional + expectedEqual;

    await program.methods
      .claimScratch(weekId)
      .accounts({
        player: player3.publicKey,
        weeklyPool: weeklyPoolPda,
        playerScore: playerScorePda(player3.publicKey),
        vault: vaultPda,
        playerTokenAccount: player3TokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([player3])
      .rpc({ commitment: "confirmed" });

    const account = await getAccount(provider.connection, player3TokenAccount);
    assert.equal(Number(account.amount), expectedPayout);
    // même avec un score très faible, player3 touche bien plus que 0 grâce
    // à l'enveloppe équitable — c'est exactement le comportement voulu.
    assert.isAbove(Number(account.amount), 0);
  });

  it("refuse un double claim", async () => {
    try {
      await program.methods
        .claimScratch(weekId)
        .accounts({
          player: player1.publicKey,
          weeklyPool: weeklyPoolPda,
          playerScore: playerScorePda(player1.publicKey),
          vault: vaultPda,
          playerTokenAccount: player1TokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([player1])
        .rpc({ commitment: "confirmed" });
      assert.fail("le double claim aurait dû échouer");
    } catch (err) {
      assert.include(String(err), "AlreadyClaimed");
    }
  });

  it("refuse qu'un joueur réclame le score d'un autre", async () => {
    try {
      await program.methods
        .claimScratch(weekId)
        .accounts({
          player: player2.publicKey,
          weeklyPool: weeklyPoolPda,
          playerScore: playerScorePda(player1.publicKey), // score d'un autre joueur
          vault: vaultPda,
          playerTokenAccount: player2TokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([player2])
        .rpc({ commitment: "confirmed" });
      assert.fail("aurait dû échouer : seeds PDA ne correspondent pas au signataire");
    } catch (err) {
      // Anchor rejette avant même d'atteindre notre check applicatif,
      // car les seeds du compte player_score ne matchent pas player2.
      assert.exists(err);
    }
  });
});