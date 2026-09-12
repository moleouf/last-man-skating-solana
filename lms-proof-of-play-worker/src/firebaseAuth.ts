/**
 * Obtention d'un access token OAuth2 Google à partir d'un compte de service,
 * SANS le SDK Admin Firebase (trop lourd/Node-only) — juste Web Crypto,
 * disponible nativement dans les Workers (pas besoin de nodejs_compat pour ça).
 *
 * CORRIGÉ : ta base est Realtime Database (RTDB), pas Firestore. Le scope
 * "datastore.readonly" de la version précédente ne donnait accès à rien ici.
 * Le scope RTDB est "firebase.database" (pas de variante readonly côté
 * scope OAuth — la restriction en lecture seule se fait via le RÔLE IAM
 * attribué au compte de service, voir note plus bas).
 *
 * CORRECTIF (2e passe) : la doc officielle Google exige DEUX scopes, pas un
 * seul — "firebase.database" ET "userinfo.email" ensemble. Sans le 2e, le
 * token minté n'est pas juste "restreint", il est carrément rejeté par
 * Firebase ("401 Unauthorized request.") sur TOUS les chemins, y compris
 * ceux en lecture publique (".read": true) — le rejet se fait avant même
 * que la Rule du chemin visé soit évaluée. Vérifié dans la doc :
 * https://firebase.google.com/docs/database/rest/auth
 *
 * Doc du flow "JWT Bearer" Google : https://developers.google.com/identity/protocols/oauth2/service-account
 */

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textToBase64Url(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemBody = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(pemBody);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

/**
 * Retourne un access token valide (durée de vie ~1h) pour appeler l'API REST
 * RTDB avec le header `Authorization: Bearer <token>`.
 *
 * IMPORTANT côté IAM (Firebase Console > Paramètres du projet > Utilisateurs
 * et autorisations, ou Google Cloud Console > IAM) : donne à ce compte de
 * service UNIQUEMENT le rôle "Firebase Realtime Database Viewer" (lecture
 * seule) — puisque le scope OAuth "firebase.database" à lui seul autorise
 * aussi l'écriture, c'est le rôle IAM qui doit restreindre réellement l'accès
 * du Worker à de la lecture, vu qu'il n'a besoin que de lire duelStats/
 * ffaStats/wallets.
 */
export async function getRtdbAccessToken(serviceAccountJson: string): Promise<string> {
  const sa: ServiceAccount = JSON.parse(serviceAccountJson);

  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    iat: nowSec,
    exp: nowSec + 3600,
  };

  const unsigned = `${textToBase64Url(JSON.stringify(header))}.${textToBase64Url(JSON.stringify(claims))}`;
  const key = await importPrivateKey(sa.private_key);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64UrlEncode(signature)}`;

  const tokenResponse = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Echec obtention token Google: ${tokenResponse.status} ${await tokenResponse.text()}`);
  }

  const { access_token } = (await tokenResponse.json()) as { access_token: string };
  return access_token;
}
