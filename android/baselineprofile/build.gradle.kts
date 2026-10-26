// Baseline Profile generator for :app. Not part of normal release builds or CI.
//
// Regenerate (from android/, one emulator or rooted device attached, API 33+
// recommended; on a non-rooted device API 33+ is required):
//   ./gradlew :app:generateBaselineProfile
// The journey seeds test notes in /sdcard/Documents/JotDropBaseline, picks that
// folder as the vault through the system folder picker, then cold-starts the app
// and scrolls the notes grid. Output lands in
// app/src/main/generated/baselineProfiles/{baseline,startup}-prof.txt; commit it.
plugins {
    id("com.android.test")
    id("org.jetbrains.kotlin.android")
    id("androidx.baselineprofile")
}

android {
    namespace = "com.diexar.keepcapture.baselineprofile"
    compileSdk = 34

    defaultConfig {
        minSdk = 28
        targetSdk = 34
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    targetProjectPath = ":app"
}

baselineProfile {
    useConnectedDevices = true
}

dependencies {
    implementation("androidx.test.ext:junit:1.2.1")
    implementation("androidx.test.uiautomator:uiautomator:2.3.0")
    implementation("androidx.benchmark:benchmark-macro-junit4:1.3.4")
}
