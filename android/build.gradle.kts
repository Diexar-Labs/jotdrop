plugins {
    id("com.android.application") version "8.5.2" apply false
    id("com.android.test") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
    // Baseline Profile generator (see baselineprofile/build.gradle.kts). Only
    // :app:generateBaselineProfile runs it; normal release builds just read the
    // checked-in profile under app/src/main/generated/baselineProfiles.
    id("androidx.baselineprofile") version "1.3.4" apply false
}

val cloudCryptoClasses = layout.buildDirectory.dir("cloud-crypto-check")
val cloudCryptoSources = files("app/src/main/kotlin/com/diexar/keepcapture/CloudCrypto.kt", "../cloud/android/CloudCryptoCheck.kt",
    "app/src/main/kotlin/com/diexar/keepcapture/CloudSyncEngine.kt", "../cloud/android/CloudSyncEngineCheck.kt",
    "app/src/main/kotlin/com/diexar/keepcapture/CloudNoteMerge.kt",
    "app/src/main/kotlin/com/diexar/keepcapture/CloudDiagnostics.kt",
    "app/src/main/kotlin/com/diexar/keepcapture/CloudUpload.kt")
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
    // The sync scale check moves 300 MB through this heap; holding them all at once would fail.
    maxHeapSize = "160m"
}

// Mail to JotDrop: Android must derive the same key pair and open the same sealed mail as every other platform.
val cloudMailClasses = layout.buildDirectory.dir("cloud-mail-check")
val cloudMailSources = files("app/src/main/kotlin/com/diexar/keepcapture/CloudCrypto.kt",
    "app/src/main/kotlin/com/diexar/keepcapture/CloudMail.kt", "../cloud/android/CloudMailCheck.kt")
val cloudMailCompile = tasks.register<JavaExec>("cloudMailCompile") {
    inputs.files(cloudMailSources)
    outputs.dir(cloudMailClasses)
    classpath(buildscript.configurations.getByName("classpath"))
    mainClass.set("org.jetbrains.kotlin.cli.jvm.K2JVMCompiler")
    doFirst {
        args("-Xdisable-default-scripting-plugin", "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-classpath",
            project(":app").configurations.getByName("debugCompileClasspath").asPath,
            "-d", cloudMailClasses.get().asFile.absolutePath)
        args(cloudMailSources.files.map { it.absolutePath })
    }
}

tasks.register<JavaExec>("checkCloudMail") {
    dependsOn(cloudMailCompile)
    classpath(cloudMailClasses)
    classpath(provider { project(":app").configurations.getByName("debugCompileClasspath") })
    mainClass.set("com.diexar.keepcapture.CloudMailCheckKt")
    doFirst {
        args(requireNotNull(System.getenv("JOTDROP_MAIL_INPUT")))
    }
}

val listEditorClasses = layout.buildDirectory.dir("list-editor-check")
val listEditorSources = files("app/src/main/kotlin/com/diexar/keepcapture/ListEditing.kt", "checks/ListEditorCheck.kt")
val listEditorCompile = tasks.register<JavaExec>("listEditorCompile") {
    inputs.files(listEditorSources)
    outputs.dir(listEditorClasses)
    classpath(buildscript.configurations.getByName("classpath"))
    mainClass.set("org.jetbrains.kotlin.cli.jvm.K2JVMCompiler")
    doFirst {
        args("-Xdisable-default-scripting-plugin", "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-classpath",
            project(":app").configurations.getByName("debugCompileClasspath").asPath,
            "-d", listEditorClasses.get().asFile.absolutePath)
        args(listEditorSources.files.map { it.absolutePath })
    }
}

tasks.register<JavaExec>("checkListEditor") {
    dependsOn(listEditorCompile)
    classpath(listEditorClasses)
    classpath(provider { project(":app").configurations.getByName("debugCompileClasspath") })
    mainClass.set("com.diexar.keepcapture.ListEditorCheckKt")
}

