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

    // Small drawers, the same cases as cloud/shared/paper.test.mjs.
    require(PaperDrawer.drawerLabel(" Work ") == "Paper drawer/Work")
    require(PaperDrawer.drawerName("Paper drawer/Work") == "Work")
    require(PaperDrawer.drawerName("Paper drawer") == "" && PaperDrawer.drawerName("Work") == "")
    require(PaperDrawer.isPaperDrawer("paper drawer/Home") && !PaperDrawer.isPaperDrawer("Paper drawer/") && !PaperDrawer.isPaperDrawer("Paper drawers"))
    require(PaperDrawer.withLabel(listOf("Paper drawer/Work")) == listOf("Paper drawer/Work"))
    require(PaperDrawer.inDrawer(listOf("Paper drawer/Work"), "Paper drawer"))
    require(PaperDrawer.inDrawer(listOf("Paper drawer"), "Paper drawer"))
    require(PaperDrawer.inDrawer(listOf("paper drawer/work"), "Paper drawer/Work"))
    require(!PaperDrawer.inDrawer(listOf("Paper drawer/Home"), "Paper drawer/Work"))
    require(!PaperDrawer.inDrawer(listOf("Paper drawer"), "Paper drawer/Work"))
    require(!PaperDrawer.inDrawer(listOf("Home"), "Home"))

    // Expiry dates found in scanned text, the same texts as cloud/shared/paper.test.mjs.
    val expiry = linkedMapOf(
        "Policy certificate\nStart date: 04-11-2026\nValid until: 12-03-2031\nPremium: EUR 214.00" to "2031-03-12",
        "Geldig tot 01.02.2030" to "2030-02-01",
        "VERVALDATUM\n15 mrt 2032" to "2032-03-15",
        "Date of expiry / Date d'expiration\n23 SEP 2033" to "2033-09-23",
        "Best before 2027-06-30" to "2027-06-30",
        "Expires: 06/30/2028" to "2028-06-30",
        "THT 12.03.27" to "2027-03-12",
        "Fecha de caducidad: 5 de mayo de 2031" to "",
        "Válido hasta 05/05/2031" to "2031-05-05",
        "Valid until 12-03-2031\nexpires 01-01-2029" to "2031-03-12",
        "Invoice date 04-11-2026\nTotal 12.00" to "",
        "Valid until 31-02-2031" to "",
        "" to "",
        "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10" to "2012-04-15",
        "L898902C3 6UTO7408122F1204159ZE184226B<<<<< 10" to "2012-04-15",
        "L898902C36UTO7408122F1204158ZE184226B<<<<<10\nDate of expiry 15 APR 2032" to "2032-04-15",
        "7408122F1204159UTO<<<<<<<<<<<6" to "2012-04-15",
    )
    for ((text, expected) in expiry) {
        val actual = PaperDrawer.findExpiry(text)
        require(actual == expected) { "findExpiry(${text.take(40)}) gave $actual, expected $expected" }
    }

    println("PaperDrawer checks passed")
}
