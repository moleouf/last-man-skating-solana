# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ══════════════════════════════════════════════════════════════════
# Règles indispensables avant d'activer minifyEnabled true (R8)
# Sans ça, le pont JS <-> plugins natifs Capacitor casse en release
# (silencieusement : pas d'erreur de compil, juste des plugins qui ne
# répondent plus une fois l'app installée).
# ══════════════════════════════════════════════════════════════════

# NOTE : depuis Capacitor v3.2.3+, le core (com.getcapacitor.**) embarque déjà
# ses propres règles consumer-proguard dans l'AAR — R8 les applique
# automatiquement. On ne garde ici QUE la règle officiellement documentée par
# Capacitor pour les plugins (cf. capacitorjs.com/docs/android/troubleshooting),
# on a retiré le "-keep class com.getcapacitor.** { *; }" qui gardait tout le
# package intact (bloquant l'optimisation/obfuscation d'une grosse partie du
# code natif pour rien).

# Tous les plugins Capacitor (AdMob, etc.) + leurs méthodes exposées au JS
-keep public class * extends com.getcapacitor.Plugin
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.PluginMethod public *;
}

# Plugins Cordova legacy éventuellement utilisés via capacitor-cordova-android-plugins
-keep public class * extends org.apache.cordova.CordovaPlugin

# ══════════════════════════════════════════════════════════════════
# FIX crash NPE getPermissionStates (thread CapacitorPlugins, ex: checkPermissions()
# de @capacitor/local-notifications) — Sep 2026
# ══════════════════════════════════════════════════════════════════
# La règle ligne 39 protège les classes qui HÉRITENT de com.getcapacitor.Plugin
# (ex: LocalNotificationsPlugin), mais getPermissionStates()/checkPermissions() sont
# définis dans com.getcapacitor.Plugin lui-même (la classe de BASE du framework),
# qui n'est pas couverte par "extends com.getcapacitor.Plugin". Ces méthodes lisent
# l'annotation @CapacitorPlugin(permissions = {@Permission(...)}) par réflexion sur
# la sous-classe au runtime : si R8 renomme/optimise la classe de base ou les classes
# d'annotation, cette lecture renvoie null → NullPointerException, quel que soit le
# moment où le JS appelle checkPermissions() (confirmé indépendant du cycle de vie
# pause/resume/background après investigation côté JS — donc bien un problème R8,
# pas de timing).
-keep class com.getcapacitor.Plugin { *; }
-keep class com.getcapacitor.Bridge { *; }
-keep class com.getcapacitor.PluginHandle { *; }
-keep @interface com.getcapacitor.annotation.CapacitorPlugin
-keep @interface com.getcapacitor.annotation.Permission
-keep class com.getcapacitor.annotation.** { *; }

# Interfaces JavaScript exposées à la WebView (@JavascriptInterface)
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Conserve les attributs nécessaires au bon fonctionnement des annotations
# et de la réflexion utilisée par Capacitor
-keepattributes *Annotation*
-keepattributes Signature
-keepattributes InnerClasses

# ══════════════════════════════════════════════════════════════════
# Google Mobile Ads (AdMob)
# ══════════════════════════════════════════════════════════════════
# HISTORIQUE DE CE BLOC (pour ne pas refaire le même aller-retour une 3e fois) :
#   1. À l'origine : "-keep public class com.google.android.gms.ads.** { *; }" (tout,
#      y compris l'interne) — fonctionnait, mais empêchait toute optimisation/
#      obfuscation du SDK (taux d'optimisation du build pénalisé).
#   2. Retiré complètement, en pariant sur le consumer-rules.txt embarqué dans l'AAR
#      pour couvrir automatiquement les besoins de R8 → RÉGRESSION : "No adapters
#      found" dans Ad Inspector (les classes d'adapter, chargées par réflexion par
#      le SDK GMA — y compris pour son PROPRE réseau, pas seulement la médiation
#      tierce — étaient invisibles pour l'analyse statique de R8 et donc supprimées).
#   3. Ajout ciblé du 17/07 (juste .mediation.**) : insuffisant → RÉGRESSION ENCORE
#      PIRE (plus aucune pub du tout, même Ad Inspector ne s'ouvre plus au
#      secouement) : d'autres classes, hors du seul périmètre mediation.**, étaient
#      elles aussi strippées.
#   4. ICI : la règle officiellement recommandée par Google pour AdMob + R8 —
#      compromis entre les 2 extrêmes déjà testés. "public *" (pas "*") : seule
#      l'API PUBLIQUE du SDK est protégée (ce dont la réflexion du SDK GMA et le
#      pont JS<->natif du plugin Capacitor ont besoin), R8 reste libre d'optimiser/
#      renommer tout le reste (membres privés, classes internes non exposées) —
#      contrairement au point 1, l'optimisation du SDK n'est donc pas totalement
#      désactivée, juste restreinte à ce qui doit rester stable.
-keep public class com.google.android.gms.ads.** {
    public *;
}
-keep public class com.google.ads.** {
    public *;
}
-dontwarn com.google.android.gms.**

# Règles ciblées du 17/07 conservées (redondantes avec la règle publique ci-dessus dans la
# plupart des cas, mais sans risque de les garder — portée volontairement étroite, elles ne
# désactivent l'optimisation que sur les 3 packages listés, pas sur tout com.google.android.gms.ads) :
-keep class com.google.android.gms.ads.mediation.** { *; }
-keep class com.google.ads.mediation.admob.** { *; }
-keep class com.google.android.gms.ads.internal.mediation.** { *; }

# ══════════════════════════════════════════════════════════════════
# Google Play Billing (utilisé par @capgo/native-purchases — bouton "Retirer les
# pubs" + achats de pièces/skins premium)
# ══════════════════════════════════════════════════════════════════
# Pas encore de règle dédiée dans ce fichier avant aujourd'hui — la librairie Billing
# embarque normalement son propre consumer-rules.txt, mais vu que le MÊME pari (compter
# sur le consumer-rules.txt d'un SDK tiers sans règle explicite) vient de casser AdMob
# deux fois de suite ci-dessus, on ajoute un filet de sécurité explicite ici aussi
# plutôt que d'attendre un 3e aller-retour découvert en prod sur l'IAP cette fois.
-keep class com.android.billingclient.api.** { *; }
-dontwarn com.android.billingclient.api.**

# Si (et seulement si) tu vois des crashs liés aux pubs en release après ce
# changement, remets une règle bien plus ciblée plutôt que le blanket total,
# par exemple juste sur les classes qui posent problème d'après le stacktrace.
