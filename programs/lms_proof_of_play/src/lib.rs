// programs/lms_proof_of_play/src/lib.rs
//
// Squelette Anchor pour la distribution "Proof of Play" de Last Man Skating.
// Pas de mise, pas de hasard côté chaîne : ce programme distribue une cagnotte
// hebdomadaire (SPL token SKR) proportionnellement à un score déjà validé
// off-chain (Cloud Functions) et soumis par une autorité backend de confiance.
//
//
// Flux :
//   1. initialize_weekly_pool  -> ouvre la cagnotte de la semaine (PDA), crée
//      le vault SPL qui la détient.
//   2. fund_pool               -> optionnel, permet d'alimenter la cagnotte
//      (tips, treasury du protocole, etc.) avant/à pendant la semaine.
//   3. submit_score            -> appelé UNIQUEMENT par l'autorité backend
//      (la clé de signature de ta Cloud Function), après qu'elle a validé la
//      cohérence d'un match côté Firebase. Incrémente/écrase le score du
//      joueur pour la semaine + le total de la pool.
//   4. finalize_pool           -> l'autorité backend clôture la semaine :
//      plus aucun submit_score possible, total_score figé.
//   5. claim_scratch           -> le joueur (signataire) réclame sa part :
//      payout = total_pot * son_score / total_score. Transfert SPL direct,
//      marque claimed = true (anti double-claim).
//
// Sécurité clé : le programme ne peut PAS juger de la légitimité d'un match
// lui-même — il fait confiance à `authority` (ta Cloud Function). C'est elle
// qui porte la responsabilité anti-spoof, pas le contrat on-chain.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};
use borsh::BorshSerialize;

// Adresse du programme Metaplex Core — identique mainnet ET devnet, adresse
// fixe (confirmée sur plusieurs sources officielles Metaplex).
pub const MPL_CORE_ID: Pubkey = anchor_lang::solana_program::pubkey!(
    "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
);

// Construit à la main l'instruction CreateV1 de Metaplex Core, SANS
// dépendre du crate mpl-core (indisponible dans Solana Playground — liste
// fermée de crates côté serveur, mpl-core n'y figure pas). On ne crée
// jamais de Collection ni de plugins ici, donc CreateV1 (pas V2) suffit et
// reste la version la plus simple à reproduire à la main.
//
// Format du discriminant + arguments (vérifié dans le code source généré
// du crate mpl-core, pas deviné) :
//   [0] discriminant CreateV1 = 0u8
//   [1] DataState — un seul octet ; AccountState = premier variant = 0.
//       CONFIRMÉ EMPIRIQUEMENT sur devnet : le programme a bien reconnu
//       l'instruction et parsé les arguments (log "Instruction: Create"
//       suivi d'une erreur de comptes, pas de désérialisation) — la valeur
//       0 est donc correcte.
//   [2] name   — String Borsh (u32 LE longueur + bytes UTF-8)
//   [3] uri    — String Borsh (idem)
//   [4] plugins — Option<Vec<..>> = None ici = un seul octet 0
//
// Comptes, dans cet ordre exact (reproduit du code source généré) :
//   asset (writable, signer) | collection (placeholder si absent) |
//   authority (placeholder si absent) | payer (writable, signer) |
//   owner (readonly) | update_authority (placeholder si absent) |
//   system_program (readonly) | log_wrapper (placeholder si absent)
// CONFIRMÉ EMPIRIQUEMENT sur devnet (voir historique) : `log_wrapper` n'est
// PAS omissible malgré son caractère "optionnel" — le programme Core exige
// bien 8 comptes, pas 7. Sans lui : erreur runtime "insufficient account
// keys for instruction". Il suit la même convention de placeholder
// (MPL_CORE_ID, readonly, non-signataire) que les 3 autres comptes
// optionnels absents.
fn build_create_v1_instruction(
    asset: &Pubkey,
    payer: &Pubkey,
    owner: &Pubkey,
    name: String,
    uri: String,
) -> Result<Instruction> {
    let accounts = vec![
        AccountMeta::new(*asset, true),
        AccountMeta::new_readonly(MPL_CORE_ID, false), // collection: absent
        AccountMeta::new_readonly(MPL_CORE_ID, false), // authority: absent
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(*owner, false),
        AccountMeta::new_readonly(MPL_CORE_ID, false), // update_authority: absent
        AccountMeta::new_readonly(anchor_lang::solana_program::system_program::ID, false),
        AccountMeta::new_readonly(MPL_CORE_ID, false), // log_wrapper: absent — CONFIRMÉ requis (8 comptes, pas 7)
    ];

    let mut data = Vec::new();
    data.push(0u8); // discriminant CreateV1
    data.push(0u8); // DataState::AccountState (voir doc ci-dessus)
    name.serialize(&mut data)
        .map_err(|_| error!(PoolError::MathOverflow))?;
    uri.serialize(&mut data)
        .map_err(|_| error!(PoolError::MathOverflow))?;
    data.push(0u8); // plugins: None

    Ok(Instruction {
        program_id: MPL_CORE_ID,
        accounts,
        data,
    })
}

