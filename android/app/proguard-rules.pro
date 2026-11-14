# R8-regels voor de release-build. ML Kit, Coil, Compose en WorkManager
# leveren hun eigen consumer-rules mee; de app zelf gebruikt geen reflectie.

# Stacktraces in crashmeldingen leesbaar houden (mapping blijft lokaal in build/outputs).
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Credential Manager finds its Play Services provider by class name (androidx.credentials docs).
-if class androidx.credentials.CredentialManager
-keep class androidx.credentials.playservices.** {
  *;
}

# LiteRT-LM (Ask JotDrop on this phone) brings no rules of its own; its native code calls back into these classes by name.
-keep class com.google.ai.edge.litertlm.** {
  *;
}