// TikTok link previews: the video's own data is read from the page, not from oEmbed or the generic title.
val tikTokPageClasses = layout.buildDirectory.dir("tiktok-page-check")
val tikTokPageSources = files("app/src/main/kotlin/com/diexar/keepcapture/JsonText.kt",
    "app/src/main/kotlin/com/diexar/keepcapture/TikTokPage.kt", "checks/TikTokPageCheck.kt")
val tikTokPageCompile = tasks.register<JavaExec>("tikTokPageCompile") {
    inputs.files(tikTokPageSources)
    outputs.dir(tikTokPageClasses)
    classpath(buildscript.configurations.getByName("classpath"))
    mainClass.set("org.jetbrains.kotlin.cli.jvm.K2JVMCompiler")
    doFirst {
        args("-Xdisable-default-scripting-plugin", "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-classpath",
            project(":app").configurations.getByName("debugCompileClasspath").asPath,
            "-d", tikTokPageClasses.get().asFile.absolutePath)
        args(tikTokPageSources.files.map { it.absolutePath })
    }
}

tasks.register<JavaExec>("checkTikTokPage") {
    dependsOn(tikTokPageCompile)
    classpath(tikTokPageClasses)
    classpath(provider { project(":app").configurations.getByName("debugCompileClasspath") })
    mainClass.set("com.diexar.keepcapture.TikTokPageCheckKt")
}

val versionDiffClasses = layout.buildDirectory.dir("version-diff-check")
val versionDiffSources = files("app/src/main/kotlin/com/diexar/keepcapture/CloudVersionDiff.kt", "checks/VersionDiffCheck.kt")
val versionDiffCompile = tasks.register<JavaExec>("versionDiffCompile") {
    inputs.files(versionDiffSources)
    outputs.dir(versionDiffClasses)
    classpath(buildscript.configurations.getByName("classpath"))
    mainClass.set("org.jetbrains.kotlin.cli.jvm.K2JVMCompiler")
    doFirst {
        args("-Xdisable-default-scripting-plugin", "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-classpath",
            project(":app").configurations.getByName("debugCompileClasspath").asPath,
            "-d", versionDiffClasses.get().asFile.absolutePath)
        args(versionDiffSources.files.map { it.absolutePath })
    }
}

tasks.register<JavaExec>("checkVersionDiff") {
    dependsOn(versionDiffCompile)
    classpath(versionDiffClasses)
    classpath(provider { project(":app").configurations.getByName("debugCompileClasspath") })
    mainClass.set("com.diexar.keepcapture.VersionDiffCheckKt")
}

// A drawing is a PNG with its lines inside; the same format as the web app and the plugins.
val drawingFormatClasses = layout.buildDirectory.dir("drawing-format-check")
val drawingFormatSources = files("app/src/main/kotlin/com/diexar/keepcapture/DrawingFormat.kt", "checks/DrawingFormatCheck.kt")
val drawingFormatCompile = tasks.register<JavaExec>("drawingFormatCompile") {
    inputs.files(drawingFormatSources)
    outputs.dir(drawingFormatClasses)
    classpath(buildscript.configurations.getByName("classpath"))
    mainClass.set("org.jetbrains.kotlin.cli.jvm.K2JVMCompiler")
    doFirst {
        args("-Xdisable-default-scripting-plugin", "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-classpath",
            project(":app").configurations.getByName("debugCompileClasspath").asPath,
            "-d", drawingFormatClasses.get().asFile.absolutePath)
        args(drawingFormatSources.files.map { it.absolutePath })
    }
}

tasks.register<JavaExec>("checkDrawingFormat") {
    dependsOn(drawingFormatCompile)
    classpath(drawingFormatClasses)
    classpath(provider { project(":app").configurations.getByName("debugCompileClasspath") })
    mainClass.set("com.diexar.keepcapture.DrawingFormatCheckKt")
    args(file("checks/fixtures/drawing-v1.png").absolutePath)
}