declare_id!("GQeKyxHQGFv46z8hM5KocYa5hrUSea1hYJrDXyH41caH");

// Doit correspondre au format `weekKey` déjà utilisé côté client
// (`YYYY-Www`, ex. "2026-W37"). Longueur fixe pour rester simple en seeds.
pub const WEEK_ID_LEN: usize = 8;

// Split de la cagnotte : 75% proportionnel au score, 25% partagé également
// entre tous les joueurs ayant atteint le seuil d'éligibilité minimal.
pub const PROPORTIONAL_SHARE_PCT: u128 = 75;
pub const EQUAL_SHARE_PCT: u128 = 25;

// Seuil minimal de score pour toucher une part de l'enveloppe "équitable"
// (ex. ~3 missions complétées ou une activité compétitive minimale dans la
// semaine). À ajuster une fois la formule de score finale calée côté
// Cloud Function.
pub const EQUAL_SHARE_MIN_SCORE: u64 = 9;

// Sanctuaire Seeker (mode Proximité) — plafonds de rareté par tier. Un vrai
// NFT = 0 décimales + supply=1 sur SON PROPRE mint (Metaplex Core) ; la
// "rareté" ne peut donc pas être un supply sur un seul mint (ça deviendrait
// fongible) — elle est appliquée ici via un compteur PDA incrémenté et
// plafonné à chaque mint, même logique que l'anti-double-claim de
// `claim_scratch` ci-dessous.
pub const CLASSIC_TIER_CAP: u64 = 10_000;
pub const PREMIUM_TIER_CAP: u64 = 1_000;

#[program]
pub mod lms_proof_of_play {
    use super::*;

    pub fn initialize_weekly_pool(
        ctx: Context<InitializeWeeklyPool>,
        week_id: String,
    ) -> Result<()> {
        require!(week_id.len() <= WEEK_ID_LEN, PoolError::WeekIdTooLong);

        let pool = &mut ctx.accounts.weekly_pool;
        pool.authority = ctx.accounts.authority.key();
        pool.mint = ctx.accounts.mint.key();
        pool.vault = ctx.accounts.vault.key();
        pool.week_id = week_id;
        pool.total_score = 0;
        pool.total_pot = 0;
        pool.eligible_count = 0;
        pool.finalized = false;
        pool.bump = ctx.bumps.weekly_pool;

        Ok(())
    }

    pub fn fund_pool(ctx: Context<FundPool>, amount: u64) -> Result<()> {
        let pool = &mut ctx.accounts.weekly_pool;
        require!(!pool.finalized, PoolError::PoolAlreadyFinalized);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.funder_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
        )?;

        pool.total_pot = pool
            .total_pot
            .checked_add(amount)
            .ok_or(PoolError::MathOverflow)?;

