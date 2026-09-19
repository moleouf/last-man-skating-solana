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
