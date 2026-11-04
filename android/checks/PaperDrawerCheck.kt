package com.diexar.keepcapture

import java.time.LocalDate

/** The same cases as cloud/shared/paper.test.mjs, so every platform reads and warns alike. */
fun main() {
    require(PaperDrawer.validExpires("2027-03-12") == "2027-03-12")
    require(PaperDrawer.validExpires(" 2028-02-29 ") == "2028-02-29")
    for (bad in listOf("2027-02-29", "2027-13-01", "2027-3-12", "12-03-2027", "", null, "2027-03-12T09:00")) {
        require(PaperDrawer.validExpires(bad) == null) { "accepted $bad" }
    }

    require(!PaperDrawer.isExpired("2027-03-12", LocalDate.parse("2027-03-11")))
    require(!PaperDrawer.isExpired("2027-03-12", LocalDate.parse("2027-03-12")))
    require(PaperDrawer.isExpired("2027-03-12", LocalDate.parse("2027-03-13")))

    val warn = mapOf(
        ("2027-03-12" to "1w") to "2027-03-05T09:00",
        ("2027-03-03" to "1w") to "2027-02-24T09:00",
        ("2027-03-12" to "1m") to "2027-02-12T09:00",
        ("2027-03-31" to "1m") to "2027-02-28T09:00",
        ("2028-03-31" to "1m") to "2028-02-29T09:00",
        ("2027-01-15" to "2m") to "2026-11-15T09:00",
        ("2027-05-31" to "3m") to "2027-02-28T09:00",
    )
    for ((input, expected) in warn) {
        val actual = PaperDrawer.warnReminder(input.first, input.second)
        require(actual == expected) { "$input gave $actual" }
    }
    require(PaperDrawer.warnReminder("2027-03-12", "") == null)
    require(PaperDrawer.warnReminder("bad", "1m") == null)

    require(PaperDrawer.withLabel(emptyList()) == listOf("Paper drawer"))
    require(PaperDrawer.withLabel(listOf("Home")) == listOf("Home", "Paper drawer"))
    require(PaperDrawer.withLabel(listOf("paper DRAWER")) == listOf("paper DRAWER"))
    require(PaperDrawer.isPaperDrawer(" Paper Drawer "))
    require(!PaperDrawer.isPaperDrawer("Papers"))

    // expires survives every other metadata write and is set or cleared on its own.
    val note = "---\ncolor: blue\njotdrop_labels: [\"Home\"]\n---\n# Passport\n"
    val set = FrontmatterWriter.applyExpires(note, "2031-06-01")
    require(FrontmatterParser.parse(set).meta.expires == "2031-06-01") { set }
    require(set.contains("expires: \"2031-06-01\"")) { set }
    val recolored = FrontmatterWriter.apply(set, FrontmatterParser.parse(set).meta.copy(color = NoteColor.RED))
    require(FrontmatterParser.parse(recolored).meta.expires == "2031-06-01") { recolored }
    val fresh = FrontmatterWriter.apply(set, NoteMeta(pinned = true))
    require(FrontmatterParser.parse(fresh).meta.expires == "2031-06-01") { fresh }
    val cleared = FrontmatterWriter.applyExpires(set, null)
    require(FrontmatterParser.parse(cleared).meta.expires == null && cleared.contains("color: blue") && cleared.endsWith("# Passport\n")) { cleared }
    require(FrontmatterParser.parse("---\nexpires: 2027-02-30\n---\n").meta.expires == null)
    require(FrontmatterWriter.applyExpires("# Plain", "2030-01-01") == "---\nexpires: \"2030-01-01\"\n---\n# Plain")

    println("PaperDrawer checks passed")
}
