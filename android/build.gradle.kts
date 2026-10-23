plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
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
