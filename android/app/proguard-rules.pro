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
# RETIRÉ : les 2 anciennes règles "-keep public class com.google.android.gms.ads.** { *; }"
# et "...gms.internal.ads.** { *; }" gardaient TOUT le SDK AdMob intact (aucune
# optimisation/obfuscation/réduction possible dessus) — c'était probablement la
# cause principale des taux à 34%. Le SDK Google Mobile Ads embarque son propre
# consumer-rules.txt dans l'AAR (règles fines, déjà maintenues par Google), R8
# les applique automatiquement sans rien à ajouter ici. On garde seulement un
# -dontwarn pour éviter des warnings de build sans rien exempter d'optimisation :
-dontwarn com.google.android.gms.**

# Si (et seulement si) tu vois des crashs liés aux pubs en release après ce
# changement, remets une règle bien plus ciblée plutôt que le blanket total,
# par exemple juste sur les classes qui posent problème d'après le stacktrace.

# AJOUT — 17/07 : test suite à "No adapters found" dans Ad Inspector en prod.
# Ces classes sont chargées par réflexion par le SDK GMA (y compris pour le
# réseau Google lui-même, pas seulement pour la médiation tierce). La chaîne
# de consumer-rules.txt peut ne pas se propager correctement ici car
# play-services-ads arrive via le module wrapper capacitor-community-admob
# et non en dépendance Maven directe dans ce module app. Règle volontairement
# étroite (pas de blanket .** { *; } sur tout com.google.android.gms.ads) :
-keep class com.google.android.gms.ads.mediation.** { *; }
-keep class com.google.ads.mediation.admob.** { *; }
-keep class com.google.android.gms.ads.internal.mediation.** { *; }