val paperDrawerClasses = layout.buildDirectory.dir("paper-drawer-check")
val paperDrawerSources = files("app/src/main/kotlin/com/diexar/keepcapture/PaperDrawer.kt",
    "app/src/main/kotlin/com/diexar/keepcapture/Metadata.kt", "app/src/main/kotlin/com/diexar/keepcapture/InlineTags.kt",
    "app/src/main/kotlin/com/diexar/keepcapture/ExpiryWords.kt", "checks/PaperDrawerR.kt", "checks/PaperDrawerColor.kt", "checks/PaperDrawerCheck.kt")
val paperDrawerCompile = tasks.register<JavaExec>("paperDrawerCompile") {
    inputs.files(paperDrawerSources)
    outputs.dir(paperDrawerClasses)
    classpath(buildscript.configurations.getByName("classpath"))
    mainClass.set("org.jetbrains.kotlin.cli.jvm.K2JVMCompiler")
    doFirst {
        args("-Xdisable-default-scripting-plugin", "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-classpath",
            project(":app").configurations.getByName("debugCompileClasspath").asPath,
            "-d", paperDrawerClasses.get().asFile.absolutePath)
        args(paperDrawerSources.files.map { it.absolutePath })
    }
}

// Paper drawer: the same expiry and warning rules as cloud/shared/paper.mjs.
tasks.register<JavaExec>("checkPaperDrawer") {
    dependsOn(paperDrawerCompile)
    classpath(paperDrawerClasses)
    classpath(provider { project(":app").configurations.getByName("debugCompileClasspath") })
    mainClass.set("com.diexar.keepcapture.PaperDrawerCheckKt")
    args(file("../cloud/shared/fixtures/expiry-cases.tsv").absolutePath)
}

val inlineTagsClasses = layout.buildDirectory.dir("inline-tags-check")
val inlineTagsSources = files("app/src/main/kotlin/com/diexar/keepcapture/InlineTags.kt",
    "app/src/main/kotlin/com/diexar/keepcapture/CardText.kt", "checks/InlineTagsCheck.kt")
val inlineTagsCompile = tasks.register<JavaExec>("inlineTagsCompile") {
    inputs.files(inlineTagsSources)
    outputs.dir(inlineTagsClasses)
    classpath(buildscript.configurations.getByName("classpath"))
    mainClass.set("org.jetbrains.kotlin.cli.jvm.K2JVMCompiler")
    doFirst {
        args("-Xdisable-default-scripting-plugin", "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-classpath",
            project(":app").configurations.getByName("debugCompileClasspath").asPath,
            "-d", inlineTagsClasses.get().asFile.absolutePath)
        args(inlineTagsSources.files.map { it.absolutePath })
    }
}

tasks.register<JavaExec>("checkInlineTags") {
    dependsOn(inlineTagsCompile)
    classpath(inlineTagsClasses)
    classpath(provider { project(":app").configurations.getByName("debugCompileClasspath") })
    mainClass.set("com.diexar.keepcapture.InlineTagsCheckKt")
}

// Live list links: the same rules for what a guest may change and the same sealing as cloud/shared/list-links.mjs.
val listLinkClasses = layout.buildDirectory.dir("list-link-check")
val listLinkSources = files("app/src/main/kotlin/com/diexar/keepcapture/CloudCrypto.kt",
    "app/src/main/kotlin/com/diexar/keepcapture/CloudListRules.kt", "checks/ListLinkCheck.kt")
val listLinkCompile = tasks.register<JavaExec>("listLinkCompile") {
    inputs.files(listLinkSources)
    outputs.dir(listLinkClasses)
    classpath(buildscript.configurations.getByName("classpath"))
    mainClass.set("org.jetbrains.kotlin.cli.jvm.K2JVMCompiler")
    doFirst {
        args("-Xdisable-default-scripting-plugin", "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-classpath",
            project(":app").configurations.getByName("debugCompileClasspath").asPath,
            "-d", listLinkClasses.get().asFile.absolutePath)
        args(listLinkSources.files.map { it.absolutePath })
    }
}

