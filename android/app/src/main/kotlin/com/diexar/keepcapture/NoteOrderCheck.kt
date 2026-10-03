package com.diexar.keepcapture.order

import com.diexar.keepcapture.NoteOrder
import java.text.SimpleDateFormat
import java.util.Locale

/**
 * Standalone self-check voor NoteOrder. Puur (geen Android/Compose), dus
 * draaibaar op een kale JVM via `fun main()`. Bewust in een eigen package zodat
 * deze `main()` niet botst met `ReminderRecurrenceCheckKt.main` in
 * `com.diexar.keepcapture`.
 */
fun main() {
    checkStamp()
    checkRanks()
    checkPlanDrop()
    println("NoteOrder checks passed")
}

private val FMT = SimpleDateFormat("yyyy-MM-dd HHmmss", Locale.US)

private fun checkStamp() {
    val stamped = FMT.parse("2026-01-01 090000")!!.time
    require(NoteOrder.stampedCreatedMs("2026-01-01 090000 foo.md", FMT) == stamped) { "stamped" }
    require(NoteOrder.stampedCreatedMs("legacy-note.md", FMT) == null) { "unstamped" }
    // Dubbele punt (geen pure cijfers) → geen geldige stamp.
    require(NoteOrder.stampedCreatedMs("2026-01-01 09:00 foo.md", FMT) == null) { "colon not a stamp" }

    // Newest-sortering: stamp, anders lastModified (huidige gedrag).
    require(NoteOrder.noteCreatedMs("2026-01-01 090000 foo.md", 123L, FMT) == stamped) { "newest stamped" }
    require(NoteOrder.noteCreatedMs("legacy-note.md", 123L, FMT) == 123L) { "newest unstamped fallback" }
}

private fun checkRanks() {
    // Expliciete order wint.
    require(NoteOrder.manualRank(5.0, "anything.md") == 5.0) { "explicit order" }

    // Gestempeld zonder order → -stampMs (nieuwer = lagere rang = bovenaan).
    require(NoteOrder.manualRank(null, "2026-01-02 090000 a.md") <
        NoteOrder.manualRank(null, "2026-01-01 090000 b.md")) { "newest-first manual" }
    require(NoteOrder.manualRank(null, "2026-01-02 090000 a.md") == -20260102090000.0) { "timezone-independent rank" }

    // Unstamped zonder order → stabiel 0.0 (geen lastModified).
    require(NoteOrder.manualRank(null, "legacy-note.md") == 0.0) { "unstamped manual rank 0" }
    // Gestempelde rang is negatief en dus onder 0 → unstamped komt onderaan.
    require(NoteOrder.manualRank(null, "2026-01-01 090000 a.md") < 0.0) { "stamped rank negative" }
}

private fun checkPlanDrop() {
    // Midden: gemiddelde van buren.
    val mid = NoteOrder.planDrop(
        listOf(
            NoteOrder.OrderedNote("a", -300.0),
            NoteOrder.OrderedNote("b", -100.0),
            NoteOrder.OrderedNote("c", -50.0),
        ),
        "b",
    ) as NoteOrder.DropPlan.Assign
    require(mid.order == -175.0) { "midpoint: ${mid.order}" }

    // Bovenin zonder lo-grens: hi - 1.
    val top = NoteOrder.planDrop(
        listOf(NoteOrder.OrderedNote("b", 0.0), NoteOrder.OrderedNote("a", -100.0)),
        "b",
    ) as NoteOrder.DropPlan.Assign
    require(top.order == -101.0) { "top: ${top.order}" }

    // Onderaan zonder hi-grens: lo + 1.
    val bottom = NoteOrder.planDrop(
        listOf(NoteOrder.OrderedNote("a", -100.0), NoteOrder.OrderedNote("b", 0.0)),
        "b",
    ) as NoteOrder.DropPlan.Assign
    require(bottom.order == -99.0) { "bottom: ${bottom.order}" }

    // Geen numerieke ruimte (gelijke buren) → hernummer de hele sectie.
    val ren = NoteOrder.planDrop(
        listOf(
            NoteOrder.OrderedNote("a", 1.0),
            NoteOrder.OrderedNote("b", 1.0),
            NoteOrder.OrderedNote("c", 1.0),
        ),
        "b",
    ) as NoteOrder.DropPlan.Renumber
    require(ren.assignments == mapOf("a" to 0.0, "b" to 1.0, "c" to 2.0)) { "renumber: ${ren.assignments}" }
}
