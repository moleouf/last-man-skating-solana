# capacitor-solana-mwa

> 🇬🇧 **English version first.** 🇫🇷 La version française complète se trouve plus bas : [aller à la version française](#version-francaise).

Native Capacitor plugin that connects LMS to Mobile Wallet Adapter (Android/Seeker).

## Status

Successfully tested on a physical device (Android, MWA-compatible wallet) —
connection, authorization, retrieval of the public address and writing to
Firebase RTDB were all confirmed working on devnet as of 11/09/2026.

Point of vigilance validated in real use: let the wallet perform its automatic
return to the app after authorization — a manual return before that callback
can leave the coroutine stuck (MWA waits for `onActivityResult`). This should
be shown clearly in the demo video.

Points still to verify/harden:
1. Exact version of the MWA SDK (see below) — works as is, but has not been
   re-validated against a recent SDK changelog.
2. `activity` in `ActivityResultSender` — OK with the default Capacitor
   `BridgeActivity`.
3. base64→Uint8Array encoding — works, the address is correctly rebuilt on the
   JS side.

## Exposed methods (`SolanaWalletPlugin.kt`)

- **`authorize`** — opens the native wallet selector, returns `publicKey` +
  `authToken`.
- **`reauthorize`** — re-authorizes an existing session without relaunching the
  selector, as long as the token is still valid on the wallet side.
- **`deauthorize`** — ends the wallet session.
- **`signAndSendTransactions`** — signs AND submits in a single step (normal
  use, a single signer — e.g. `claim_scratch`).
- **`signTransactions`** — signs **without** submitting. Required only for the
  co-signed mint of Proximity mode (`mint_meeting_nft`): two wallets must sign
  the SAME transaction before it is submitted once — `signAndSendTransactions`
  would submit the first signature alone and fail for lack of the second.
  Marked "deprecated" in the MWA 2.0 spec in favor of
  `signAndSendTransactions`, but it remains the only SDK method that signs
  without submitting — the only possible choice for a multi-signer scenario.
  See "Expired authToken fix" below for its resilience behavior.
- **`signMessages`** — signs one or more arbitrary messages (proof of key
  ownership).
- **`isSeedVaultAvailable`** — detects the presence of the native Seed Vault
  package (Seeker/Saga) via `PackageManager.getPackageInfo` on
  `com.solanamobile.seedvaultimpl`. Requires the declaration
  `<queries><package android:name="com.solanamobile.seedvaultimpl" />` in
  `AndroidManifest.xml` (Android 11+ package visibility) — without it, it always
  returns `false` even if Seed Vault is actually installed. Used to determine
  the tier (classic/premium) of the "Sanctuaire Seeker" NFTs of Proximity mode
  (PREMIUM only if both players have Seed Vault).

## Installation in the LMS project (existing Capacitor)

```bash
# from the root of the LMS project
npm install ../capacitor-solana-mwa   # or publish it as a local package/tarball
npx cap sync android
```

Add the Gradle dependency in `android/app/build.gradle` if `cap sync` does not
propagate it automatically, and check that `minSdkVersion >= 23` (required by
MWA).

## Usage on the JS side (in the monolithic LMS HTML)

```js
import { SolanaWallet } from 'capacitor-solana-mwa';

async function connectWallet() {
  try {
    const { publicKey, authToken } = await SolanaWallet.authorize({
      cluster: 'devnet', // switch to 'mainnet-beta' only once everything is validated
      identityName: 'Last Man Skating',
      identityUri: 'https://kristen.fr/KristenStudiosGames/lms.html', // must be a real domain
      iconUri: 'apple-touch-icon.png', // RELATIVE to identityUri — see "MWA identity fix" below
    });
    localStorage.setItem('_lmsAuthToken', authToken);
    localStorage.setItem('_lmsPubKey', publicKey);
    // -> update the UI (show the truncated address, unlock the "prize pool" mode)
  } catch (e) {
    // e.message will contain NO_WALLET_FOUND if no compatible wallet is installed
    console.error('Wallet connect failed', e);
  }
}
```

**Note on `identityName` (frequent confusion)**: this field has **no effect** on
what the wallet's connection screen shows (Phantom, Solflare...). Wallets
deliberately display the **real domain** extracted from `identityUri` (e.g.
`kristen.fr`), never the self-declared name — a deliberate anti-impersonation
protection of the MWA protocol, since any malicious app could otherwise write
`identityName: "My Bank"`. To change what is displayed, you must own a
different domain and point `identityUri` to it — `identityName` remains useful
elsewhere (logs, future SDK uses) but not for that screen.

## What this plugin does NOT do

- It does not build transactions (that stays on the JS side with
  `@solana/web3.js`, reading the Anchor program).
- It does not handle long-term persistence of the `authToken` beyond what you
  store yourself on the JS/localStorage side.
- It validates nothing server-side — the anti-cheat verification of the score
  that determines the prize-pool amount remains to be done on the Firebase
  Cloud Functions side, separately.

## Update — claim_scratch validated end to end (13/09/2026)

`signAndSendTransactions` requires a `params: TransactionParams` parameter with
a mandatory `minContextSlot` (otherwise Phantom rejects with a Zod
`invalid_type` error on the RPC router side). Fixed in `SolanaWalletPlugin.kt`:

```kotlin
signAndSendTransactions(
    transactions = transactionsBytes,
    params = TransactionParams(
        minContextSlot = 0,
        commitment = null,
        skipPreflight = null,
        maxRetries = null,
        waitForCommitmentToSendNextTransaction = null
    )
)
```

Successfully tested on a real device: wallet connection → signature →
`claim_scratch` transaction confirmed on-chain (devnet). The wallet must have a
sufficient devnet SOL balance (faucet: https://faucet.solana.com), otherwise
Phantom silently blocks with a generic "authorization request failed" error
that hides the real cause (insufficient SOL).

## MWA identity fix (13/09/2026)

Default `identityUri`/`iconUri` fixed in `SolanaWalletPlugin.kt`:
- `identityUri` pointed to a non-existent domain (`lastmanskating.app`) →
  replaced with `https://kristen.fr/KristenStudiosGames/lms.html`.
- `iconUri` must be a **relative** URI to `identityUri`, not an absolute one —
  MWA rejects an absolute URL with `IllegalArgumentException:
  iconRelativeUri must be a relative Uri`. This was the real cause of the crash
  on `deauthorize()` (disconnect button): this PluginMethod never receives
  `iconUri` from the JS, so `buildAdapter()` always fell back to the old
  invalid default (absolute URL).

⚠️ To check manually: `apple-touch-icon.png` must exist at
`https://kristen.fr/KristenStudiosGames/apple-touch-icon.png` (relative path
resolved from `identityUri`), otherwise the icon shown in the wallet will be
broken (non-blocking for the connection itself).

## Wallet UX (13/09/2026)

- The wallet button shows the truncated address once connected; tapping it
  copies the full address to the clipboard ("COPIED!" feedback).
- Separate "×" button, visible only once connected, for disconnecting
  (confirmation before `deauthorize()` + localStorage cleanup).

## Expired authToken fix — co-signed Proximity mint (19/09/2026)

Error observed in real conditions on the `mint_meeting_nft` mint (Proximity
mode):

```
SIGN_TRANSACTIONS_FAILED: ...JsonRpc20RemoteException -1/authorization request failed
```

Cause: the `reauthorize(authToken)` at the head of `signTransactions` fails
when the token stored on the app side is no longer recognized by the wallet
(expired, or session lost on the wallet side — e.g. restart of the wallet app
between the initial connection and the mint attempt). Nothing in the code
renewed this token if the wallet had invalidated it in the meantime.

**Fix**: in `signTransactions`, if `reauthorize` fails, retry with a fresh
`authorize()` before giving up:

```kotlin
try {
    reauthorize(identityUri = ..., iconUri = ..., identityName = ..., authToken = token)
} catch (e: Exception) {
    authorize(identityUri = ..., iconUri = ..., identityName = ..., rpcCluster = cluster)
        .also { refreshedAuthToken = it.authToken }
}
signTransactions(transactions = transactionsBytes)
```

If this fallback occurred, the **new** `authToken` is returned in the response
(`ret.put("authToken", it)`) — **the calling JS must save it again in
`localStorage`**, otherwise the next mint will reuse the dead old token and
trigger a full `authorize()` again (visible re-authorization popup) on every
attempt instead of just once. See `www/index.html` / root README for the JS-side
persistence (also fixed on 19/09/2026, at both call points of
`signTransactions` — `builder` and `signer` roles of the Proximity flow).

## Check of 02/10/2026

- **No key or RPC URL in the plugin**: `SolanaWalletPlugin.kt` only chooses the
  `RpcCluster` (devnet by default, `mainnet-beta`/`testnet` on request) for
  wallet authorization. The game's Helius key therefore exists only on the JS
  side (`LMS_SOLANA_RPC`).
- **`signAndSendTransactions` has the same safety net as `signTransactions`**:
  `reauthorize` then, on failure, a fresh `authorize()` in the same session
  (added on 30/09/2026) — the new `authToken` is returned and must be persisted
  on the JS side (`_lmsSignAndSendWithReauth`).
- **Signature format**: the plugin returns signatures in **base64**;
  `getSignatureStatuses` expects **base58** — conversion is mandatory on the JS
  side before any confirmation check.
- The plugin is **not involved** in the "MY NFTs" area (read-only via Helius
  DAS, no signature).

## Update of 02/10/2026 — co-signed mint: validation and timeouts

- **The plugin has not changed.** `signTransactions` now receives, on the
  signer side, a transaction the JS has already validated (see root README,
  "Security and reliability of the Proximity mint"): the plugin must never be
  called with a transaction supplied by a third party without that check.
- **Timeout observed when creating the nonce account**:
  `SIGN_TRANSACTIONS_FAILED: java.util.concurrent.TimeoutException: Timed out
  waiting for response with id=1` (first request of the session,
  `reauthorize`). The plugin sets no delay itself; it is the default timeout of
  the MWA library (exact value not verified). Logcat on a slow tablet: 3 failed
  attempts in the same process, then a success (signature in 18 s) immediately
  after a restart of the application — an automatic retry in the same process
  therefore does not seem useful. Cause not proven.
- **Possible mitigation (v2312, disabled by default since v2313)**: the nonce account can be pre-created on the first
  opening of RADAR instead of at the end of the first match (`LMS_NONCE_PREWARM_ENABLED`, see root README). By default
  it is still created at the end of the first match. The plugin's behavior remains as described above.

---

<a id="version-francaise"></a>

# 🇫🇷 Version française

# capacitor-solana-mwa

Plugin Capacitor natif pour brancher LMS sur Mobile Wallet Adapter (Android/Seeker).

## Statut

Testé avec succès sur device physique (Android, wallet MWA compatible) —
connexion, autorisation, récupération de l'adresse publique et écriture
dans Firebase RTDB toutes confirmées fonctionnelles en devnet au 11/09/2026.

Point de vigilance validé en usage réel : bien laisser le wallet effectuer
son retour automatique dans l'app après authorization — un retour manuel
avant ce callback peut laisser la coroutine dans un état bloqué (MWA attend
`onActivityResult`). À montrer clairement dans la vidéo de démo.

Points encore à vérifier/durcir :
1. Version exacte du SDK MWA (voir ci-dessous) — fonctionne en l'état, mais
   pas revalidé contre un changelog SDK récent.
2. `activity` dans `ActivityResultSender` — OK avec la `BridgeActivity`
   Capacitor par défaut.
3. Encodage base64→Uint8Array — fonctionne, adresse bien reconstruite côté JS.

## Méthodes exposées (`SolanaWalletPlugin.kt`)

- **`authorize`** — ouvre le sélecteur de wallet natif, retourne
  `publicKey` + `authToken`.
- **`reauthorize`** — ré-autorise une session existante sans relancer le
  sélecteur, tant que le token est valide côté wallet.
- **`deauthorize`** — termine la session wallet.
- **`signAndSendTransactions`** — signe ET soumet en une seule étape
  (usage normal, un seul signataire — ex. `claim_scratch`).
- **`signTransactions`** — signe **sans** soumettre. Nécessaire
  uniquement pour le mint co-signé du mode Proximité (`mint_meeting_nft`) :
  deux wallets doivent signer la MÊME transaction avant qu'elle soit
  soumise une seule fois — `signAndSendTransactions` soumettrait la
  première signature seule et échouerait faute de la seconde. Marquée
  "deprecated" côté spec MWA 2.0 au profit de `signAndSendTransactions`,
  mais reste la seule méthode du SDK permettant de signer sans soumettre —
  seul choix possible pour un scénario multi-signataires. Voir "Fix
  authToken expiré" ci-dessous pour son comportement de résilience.
- **`signMessages`** — signe un ou plusieurs messages arbitraires (preuve
  de possession de clé).
- **`isSeedVaultAvailable`** — détecte la présence du package Seed Vault
  natif (Seeker/Saga) via `PackageManager.getPackageInfo` sur
  `com.solanamobile.seedvaultimpl`. Nécessite la déclaration
  `<queries><package android:name="com.solanamobile.seedvaultimpl" />` dans
  `AndroidManifest.xml` (visibilité de package Android 11+) — sans elle,
  retourne toujours `false` même si Seed Vault est réellement installé.
  Utilisée pour déterminer le tier (classic/premium) des NFT "Sanctuaire
  Seeker" du mode Proximité (PREMIUM uniquement si les deux joueurs ont
  Seed Vault).

## Installation dans le projet LMS (Capacitor existant)

```bash
# depuis la racine du projet LMS
npm install ../capacitor-solana-mwa   # ou publie-le en package local/tarball
npx cap sync android
```

Ajoute la dépendance Gradle dans `android/app/build.gradle` si `cap sync` ne
la propage pas automatiquement, et vérifie que `minSdkVersion >= 23` (requis
par MWA).

## Utilisation côté JS (dans le HTML monolithique LMS)

```js
import { SolanaWallet } from 'capacitor-solana-mwa';

async function connectWallet() {
  try {
    const { publicKey, authToken } = await SolanaWallet.authorize({
      cluster: 'devnet', // passe en 'mainnet-beta' seulement quand tout est validé
      identityName: 'Last Man Skating',
      identityUri: 'https://kristen.fr/KristenStudiosGames/lms.html', // doit être un domaine réel
      iconUri: 'apple-touch-icon.png', // RELATIF à identityUri — voir "Fix identité MWA" plus bas
    });
    localStorage.setItem('_lmsAuthToken', authToken);
    localStorage.setItem('_lmsPubKey', publicKey);
    // -> mettre à jour l'UI (afficher l'adresse tronquée, débloquer le mode "cagnotte")
  } catch (e) {
    // e.message contiendra NO_WALLET_FOUND si aucun wallet compatible n'est installé
    console.error('Wallet connect failed', e);
  }
}
```

**Note sur `identityName` (confusion fréquente)** : ce champ n'a **aucun
effet** sur ce qu'affiche l'écran de connexion du wallet (Phantom,
Solflare...). Les wallets affichent volontairement le **domaine réel**
extrait de `identityUri` (ex. `kristen.fr`), jamais le nom auto-déclaré —
protection anti-usurpation délibérée du protocole MWA, puisque n'importe
quelle app malveillante pourrait sinon écrire `identityName: "Ma Banque"`.
Pour changer ce qui s'affiche, il faut posséder un domaine différent et y
pointer `identityUri` — `identityName` reste utile ailleurs (logs, futurs
usages du SDK) mais pas pour cet écran-là.

## Ce que ce plugin NE fait PAS

- Il ne construit pas les transactions (ça reste côté JS avec `@solana/web3.js`,
  en lisant le programme Anchor).
- Il ne gère pas la persistance long-terme du `authToken` au-delà de ce que tu
  stockes toi-même côté JS/localStorage.
- Il ne valide rien côté serveur — la vérification anti-triche du score qui
  détermine le montant de la cagnotte reste à faire côté Cloud Functions Firebase,
  séparément.

## Mise à jour — claim_scratch validé de bout en bout (13/09/2026)

`signAndSendTransactions` nécessite un paramètre `params: TransactionParams`
avec `minContextSlot` obligatoire (sinon Phantom rejette avec une erreur
Zod `invalid_type` côté RPC router). Corrigé dans `SolanaWalletPlugin.kt` :

```kotlin
signAndSendTransactions(
    transactions = transactionsBytes,
    params = TransactionParams(
        minContextSlot = 0,
        commitment = null,
        skipPreflight = null,
        maxRetries = null,
        waitForCommitmentToSendNextTransaction = null
    )
)
```

Testé avec succès sur device réel : connexion wallet → signature →
transaction `claim_scratch` confirmée on-chain (devnet). Le wallet doit
avoir un solde SOL devnet suffisant (faucet : https://faucet.solana.com)
sinon Phantom bloque silencieusement avec une erreur générique
"authorization request failed" qui masque la vraie cause (SOL insuffisant).

## Fix identité MWA (13/09/2026)

`identityUri`/`iconUri` par défaut corrigés dans `SolanaWalletPlugin.kt` :
- `identityUri` pointait vers un domaine inexistant (`lastmanskating.app`) →
  remplacé par `https://kristen.fr/KristenStudiosGames/lms.html`.
- `iconUri` doit être une URI **relative** à `identityUri`, pas absolue —
  MWA rejette une URL absolue avec `IllegalArgumentException:
  iconRelativeUri must be a relative Uri`. C'était la vraie cause du crash
  sur `deauthorize()` (bouton déconnexion) : ce PluginMethod ne reçoit
  jamais `iconUri` depuis le JS, donc `buildAdapter()` retombait toujours
  sur l'ancien défaut invalide (URL absolue).

⚠️ À vérifier manuellement : `apple-touch-icon.png` doit exister à
`https://kristen.fr/KristenStudiosGames/apple-touch-icon.png` (chemin
relatif résolu depuis `identityUri`), sinon l'icône affichée dans le
wallet sera cassée (non bloquant pour la connexion elle-même).

## UX wallet (13/09/2026)

- Le bouton wallet affiche l'adresse tronquée une fois connecté ; un tap
  dessus copie l'adresse complète dans le presse-papier (feedback "COPIÉ !").
- Bouton "×" séparé, visible uniquement une fois connecté, pour la
  déconnexion (confirmation avant `deauthorize()` + nettoyage localStorage).

## Fix authToken expiré — mint co-signé Proximité (19/09/2026)

Erreur observée en conditions réelles sur le mint `mint_meeting_nft` (mode
Proximité) :

```
SIGN_TRANSACTIONS_FAILED: ...JsonRpc20RemoteException -1/authorization request failed
```

Cause : le `reauthorize(authToken)` en tête de `signTransactions` échoue
quand le token stocké côté app n'est plus reconnu par le wallet (expiré,
ou session perdue côté wallet — ex. redémarrage de l'app wallet entre la
connexion initiale et la tentative de mint). Rien dans le code ne
renouvelait ce token si le wallet l'avait entre-temps invalidé.

**Fix** : dans `signTransactions`, si `reauthorize` échoue, retente un
`authorize()` frais avant d'abandonner :

```kotlin
try {
    reauthorize(identityUri = ..., iconUri = ..., identityName = ..., authToken = token)
} catch (e: Exception) {
    authorize(identityUri = ..., iconUri = ..., identityName = ..., rpcCluster = cluster)
        .also { refreshedAuthToken = it.authToken }
}
signTransactions(transactions = transactionsBytes)
```

Si ce fallback a eu lieu, le **nouveau** `authToken` est renvoyé dans la
réponse (`ret.put("authToken", it)`) — **le JS appelant doit le
re-sauvegarder dans `localStorage`**, sinon le prochain mint réutilisera
l'ancien token mort et redéclenchera un `authorize()` complet (popup de
ré-autorisation visible) à chaque tentative au lieu d'une seule fois. Voir
`www/index.html` / README racine pour la persistance côté JS (corrigée le
19/09/2026 également, aux deux points d'appel de `signTransactions` —
rôle `builder` et rôle `signer` du flux Proximité).