tasks.register<JavaExec>("checkListLinks") {
    dependsOn(listLinkCompile)
    classpath(listLinkClasses)
    classpath(provider { project(":app").configurations.getByName("debugCompileClasspath") })
    mainClass.set("com.diexar.keepcapture.ListLinkCheckKt")
    doFirst {
        args(requireNotNull(System.getenv("JOTDROP_LIST_LINK_INPUT")), requireNotNull(System.getenv("JOTDROP_LIST_LINK_OUTPUT")))
    }
}

// Ask JotDrop: the same requests, answers, tool rules and note edits as cloud/shared/ai and cloud/web/ai-web.mjs.
val aiClasses = layout.buildDirectory.dir("ai-check")
val aiSources = files(listOf("AiJson", "AiRedact", "AiTools", "AiContext", "AiProviders", "AiAssistant", "AiNoteEdits", "AiAsk", "CloudVersionDiff")
    .map { "app/src/main/kotlin/com/diexar/keepcapture/$it.kt" } + "checks/AiCheck.kt")
val aiCompile = tasks.register<JavaExec>("aiCompile") {
    inputs.files(aiSources)
    outputs.dir(aiClasses)
    classpath(buildscript.configurations.getByName("classpath"))
    mainClass.set("org.jetbrains.kotlin.cli.jvm.K2JVMCompiler")
    doFirst {
        args("-Xdisable-default-scripting-plugin", "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-classpath",
            project(":app").configurations.getByName("debugCompileClasspath").asPath,
            "-d", aiClasses.get().asFile.absolutePath)
        args(aiSources.files.map { it.absolutePath })
    }
}

tasks.register<JavaExec>("checkAi") {
    dependsOn(aiCompile)
    classpath(aiClasses)
    classpath(provider { project(":app").configurations.getByName("debugCompileClasspath") })
    mainClass.set("com.diexar.keepcapture.AiCheckKt")
    doFirst {
        args(listOf("JOTDROP_AI_VECTORS", "JOTDROP_AI_TOOLS", "JOTDROP_AI_PROMPT", "JOTDROP_AI_EDITS").map { requireNotNull(System.getenv(it)) { "Run through npm run check:ai-android" } })
    }
}

val cloudAccountClasses = layout.buildDirectory.dir("cloud-account-check")
val cloudAccountSources = files("app/src/main/kotlin/com/diexar/keepcapture/CloudCrypto.kt",
    "app/src/main/kotlin/com/diexar/keepcapture/CloudAccountCrypto.kt", "app/src/main/kotlin/com/diexar/keepcapture/CloudWords.kt",
    "../cloud/android/CloudAccountCryptoCheck.kt")
val cloudAccountCompile = tasks.register<JavaExec>("cloudAccountCompile") {
    inputs.files(cloudAccountSources)
    outputs.dir(cloudAccountClasses)
    classpath(buildscript.configurations.getByName("classpath"))
    mainClass.set("org.jetbrains.kotlin.cli.jvm.K2JVMCompiler")
    doFirst {
        args("-Xdisable-default-scripting-plugin", "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-classpath",
            project(":app").configurations.getByName("debugCompileClasspath").asPath,
            "-d", cloudAccountClasses.get().asFile.absolutePath)
        args(cloudAccountSources.files.map { it.absolutePath })
    }
}

tasks.register<JavaExec>("checkCloudAccount") {
    dependsOn(cloudAccountCompile)
    classpath(cloudAccountClasses)
    classpath(provider { project(":app").configurations.getByName("debugCompileClasspath") })
    mainClass.set("com.diexar.keepcapture.CloudAccountCryptoCheckKt")
    doFirst {
        args(requireNotNull(System.getenv("JOTDROP_ACCOUNT_INPUT")), requireNotNull(System.getenv("JOTDROP_ACCOUNT_OUTPUT")))
    }
}
