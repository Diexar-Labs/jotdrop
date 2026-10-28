import org.gradle.api.tasks.Exec

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("androidx.baselineprofile")
}

android {
    namespace = "com.diexar.keepcapture"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.diexar.keepcapture"
        minSdk = 26
        targetSdk = 36
        versionCode = 78
        versionName = "0.28.24"
    }

    // Stabiele debug-keystore in de repo. AGP's default genereert per CI-runner
    // een nieuwe keystore, waardoor opeenvolgende releases verschillende
    // signatures hebben en Android weigert ze over elkaar te installeren
    // ("App not installed"). Met deze gecommite keystore krijgt elke release
    // dezelfde signature en updaten APK's gewoon netjes over elkaar heen.
    // Dit is geen geheime productiesleutel: gebruik hem nooit voor Play App Signing.
    signingConfigs {
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        if (System.getenv("JOTDROP_PLAY_UPLOAD_KEYSTORE") != null) {
            create("playUpload") {
                storeFile = file(System.getenv("JOTDROP_PLAY_UPLOAD_KEYSTORE"))
                storeType = "pkcs12"
                storePassword = System.getenv("JOTDROP_PLAY_UPLOAD_PASSWORD")
                keyAlias = "jotdrop-play-upload"
                keyPassword = System.getenv("JOTDROP_PLAY_UPLOAD_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // R8 aan: debug-builds van Compose zijn berucht traag bij scrollen
            // (geen inlining/optimalisatie, extra runtime-checks). De release-
            // build is de échte scroll-perf-fix voor eindgebruikers.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Bewust dezelfde (gecommite debug-)keystore als de debug-build:
            // identieke signature, dus bestaande installaties updaten gewoon
            // door zonder uninstall. Play-bundels gebruiken de aparte upload-key
            // via omgevingsvariabelen; Google beheert de geheime app-signing-key.
            signingConfig = signingConfigs.findByName("playUpload") ?: signingConfigs.getByName("debug")
        }
        debug {
            isDebuggable = true
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
        compose = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
}

val verifyReleaseSource = tasks.register<Exec>("verifyReleaseSource") {
    workingDir(rootProject.projectDir.parentFile)
    val verificationMode = if (System.getenv("JOTDROP_ANDROID_TEST_RELEASE") == "true") "base" else "release"
    commandLine("node", "scripts/verify-release-source.mjs", verificationMode)
}

tasks.matching {
    it.name == "assembleRelease" ||
        it.name == "bundleRelease" ||
        it.name == "packageRelease" ||
        it.name == "installRelease"
}.configureEach {
    dependsOn(verifyReleaseSource)
}

// Debug APKs have no R8 optimization and make Compose scrolling appear broken.
// Keep compileDebugKotlin available for CI validation, but make every debug APK
// or debug install fail instead of silently becoming a test artifact.
tasks.matching {
    it.name == "assembleDebug" ||
        it.name == "bundleDebug" ||
        it.name == "packageDebug" ||
        it.name == "installDebug"
}.configureEach {
    outputs.upToDateWhen { false }
    doFirst {
        throw GradleException(
            "Debug APKs are disabled for JotDrop. Build the R8 release variant instead.",
        )
    }
}

// Baseline Profile: AOT-compiles the startup + notes-list scroll code at install
// time, so a fresh install or update scrolls smoothly before ART's overnight
// compile. The profile is checked in; regenerate it with
// ./gradlew :app:generateBaselineProfile (emulator API 33+ or rooted device).
baselineProfile {
    mergeIntoMain = true
    // Never generate during assembleRelease/CI; use the checked-in profile.
    automaticGenerationDuringBuild = false
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.activity:activity-ktx:1.9.0")
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation("androidx.preference:preference-ktx:1.2.1")
    implementation("androidx.work:work-runtime-ktx:2.9.0")
    // Installs the Baseline Profile on sideloaded (adb/GitHub APK) installs too.
    // 1.4+ is required on Android 15+: 1.3.x (what Compose pulls in) stops at API 34
    // and reports "unsupported ART version" there, so the profile was never installed.
    implementation("androidx.profileinstaller:profileinstaller:1.4.1")
    baselineProfile(project(":baselineprofile"))

    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.2")
    implementation("io.coil-kt:coil-compose:2.6.0")
    // ML Kit Text Recognition v2 — standalone (geen Play Services nodig). Bundelt
    // het Latijns-schrift-model in de APK (~3-4MB), zodat de app ook werkt op
    // toestellen zonder Google Play (en op GitHub-gedistribueerde builds).
    implementation("com.google.mlkit:text-recognition:16.0.1")
    // Argon2id for cloud accounts (docs/cloud-accounts-design.md); used directly, not as a JCA provider.
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
    // Android's own Google account picker for "Continue with Google"; the browser stays the fallback.
    // 1.3.0: the newest that builds against compileSdk 34.
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
