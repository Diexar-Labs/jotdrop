package com.diexar.keepcapture

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

/**
 * Standalone self-check voor Storage/LabelNames. Puur (geen Android/Compose),
 * dus draaibaar op een kale JVM via `fun main()`.
 */
fun main() {
    checkLabelNamesNormalized()
    checkLabelNamesValidate()
    checkLabelNamesRoundTrip()
    checkCollectionMetadata()
    val concurrent = listOf("Work", "Concurrent")
    check(LabelNames.applyChanges(concurrent, setOf("Home"), setOf("WORK")) == listOf("Concurrent", "Home"))
    check(LabelNames.applyChanges(concurrent, emptySet(), emptySet()) == concurrent)
    check(LabelNames.applyChanges(concurrent, setOf("work"), emptySet()) == concurrent)
    check(LabelNames.matchesSelection(listOf("work"), setOf("Work")))
    check(LabelNames.matchesSelection(listOf("Work"), setOf("work", "other")))
    check(!LabelNames.matchesSelection(listOf("home"), setOf("Work")))
    check(LabelNames.matchesSelection(emptyList(), emptySet()))
    checkMemoSaveLifecycle()
    println("Label and memo-save checks passed")
}

private fun checkMemoSaveLifecycle() = runBlocking {
    val activity = CoroutineScope(Job() + Dispatchers.Default)
    val started = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()
    var cleared = false
    var duplicate = false
    val request = activity.launch {
        VoiceMemoSave.save(
            action = { started.complete(Unit); release.await(); Result.success("memo.md") },
            onSaved = { cleared = true },
        )
    }
    withTimeout(5000) { started.await(); request.join() }
    activity.cancel() // Simulate destroying the originating Activity while IO is blocked.
    check(VoiceMemoSave.saving.value)
    VoiceMemoSave.save({ duplicate = true; Result.success("duplicate.md") }, {})
    release.complete(Unit)
    withTimeout(5000) { VoiceMemoSave.saving.first { !it } }
    check(cleared && !duplicate && VoiceMemoSave.saved.value == "memo.md")

    cleared = false
    VoiceMemoSave.saved.value = null
    VoiceMemoSave.save({ Result.failure(IllegalStateException("vault unavailable")) }, { cleared = true })
    withTimeout(5000) { VoiceMemoSave.saving.first { !it } }
    check(!cleared && VoiceMemoSave.failure.value == "vault unavailable")
    VoiceMemoSave.save({ Result.success("retry.md") }, { cleared = true })
    withTimeout(5000) { VoiceMemoSave.saving.first { !it } }
    check(cleared && VoiceMemoSave.saved.value == "retry.md" && VoiceMemoSave.failure.value == null)
}

private fun checkLabelNamesNormalized() {
    check(LabelNames.normalized("my label") == "my label")
    check(LabelNames.normalized("  label  ") == "label")
    check(LabelNames.normalized("#Project") == "#Project")
    check(LabelNames.normalized("2026") == "2026")
    check(LabelNames.normalized("") == null)
    check(LabelNames.normalized("   ") == null)
    check(LabelNames.normalized("line\nbreak") == null)
}

private fun checkLabelNamesValidate() {
    check(LabelNames.validate("Work projects"))
    check(LabelNames.validate("Client, media"))
    check(LabelNames.validate("2026"))
    check(!LabelNames.validate(""))
    check(!LabelNames.validate("bad\u0000name"))
}

private fun checkCollectionMetadata() {
    val original = "---\ntags:\n  - work\n  - hundreds_of_other_tags\ncustom: keep\n---\n\n# Body\nText stays intact.\n"
    val names = listOf("Work projects", "Client, media", "Bob's notes", "Quote \"name\"", "Path \\ label", "#Project")
    val assigned = FrontmatterWriter.applyLabels(original, names)
    val parsed = FrontmatterParser.parse(assigned)
    check(parsed.meta.labels == names)
    check(parsed.meta.tags == FrontmatterParser.parse(original).meta.tags)
    check(parsed.body == FrontmatterParser.parse(original).body)
    check(assigned.contains("tags:\n  - work\n  - hundreds_of_other_tags\ncustom: keep"))
    val tagEdit = FrontmatterWriter.apply(assigned, parsed.meta.copy(tags = listOf("changed_tag")))
    check(FrontmatterParser.parse(tagEdit).meta.labels == names)
    val removed = FrontmatterWriter.applyLabels(assigned, emptyList())
    check(FrontmatterParser.parse(removed).meta.labels.isEmpty())
    check(FrontmatterParser.parse(removed).meta.tags == parsed.meta.tags)
    check(FrontmatterParser.parse(original).meta.labels.isEmpty())
    val newNote = FrontmatterWriter.apply("# New note", NoteMeta(tags = listOf("tag")), labels = listOf("Projects"))
    check(FrontmatterParser.parse(newNote).meta.labels == listOf("Projects"))
    check(FrontmatterParser.parse(newNote).meta.tags == listOf("tag"))
}

private fun checkLabelNamesRoundTrip() {
    val inputs = listOf("hello world", "test-tag", "my/tag", "#prefix", "  trim  ")
    for (input in inputs) {
        val n = LabelNames.normalized(input)
        if (n != null) {
            require(LabelNames.validate(n)) { "roundtrip: $input" }
        }
    }
}
