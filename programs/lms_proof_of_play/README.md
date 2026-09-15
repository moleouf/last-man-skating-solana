# lms_proof_of_play

Programme Anchor (Solana) de distribution "Proof of Play" pour Last Man
Skating. Pas de mise, pas de hasard côté chaîne : distribue une cagnotte
hebdomadaire (SPL token) proportionnellement à un score déjà validé
off-chain (Cloudflare Worker) et soumis par une autorité backend de confiance.

**Program ID (devnet) :** `GQeKyxHQGFv46z8hM5KocYa5hrUSea1hYJrDXyH41caH`

## Flux

1. **`initialize_weekly_pool(week_id)`** — ouvre la cagnotte de la semaine
   (PDA `["pool", week_id]`), crée le vault SPL qui la détient (PDA
   `["vault", week_id]`).
2. **`fund_pool(amount)`** — alimente la cagnotte (transfert SPL depuis
   n'importe quel compte financeur). Optionnel, peut être appelé plusieurs
   fois avant `finalize_pool`.
3. **`submit_score(week_id, new_score)`** — appelé UNIQUEMENT par
   `authority` (la clé du Cloudflare Worker, `SOLANA_AUTHORITY_SECRET_KEY`),
   après validation du delta hebdomadaire côté Firebase RTDB. `new_score`
   est le score CUMULÉ de la semaine (pas un delta) : le compte
   `PlayerScore` est écrasé, pas incrémenté.
4. **`finalize_pool(week_id)`** — l'autorité backend clôture la semaine :
   plus aucun `submit_score` possible, `total_score` figé.
5. **`claim_scratch(week_id)`** — le joueur (signataire) réclame sa part :
   `payout = 75% * pot * (son_score / total_score) + 25% * pot / nb_joueurs_éligibles`.
   Transfert SPL direct depuis le vault (signé par le PDA `weekly_pool`),
   marque `claimed = true`.

Seuil d'éligibilité à l'enveloppe équitable (25%) : `EQUAL_SHARE_MIN_SCORE = 9`.

## Sécurité

Le programme ne juge jamais de la légitimité d'un match — il fait
entièrement confiance à `authority` (le Worker Cloudflare). C'est elle qui
porte la responsabilité anti-spoof, pas le contrat on-chain.

**Anti-triche (collusion / self-play) — limitation connue, choix délibéré
de ne pas la corriger :** `duelStats`/`ffaStats` sont des compteurs
auto-déclarés côté client (RTDB Firebase), sans lien vérifiable avec
l'identité réelle de l'adversaire. Un joueur pourrait en théorie gonfler
son score en jouant contre un second compte qu'il contrôle. Seul
garde-fou actuel : un plafond hebdomadaire par joueur (21 duels / 14 FFA)
qui borne l'ampleur d'un abus sans l'empêcher structurellement.

Un correctif existe sur le papier (nœud `matchHistory/{matchId}`
enregistrant les deux `uid` à la fin de chaque match, score calculé
uniquement à partir de victoires contre un adversaire distinct), mais il
**ne sera pas implémenté**. Décision assumée : le modèle économique du
jeu repose sur les revenus publicitaires (AdMob) de la version grand
public, qui restent générés que le score soit "légitime" ou non — un
abus de ce mécanisme ne coûte donc rien au projet et n'est pas considéré
comme un risque justifiant la complexité additionnelle avant la deadline
du hackathon. Documenté ici en toute transparence plutôt que corrigé.

Autres protections déjà en place : anti double-claim (`claimed` bool sur
`PlayerScore`), vérification stricte que le signataire de `claim_scratch`
correspond au `player` du `PlayerScore` visé (seeds PDA), calculs de
payout en `u128` pour éviter tout overflow.

## Tests

8/8 tests unitaires passants (`anchor.test.ts`, environnement Solana
Playground — pas de Chai disponible, mini-implémentation maison des
assertions nécessaires). Couvre : initialisation, funding, soumission de
3 scores (dont un pile au seuil d'éligibilité), finalisation, split 75/25
correct pour un score dominant et un score minimal-mais-éligible, refus
d'un double claim, refus qu'un joueur réclame le score d'un autre.

Les 3 instructions critiques (`submit_score`, `claim_scratch`,
`finalize_pool`) ont en plus été validées manuellement on-chain sur
devnet, avec un wallet Seeker physique + Phantom.

## Limitations connues (au-delà de l'anti-triche)

- Mint SKR encore en mode test devnet — SKR n'existe qu'en mainnet
  (aucun déploiement devnet officiel), un jeton de test Playground est
  utilisé en lieu et place pour la démo, documenté comme tel.
- `week_id` plafonné à `WEEK_ID_LEN = 8` caractères pour les seeds PDA —
  compatible avec le format `"YYYY-Www"` (ex. `"2026-W37"`) utilisé côté
  client, mais à surveiller si le format change.
- Le montant de la cagnotte hebdomadaire n'est pas déterminé
  automatiquement : `initialize_weekly_pool` + `fund_pool` doivent être
  appelés manuellement chaque semaine (pas encore automatisé côté Worker).

## Build & déploiement

Développé et testé sur Solana Playground. Dépendances : `anchor-lang
0.29.0`, `anchor-spl 0.29.0` (voir `Cargo.toml`). Pour redéployer une
IDL à jour côté client (`lms-proof-of-play-worker/src/idl/`), exporter
depuis Playground (bouton "Export IDL") après tout changement du
programme.
