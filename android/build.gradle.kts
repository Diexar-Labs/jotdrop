plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}

val cloudCryptoClasses = layout.buildDirectory.dir("cloud-crypto-check")
val cloudCryptoSources = files("app/src/main/kotlin/com/diexar/keepcapture/CloudCrypto.kt", "../cloud/android/CloudCryptoCheck.kt",
    "app/src/main/kotlin/com/diexar/keepcapture/CloudSyncEngine.kt", "../cloud/android/CloudSyncEngineCheck.kt",
    "app/src/main/kotlin/com/diexar/keepcapture/CloudDiagnostics.kt")
val cloudCryptoCompile = tasks.register<JavaExec>("cloudCryptoCompile") {
    inputs.files(cloudCryptoSources)
    outputs.dir(cloudCryptoClasses)
    classpath(buildscript.configurations.getByName("classpath"))
    mainClass.set("org.jetbrains.kotlin.cli.jvm.K2JVMCompiler")
    doFirst {
        args("-Xdisable-default-scripting-plugin", "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-classpath",
            project(":app").configurations.getByName("debugCompileClasspath").asPath,
            "-d", cloudCryptoClasses.get().asFile.absolutePath)
        args(cloudCryptoSources.files.map { it.absolutePath })
    }
}

tasks.register<JavaExec>("checkCloudCrypto") {
    dependsOn(cloudCryptoCompile)
    classpath(cloudCryptoClasses)
    classpath(provider { project(":app").configurations.getByName("debugCompileClasspath") })
    mainClass.set("com.diexar.keepcapture.CloudCryptoCheckKt")
    doFirst {
        args(requireNotNull(System.getenv("JOTDROP_CRYPTO_INPUT")), requireNotNull(System.getenv("JOTDROP_CRYPTO_OUTPUT")))
    }
}

tasks.register<JavaExec>("checkCloudSync") {
    dependsOn(cloudCryptoCompile)
    classpath(cloudCryptoClasses)
    classpath(provider { project(":app").configurations.getByName("debugCompileClasspath") })
    mainClass.set("com.diexar.keepcapture.CloudSyncEngineCheckKt")
}
