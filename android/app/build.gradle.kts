plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.diexar.keepcapture"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.diexar.keepcapture"
        minSdk = 26
        targetSdk = 34
        versionCode = 27
        versionName = "0.15.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            isDebuggable = true
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

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.activity:activity-ktx:1.9.0")
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation("androidx.preference:preference-ktx:1.2.1")
    implementation("androidx.work:work-runtime-ktx:2.9.0")

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
    debugImplementation("androidx.compose.ui:ui-tooling")
}
