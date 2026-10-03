package com.diexar.keepcapture

import java.text.SimpleDateFormat

/**
 * Handmatige-volgorde-logica, gedeeld door de lijst-UI en Storage. Puur
 * (geen Android/Compose-afhankelijkheden) zodat de self-check op een kale JVM
 * kan draaien. Sleutels zijn URI-strings.
 *
 * Gedeeld interoperabel schema met de plugin: flat YAML `order` (eindig getal,
 * oplopend) per sectie. Bij gelijke rang breekt de deterministische bestandsnaam
 * de gelijkstand.
 */
object NoteOrder {

    data class OrderedNote(val key: String, val rank: Double)

    // `yyyy-MM-dd HHmmss`-prefix, zoals geschreven bij capture. De plugin
    // herkent dezelfde gestempelde namen voor handmatige rangschikking.
    private val STAMP = Regex("^(\\d{4}-\\d{2}-\\d{2} \\d{6})")

    /** Aanmaaktijd uit de bestandsnaam-stamp, of null bij ontbrekende/ongeldige stamp. */
    fun stampedCreatedMs(filename: String, fmt: SimpleDateFormat): Long? {
        val m = STAMP.find(filename) ?: return null
        return try {
            fmt.parse(m.value)?.time
        } catch (_: Exception) {
            null
        }
    }

    /** Newest-sortering: stamp, anders lastModified (huidige gedrag, ongewijzigd). */
    fun noteCreatedMs(filename: String, lastModified: Long, fmt: SimpleDateFormat): Long =
        stampedCreatedMs(filename, fmt) ?: lastModified

    /**
     * Handmatige rang: expliciete `order`; anders de negatieve stampcijfers voor gestempelde
     * namen; anders stabiel `0.0` voor unstamped namen. Bewust GEEN lastModified —
     * die verandert bij bewerken. De cijfers zijn op beide toestellen gelijk,
     * ongeacht hun ingestelde tijdzone.
     */
    fun manualRank(order: Double?, filename: String): Double {
        order?.let { return it }
        val stamped = STAMP.find(filename)?.value ?: return 0.0
        return -stamped.filter(Char::isDigit).toDouble()
    }

    sealed interface DropPlan {
        /** Schrijf alleen de verplaatste notitie. */
        data class Assign(val order: Double) : DropPlan
        /** Geen numerieke ruimte: hernummer de hele sectie met oplopende integers. */
        data class Renumber(val assignments: Map<String, Double>) : DropPlan
    }

    /**
     * Bepaalt de nieuwe `order` voor [movedKey] binnen [section], die al in de
     * gewenste eindvolgorde staat (verplaatste notitie op zijn plek). De buren
     * van de verplaatste notitie leveren de lo/hi-grenzen; een gemiddelde dat
     * niet strikt tussen beide valt betekent "geen numerieke ruimte" → hernummer
     * de hele sectie.
     */
    fun planDrop(section: List<OrderedNote>, movedKey: String): DropPlan {
        val movedIndex = section.indexOfFirst { it.key == movedKey }
        if (movedIndex < 0) return DropPlan.Assign(0.0)
        val lo = section.getOrNull(movedIndex - 1)?.rank
        val hi = section.getOrNull(movedIndex + 1)?.rank
        val assigned = assignBetween(lo, hi)
        if (assigned != null) return DropPlan.Assign(assigned)
        val map = HashMap<String, Double>(section.size)
        section.forEachIndexed { i, n -> map[n.key] = i.toDouble() }
        return DropPlan.Renumber(map)
    }

    /** Geeft een strikt-tussenwaarde terug, of null als er geen numerieke ruimte is. */
    private fun assignBetween(lo: Double?, hi: Double?): Double? {
        return when {
            lo == null && hi == null -> 0.0
            lo == null -> hi!! - 1.0
            hi == null -> lo + 1.0
            else -> {
                val mid = (lo + hi) / 2.0
                if (mid > lo && mid < hi) mid else null
            }
        }
    }
}