        Ok(())
    }

    // Appelé par l'autorité backend (Cloud Function) après validation d'un
    // match. `new_score` est le score CUMULÉ du joueur pour la semaine
    // (pas un delta) — plus simple à raisonner côté client Cloud Function :
    // elle recalcule le total et l'écrase.
    pub fn submit_score(
        ctx: Context<SubmitScore>,
        _week_id: String,
        new_score: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.weekly_pool;
        require!(!pool.finalized, PoolError::PoolAlreadyFinalized);
        require_keys_eq!(
            ctx.accounts.authority.key(),
            pool.authority,
            PoolError::UnauthorizedAuthority
        );

        let player_score = &mut ctx.accounts.player_score;
        let previous = player_score.score;

        // Ajuste le total de la pool par le delta (score écrasé, pas cumulé
        // en plus de l'ancien).
        if new_score >= previous {
            pool.total_score = pool
                .total_score
                .checked_add(new_score - previous)
                .ok_or(PoolError::MathOverflow)?;
        } else {
            pool.total_score = pool
                .total_score
                .checked_sub(previous - new_score)
                .ok_or(PoolError::MathOverflow)?;
        }

        // Bascule dans/hors de l'enveloppe "équitable" selon le seuil.
        let was_eligible = player_score.eligible;
        let is_eligible = new_score >= EQUAL_SHARE_MIN_SCORE;
        if is_eligible && !was_eligible {
            pool.eligible_count = pool
                .eligible_count
                .checked_add(1)
                .ok_or(PoolError::MathOverflow)?;
        } else if !is_eligible && was_eligible {
            pool.eligible_count = pool
                .eligible_count
                .checked_sub(1)
                .ok_or(PoolError::MathOverflow)?;
        }

        player_score.player = ctx.accounts.player.key();
        player_score.week_id = pool.week_id.clone();
        player_score.score = new_score;
        player_score.eligible = is_eligible;
        player_score.bump = ctx.bumps.player_score;

        Ok(())
    }

    pub fn finalize_pool(ctx: Context<FinalizePool>, _week_id: String) -> Result<()> {
        let pool = &mut ctx.accounts.weekly_pool;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            pool.authority,
            PoolError::UnauthorizedAuthority
        );
        require!(!pool.finalized, PoolError::PoolAlreadyFinalized);

        pool.finalized = true;
        Ok(())
    }

    pub fn claim_scratch(ctx: Context<ClaimScratch>, _week_id: String) -> Result<()> {
        let pool = &ctx.accounts.weekly_pool;
        let player_score = &mut ctx.accounts.player_score;

        require!(pool.finalized, PoolError::PoolNotFinalized);
        require!(!player_score.claimed, PoolError::AlreadyClaimed);
        require!(pool.total_score > 0, PoolError::EmptyPool);
        require_keys_eq!(
            player_score.player,
            ctx.accounts.player.key(),
            PoolError::UnauthorizedClaimant
        );

        // Split 75/25 : enveloppe proportionnelle au score + enveloppe
        // équitable partagée entre tous les joueurs éligibles. Le calcul se
        // fait en u128 pour éviter l'overflow sur les multiplications
        // intermédiaires ; le reliquat d'arrondi de la part équitable reste
        // dans le vault (pas de perte de fonds, juste de la poussière non
        // réclamée qui pourra être recyclée par l'autorité sur une future
        // semaine si besoin).
        let total_pot = pool.total_pot as u128;
        let proportional_pot = total_pot
            .checked_mul(PROPORTIONAL_SHARE_PCT)
            .ok_or(PoolError::MathOverflow)?
            .checked_div(100)
            .ok_or(PoolError::MathOverflow)?;
        let equal_pot = total_pot
            .checked_mul(EQUAL_SHARE_PCT)
            .ok_or(PoolError::MathOverflow)?
            .checked_div(100)
            .ok_or(PoolError::MathOverflow)?;

        let proportional_share = proportional_pot
            .checked_mul(player_score.score as u128)
            .ok_or(PoolError::MathOverflow)?
            .checked_div(pool.total_score as u128)
            .ok_or(PoolError::MathOverflow)?;

        let equal_share: u128 = if player_score.eligible {
            require!(pool.eligible_count > 0, PoolError::EmptyPool);
            equal_pot
                .checked_div(pool.eligible_count as u128)
                .ok_or(PoolError::MathOverflow)?
        } else {
            0
        };

        let payout: u64 = proportional_share
            .checked_add(equal_share)
            .ok_or(PoolError::MathOverflow)?
            .try_into()
            .map_err(|_| PoolError::MathOverflow)?;

        require!(payout > 0, PoolError::PayoutTooSmall);

        let week_id_bytes = pool.week_id.as_bytes();
        let seeds: &[&[u8]] = &[b"pool", week_id_bytes, &[pool.bump]];
        let signer_seeds = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.player_token_account.to_account_info(),
                    authority: ctx.accounts.weekly_pool.to_account_info(),
                },
                signer_seeds,
            ),
            payout,
        )?;

        player_score.claimed = true;
        Ok(())
    }

    // Sanctuaire Seeker (mode Proximité) — appelé une fois au déploiement, avant
    // tout mint. Compteur PDA singleton, pas de week_id : la rareté est globale
    // au programme, pas hebdomadaire comme la cagnotte.
    pub fn initialize_mint_counter(ctx: Context<InitializeMintCounter>) -> Result<()> {
        let counter = &mut ctx.accounts.mint_counter;
        counter.classic_minted_count = 0;
        counter.premium_minted_count = 0;
        counter.bump = ctx.bumps.mint_counter;
        Ok(())
    }

    // Fin de match du mode Proximité : co-signature des deux wallets qui se
    // sont rencontrés IRL (détection Nearby Connections côté client, voir
    // NearbyProximityPlugin.kt) + mint ATOMIQUE des deux NFT Metaplex Core
    // "Sanctuaire Seeker" (un pour player_a, un pour player_b) dans le MÊME
    // appel d'instruction — pas deux appels séparés. Ça élimine par
    // construction le risque de owner erroné ou de double-mint pour le même
    // joueur : soit les deux CPI réussissent, soit toute la transaction
    // échoue (aucun état intermédiaire possible sur Solana).
    //
    // `is_premium` est fourni par le client (ET logique des
    // isSeedVaultAvailable() locaux des deux joueurs) : le programme ne
    // peut pas vérifier du matériel Seeker lui-même, il fait confiance à
    // cette valeur déclarée du même titre que `submit_score` fait confiance
    // à `authority` — même classe de compromis que celui déjà documenté dans
    // le README pour duelStats/ffaStats, assumé pour la deadline du
    // hackathon. L'event `MeetingNftMinted` ci-dessous laisse une trace
    // on-chain auditable (pubkeys + tiers déclarés) pour compenser
    // partiellement l'absence de preuve hardware vérifiable.
    //
    // Pas de vérification on-chain que les NFT d'un joueur viennent de
    // devices DIFFÉRENTS (condition du skin cosmétique "Seeker Squad") —
    // volontairement laissé au client/off-chain (comparaison des `owner`
    // successifs), pour ne pas complexifier ce programme avant la deadline.
    //
    // Anti double-mint : `player_mint_record_a`/`_b` sont des PDA créés en
    // `init` (voir Contexts ci-dessous) — si un des deux joueurs a déjà
    // minté son Sanctuaire Seeker, `init` échoue tout seul ("already in
    // use") avant même d'atteindre le corps de la fonction. Un joueur ne
    // peut donc jamais recevoir ce NFT deux fois, quel que soit le nombre
    // de rencontres qu'il enchaîne.
    //
    // `is_premium` est UNIQUE pour la rencontre (pas un bool par joueur) :
    // le tier est déterminé par l'état de la PAIRE, pas de chaque joueur
    // individuellement — PREMIUM seulement si les DEUX ont Seed Vault,
    // sinon les deux reçoivent le tier classic. Un tier différent par
    // joueur pour une même rencontre n'a pas de sens ici.
    pub fn mint_meeting_nft(
        ctx: Context<MintMeetingNft>,
        is_premium: bool,
        name_a: String,
        uri_a: String,
        name_b: String,
        uri_b: String,
    ) -> Result<()> {
        require_keys_neq!(
            ctx.accounts.player_a.key(),
            ctx.accounts.player_b.key(),
            PoolError::SamePlayerMeetingItself
        );

        // Le tier (commun aux deux joueurs) est validé et incrémenté deux
        // fois AVANT tout CPI de mint : si le tier est épuisé (même pour un
        // seul des deux "slots"), la transaction échoue avant même que le
        // premier NFT ne soit créé — pas de mint à moitié.
        {
            let counter = &mut ctx.accounts.mint_counter;
            increment_tier_count(counter, is_premium)?;
            increment_tier_count(counter, is_premium)?;
        }

        let ix_a = build_create_v1_instruction(
            &ctx.accounts.asset_a.key(),
            &ctx.accounts.payer.key(),
            &ctx.accounts.player_a.key(),
            name_a,
            uri_a,
        )?;
        invoke(
            &ix_a,
            &[
                ctx.accounts.asset_a.to_account_info(),
                ctx.accounts.mpl_core_program.to_account_info(), // couvre aussi les 3 placeholders (même pubkey)
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.player_a.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let ix_b = build_create_v1_instruction(
            &ctx.accounts.asset_b.key(),
            &ctx.accounts.payer.key(),
            &ctx.accounts.player_b.key(),
            name_b,
            uri_b,
        )?;
        invoke(
            &ix_b,
            &[
                ctx.accounts.asset_b.to_account_info(),
                ctx.accounts.mpl_core_program.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.player_b.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        // Renseigne les deux "receipts" one-shot. Leur simple création (via
        // `init` dans le Context) a déjà bloqué toute deuxième tentative de
        // mint pour l'un ou l'autre joueur ; ceci ne fait qu'y stocker
        // l'adresse du NFT obtenu, pour audit/lookup côté client.
        ctx.accounts.player_mint_record_a.player = ctx.accounts.player_a.key();
        ctx.accounts.player_mint_record_a.asset = ctx.accounts.asset_a.key();
        ctx.accounts.player_mint_record_a.bump = ctx.bumps.player_mint_record_a;

        ctx.accounts.player_mint_record_b.player = ctx.accounts.player_b.key();
        ctx.accounts.player_mint_record_b.asset = ctx.accounts.asset_b.key();
        ctx.accounts.player_mint_record_b.bump = ctx.bumps.player_mint_record_b;

        emit!(MeetingNftMinted {
            player_a: ctx.accounts.player_a.key(),
            player_b: ctx.accounts.player_b.key(),
            asset_a: ctx.accounts.asset_a.key(),
            asset_b: ctx.accounts.asset_b.key(),
            is_premium,
        });

        Ok(())
    }
}

// Petite fonction partagée entre les deux joueurs d'une même rencontre, pour
// ne pas dupliquer la logique de plafond/incrément deux fois dans
// mint_meeting_nft.
fn increment_tier_count(counter: &mut Account<MintCounter>, is_premium: bool) -> Result<()> {
    if is_premium {
        require!(
            counter.premium_minted_count < PREMIUM_TIER_CAP,
            PoolError::TierSoldOut
        );
        counter.premium_minted_count = counter
            .premium_minted_count
            .checked_add(1)
            .ok_or(PoolError::MathOverflow)?;
    } else {
        require!(
            counter.classic_minted_count < CLASSIC_TIER_CAP,
            PoolError::TierSoldOut
        );
        counter.classic_minted_count = counter
            .classic_minted_count
            .checked_add(1)
            .ok_or(PoolError::MathOverflow)?;
    }
    Ok(())
}

// Event émis à chaque mint réussi — trace on-chain auditable des tiers
// déclarés (voir doc de mint_meeting_nft ci-dessus sur la limite de
// vérifiabilité du hardware Seeker).
#[event]
pub struct MeetingNftMinted {
    pub player_a: Pubkey,
    pub player_b: Pubkey,
    pub asset_a: Pubkey,
    pub asset_b: Pubkey,
    pub is_premium: bool,
}

// ---------------------------------------------------------------------
// Comptes d'état
// ---------------------------------------------------------------------

#[account]
pub struct WeeklyPool {
    pub authority: Pubkey,   // clé publique de la Cloud Function backend
    pub mint: Pubkey,        // mint SPL du token SKR (ou équivalent)
    pub vault: Pubkey,       // token account PDA détenant la cagnotte
    pub week_id: String,     // "2026-W37", doit matcher le weekKey client
    pub total_score: u64,    // somme des scores de tous les joueurs soumis
    pub total_pot: u64,      // montant total déposé dans le vault
    pub eligible_count: u64, // nb de joueurs au-dessus du seuil équitable
    pub finalized: bool,     // true = plus de submit_score, claim ouvert
    pub bump: u8,
}

impl WeeklyPool {
    // discriminator(8) + pubkey*3(96) + string(4+8) + u64*3(24) + bool(1) + bump(1)
    pub const MAX_SIZE: usize = 8 + 32 * 3 + 4 + WEEK_ID_LEN + 8 * 3 + 1 + 1;
}

#[account]
pub struct PlayerScore {
    pub player: Pubkey,
    pub week_id: String,
    pub score: u64,
    pub eligible: bool,   // au-dessus du seuil EQUAL_SHARE_MIN_SCORE
    pub claimed: bool,
    pub bump: u8,
}

impl PlayerScore {
    pub const MAX_SIZE: usize = 8 + 32 + 4 + WEEK_ID_LEN + 8 + 1 + 1 + 1;
}

// Sanctuaire Seeker (mode Proximité) — compteur global (pas hebdomadaire),
// PDA singleton seeds=["mint_counter"]. Porte la rareté des deux tiers ; voir
// CLASSIC_TIER_CAP/PREMIUM_TIER_CAP et `mint_meeting_nft` ci-dessus.
#[account]
pub struct MintCounter {
    pub classic_minted_count: u64,
    pub premium_minted_count: u64,
    pub bump: u8,
}

impl MintCounter {
    // discriminator(8) + u64*2(16) + bump(1)
    pub const MAX_SIZE: usize = 8 + 8 + 8 + 1;
}

// Sanctuaire Seeker — PDA one-shot par joueur, seeds=["player_mint", player].
// Aucun champ métier nécessaire : le simple FAIT que ce compte existe déjà
// est la preuve que le joueur a déjà minté. La contrainte `init` (pas
// `init_if_needed`) dans MintMeetingNft se charge du rejet automatique en
// cas de deuxième tentative — même principe qu'un compte "receipt"
// one-time-use classique sur Solana, plus simple ici qu'un champ `claimed`
// puisqu'il n'y a pas de notion de semaine/réinitialisation comme pour
// PlayerScore.
#[account]
pub struct PlayerMintRecord {
    pub player: Pubkey,
    pub asset: Pubkey, // adresse du NFT Core mint, pour audit/lookup facile
    pub bump: u8,
}

impl PlayerMintRecord {
    // discriminator(8) + pubkey*2(64) + bump(1)
    pub const MAX_SIZE: usize = 8 + 32 + 32 + 1;
}

// ---------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(week_id: String)]
pub struct InitializeWeeklyPool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = WeeklyPool::MAX_SIZE,
        seeds = [b"pool", week_id.as_bytes()],
        bump
    )]
    pub weekly_pool: Account<'info, WeeklyPool>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = mint,
        token::authority = weekly_pool,
        seeds = [b"vault", week_id.as_bytes()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundPool<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(mut)]
    pub funder_token_account: Account<'info, TokenAccount>,

    #[account(mut, seeds = [b"pool", weekly_pool.week_id.as_bytes()], bump = weekly_pool.bump)]
    pub weekly_pool: Account<'info, WeeklyPool>,

    #[account(mut, address = weekly_pool.vault)]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(week_id: String)]
pub struct SubmitScore<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: pubkey du joueur, pas besoin de signature — c'est le backend
    /// qui soumet en son nom après validation off-chain du match.
    pub player: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"pool", week_id.as_bytes()], bump = weekly_pool.bump)]
    pub weekly_pool: Account<'info, WeeklyPool>,

    #[account(
        init_if_needed,
        payer = authority,
        space = PlayerScore::MAX_SIZE,
        seeds = [b"player_score", week_id.as_bytes(), player.key().as_ref()],
        bump
    )]
    pub player_score: Account<'info, PlayerScore>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(week_id: String)]