## Vérification du 02/10/2026

- **Aucune clé ni URL RPC dans le plugin** : `SolanaWalletPlugin.kt` ne choisit
  que le `RpcCluster` (devnet par défaut, `mainnet-beta`/`testnet` sur demande)
  pour l'autorisation du wallet. La clé Helius du jeu n'existe donc que côté JS
  (`LMS_SOLANA_RPC`).
- **`signAndSendTransactions` a le même filet que `signTransactions`** :
  `reauthorize` puis, en cas d'échec, `authorize()` frais dans la même session
  (ajouté le 30/09/2026) — le nouveau `authToken` est renvoyé et doit être
  persisté côté JS (`_lmsSignAndSendWithReauth`).
- **Format des signatures** : le plugin renvoie des signatures en **base64** ;
  `getSignatureStatuses` attend du **base58** — conversion obligatoire côté JS
  avant toute vérification de confirmation.
- Le plugin n'est **pas impliqué** dans l'espace « MES NFT » (lecture seule via
  Helius DAS, aucune signature).

## Mise à jour du 02/10/2026 — mint co-signé : validation et timeouts

- **Le plugin n'a pas changé.** `signTransactions` reçoit désormais, côté signataire, une transaction que le JS a déjà
  validée (voir README racine, « Sécurité et fiabilité du mint Proximité ») : le plugin ne doit jamais être appelé avec
  une transaction fournie par un tiers sans ce contrôle.
- **Timeout observé sur la création du compte nonce** : `SIGN_TRANSACTIONS_FAILED: java.util.concurrent.TimeoutException:
  Timed out waiting for response with id=1` (première requête de la session, `reauthorize`). Le plugin ne fixe lui-même
  aucun délai ; c'est le délai par défaut de la bibliothèque MWA (valeur exacte non vérifiée). Relevé logcat sur une
  tablette lente : 3 tentatives en échec dans le même processus puis un succès (signature en 18 s) immédiatement après
  un redémarrage de l'application — une relance automatique dans le même processus ne semble donc pas utile. Cause
  non prouvée.
- **Atténuation possible (v2312, désactivée par défaut depuis v2313)** : le compte nonce peut être créé à la première
  ouverture de RADAR plutôt qu'à la fin du premier match (`LMS_NONCE_PREWARM_ENABLED`, voir README racine). Par défaut
  il est toujours créé à la fin du premier match. Le comportement du plugin reste celui décrit plus haut.
