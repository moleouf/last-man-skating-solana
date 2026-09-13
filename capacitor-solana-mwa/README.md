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
      identityUri: 'https://lastmanskating.app',
      iconUri: 'https://lastmanskating.app/icon.png',
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