pub struct FinalizePool<'info> {
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"pool", week_id.as_bytes()], bump = weekly_pool.bump)]
    pub weekly_pool: Account<'info, WeeklyPool>,
}

#[derive(Accounts)]
#[instruction(week_id: String)]
pub struct ClaimScratch<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(seeds = [b"pool", week_id.as_bytes()], bump = weekly_pool.bump)]
    pub weekly_pool: Account<'info, WeeklyPool>,

    #[account(
        mut,
        seeds = [b"player_score", week_id.as_bytes(), player.key().as_ref()],
        bump = player_score.bump
    )]
    pub player_score: Account<'info, PlayerScore>,

    #[account(mut, address = weekly_pool.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub player_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitializeMintCounter<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = MintCounter::MAX_SIZE,
        seeds = [b"mint_counter"],
        bump
    )]
    pub mint_counter: Account<'info, MintCounter>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintMeetingNft<'info> {
    // Co-signature IRL : les deux joueurs doivent signer la MÊME transaction —
    // c'est ça, la preuve on-chain de la rencontre physique (Nearby Connections
    // côté client ne fait que les mettre en contact, la preuve vérifiable est
    // ici). Aucun des deux ne peut mint seul en se faisant passer pour l'autre.
    // Chacun est aussi directement `owner` de son propre NFT dans le CPI —
    // plus besoin d'un compte `owner` séparé à valider.
    pub player_a: Signer<'info>,
    pub player_b: Signer<'info>,

    // Doit être player_a OU player_b — vérifié explicitement ici plutôt que
    // laissé à une convention côté client non contrôlée.
    #[account(
        mut,
        constraint = payer.key() == player_a.key() || payer.key() == player_b.key()
            @ PoolError::InvalidPayer
    )]
    pub payer: Signer<'info>,

    // Deux comptes Core distincts (keypairs frais générés côté client), un
    // par joueur. La contrainte ci-dessous rejette la transaction si le
    // client fournit par erreur la même clé pour les deux — sans elle, un
    // bug client pourrait tenter de créer le même compte deux fois (le
    // deuxième CPI échouerait de toute façon côté runtime, mais avec un
    // message d'erreur bien moins clair qu'ici).
    #[account(mut, constraint = asset_a.key() != asset_b.key() @ PoolError::DuplicateAssetKeypair)]
    pub asset_a: Signer<'info>, // NFT de player_a
    #[account(mut)]
    pub asset_b: Signer<'info>, // NFT de player_b

    #[account(mut, seeds = [b"mint_counter"], bump = mint_counter.bump)]
    pub mint_counter: Account<'info, MintCounter>,

    // Anti-double-mint : `init` échoue automatiquement si ce joueur a déjà
    // un record existant (voir doc de `PlayerMintRecord` ci-dessus). Chaque
    // joueur peut payer pour son propre record si besoin, mais dans notre
    // flux c'est toujours `payer` (l'un des deux) qui règle les deux frais
    // d'init — plus simple pour l'UX (un seul wallet paie tout).
    #[account(
        init,
        payer = payer,
        space = PlayerMintRecord::MAX_SIZE,
        seeds = [b"player_mint", player_a.key().as_ref()],
        bump
    )]
    pub player_mint_record_a: Account<'info, PlayerMintRecord>,

    #[account(
        init,
        payer = payer,
        space = PlayerMintRecord::MAX_SIZE,
        seeds = [b"player_mint", player_b.key().as_ref()],
        bump
    )]
    pub player_mint_record_b: Account<'info, PlayerMintRecord>,

    pub system_program: Program<'info, System>,

    #[account(address = MPL_CORE_ID)]
    /// CHECK: vérifié par la contrainte address ci-dessus.
    pub mpl_core_program: UncheckedAccount<'info>,
}

