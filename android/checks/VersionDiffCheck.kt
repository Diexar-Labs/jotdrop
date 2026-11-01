package com.diexar.keepcapture

import com.diexar.keepcapture.CloudVersionDiff.Kind

// The same cases as cloud/shared/diff.test.mjs, so the website and the app show the same difference.
private fun kinds(lines: List<CloudVersionDiff.Line>?) = lines!!.map { "${it.kind.name.first().lowercase()}:${it.text}" }

fun main() {
    check(kinds(CloudVersionDiff.lines("milk\nbread\neggs", "milk\nbutter\neggs")) == listOf("s:milk", "r:bread", "a:butter", "s:eggs"))
    check(kinds(CloudVersionDiff.lines("one", "zero\none\ntwo")) == listOf("a:zero", "s:one", "a:two"))
    check(kinds(CloudVersionDiff.lines("zero\none\ntwo", "one")) == listOf("r:zero", "s:one", "r:two"))
    check(CloudVersionDiff.lines("a\nb", "a\r\nb")!!.all { it.kind == Kind.SAME })
    check(kinds(CloudVersionDiff.lines("", "a")) == listOf("r:", "a:a"))

    fun many(prefix: String) = (0 until 3000).joinToString("\n") { "$prefix$it" }
    check(CloudVersionDiff.lines(many("a"), many("b")) == null)
    check(CloudVersionDiff.lines(many("a"), many("a") + "\nextra") != null)

    val before = (0 until 20).joinToString("\n") { "line $it" }
    val folded = CloudVersionDiff.fold(CloudVersionDiff.lines(before, before.replace("line 10", "changed"))!!)
    check(folded.map { it.kind } == listOf(Kind.GAP, Kind.SAME, Kind.SAME, Kind.REMOVED, Kind.ADDED, Kind.SAME, Kind.SAME, Kind.GAP))
    check(folded[0].count == 8 && folded[7].count == 7)
    check(CloudVersionDiff.fold(CloudVersionDiff.lines("a\nb", "a\nb")!!) == listOf(CloudVersionDiff.Line(Kind.GAP, count = 2)))
    println("Version compare checks passed")
}