// ---------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------

#[error_code]
pub enum PoolError {
    #[msg("week_id dépasse la longueur max prévue pour les seeds")]
    WeekIdTooLong,
    #[msg("Cette pool hebdomadaire est déjà finalisée")]
    PoolAlreadyFinalized,
    #[msg("Cette pool hebdomadaire n'est pas encore finalisée")]
    PoolNotFinalized,
    #[msg("Seule l'autorité backend peut effectuer cette action")]
    UnauthorizedAuthority,
    #[msg("Ce compte de score n'appartient pas au joueur signataire")]
    UnauthorizedClaimant,
    #[msg("Ce score a déjà été réclamé")]
    AlreadyClaimed,
    #[msg("Aucun score enregistré dans cette pool")]
    EmptyPool,
    #[msg("Le montant à réclamer est nul après calcul")]
    PayoutTooSmall,
    #[msg("Overflow arithmétique")]
    MathOverflow,
    #[msg("Les deux joueurs d'une rencontre doivent être des wallets différents")]
    SamePlayerMeetingItself,
    #[msg("Ce tier de NFT Sanctuaire Seeker est épuisé")]
    TierSoldOut,
    #[msg("Le payer doit être l'un des deux joueurs de la rencontre")]
    InvalidPayer,
    #[msg("asset_a et asset_b doivent être deux comptes distincts")]
    DuplicateAssetKeypair,
}