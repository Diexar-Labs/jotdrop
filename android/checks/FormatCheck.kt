package com.diexar.keepcapture

import java.io.File
import java.util.Base64

/**
 * Holds Android to the formatting core of the web app: scripts/check-format-android.mjs writes the cases of
 * cloud/shared/format-vectors.json plus random notes as TSV, this answers each line with FormatCore's result in the
 * same flat form, and the script compares it with cloud/shared/format.mjs.
 */
private fun text(value: String) = String(Base64.getDecoder().decode(value), Charsets.UTF_8)
private fun code(value: String) = Base64.getEncoder().encodeToString(value.toByteArray(Charsets.UTF_8))
// The inserted text as UTF-16 units: a random selection can cut an emoji in half, which UTF-8 cannot carry.
private fun units(value: String) = value.map { it.code.toString(16) }.joinToString(".")
private fun edit(value: FormatCore.Edit?) = value?.let { "${it.from}:${it.to}:${units(it.insert)}:${it.selFrom}:${it.selTo}" } ?: "null"
// A move or a drop with the line the item is on; a delete or a menu change with its count.
private fun placed(value: FormatCore.Moved?) = value?.let { "${edit(it.edit)}:${it.line}" } ?: "null"
private fun counted(value: FormatCore.Counted?) = value?.let { "${edit(it.edit)}:${it.count}" } ?: "null"

fun main(arguments: Array<String>) {
    val output = File(arguments[0]).readLines().filter { it.isNotBlank() }.map { line ->
        val fields = line.split('\t')
        val input = text(fields[1])
        when (fields[0]) {
            "blocks" -> FormatCore.blocks(input).joinToString(",") { "${it.kind}:${it.fromLine}:${it.toLine}:${it.from}:${it.to}" }
            "cells" -> FormatCore.tableCells(input).joinToString(",", transform = ::code)
            "parse" -> FormatCore.parseTable(input.split('\n')).let { table ->
                table.align.joinToString(",") + "|" + table.header.joinToString(",", transform = ::code) + "|" +
                    table.rows.joinToString(";") { row -> row.joinToString(",", transform = ::code) }
            }
            "cellText" -> code(FormatCore.cellText(input))
            "cellSource" -> code(FormatCore.cellSource(input))
            "inline" -> FormatCore.inlineSpans(input).joinToString(",") { "${it.kind}:${it.from}:${it.to}:${it.openTo}:${it.closeFrom}" }
            "prefix" -> FormatCore.linePrefix(input).let { "${it.kind}:${it.indent}:${it.markFrom}:${it.markTo}" }
            "pair" -> FormatCore.emptyPair(input, fields[2].toInt(), fields[3].toInt())?.let { "${it.from}:${it.to}:${it.kinds.joinToString("+")}" } ?: "null"
            "active" -> FormatCore.activeFormats(input, fields[2].toInt(), fields[3].toInt()).joinToString(",")
            "apply" -> edit(FormatCore.applyFormat(input, fields[2].toInt(), fields[3].toInt(), fields[4]))
            "enter" -> edit(FormatCore.listEnterEdit(input, fields[2].toInt(), fields[3].toInt()))
            "backspace" -> edit(FormatCore.backspaceEdit(input, fields[2].toInt(), fields.getOrElse(4) { "" }.split(';').filter { it.isNotEmpty() }
                .map { range -> range.split('-').let { it[0].toInt() until it[1].toInt() } }))
            "table" -> {
                // Fields: fromLine, type, row, column, after, at, align, text (base64); `_` is a field that is not set.
                fun number(i: Int) = fields[i].takeIf { it != "_" }?.toInt()
                val op = FormatCore.TableOp(fields[3], row = number(4), column = number(5), after = number(6), at = number(7),
                    align = fields[8].takeIf { it != "_" }, text = fields[9].takeIf { it != "_" }?.let(::text))
                edit(FormatCore.tableEdit(input, fields[2].toInt(), op))
            }
            "levels" -> FormatCore.listLevels(input).joinToString(",")
            "items" -> FormatCore.listItems(input).joinToString(",")
            // Fields: selection from, to, the line, move (1 or 0).
            "tick" -> FormatCore.tickEdit(input, fields[4].toInt(), fields[5] == "1", fields[2].toInt(), fields[3].toInt())
                ?.let { "${edit(it.edit)}:${it.line}" } ?: "null"
            // Fields: selection from, to, and "in" or "out".
            "indent" -> edit(FormatCore.indentEdit(input, fields[2].toInt(), fields[3].toInt(), fields[4]))
            // Fields: selection from, to, move (1 or 0).
            "checklist" -> edit(FormatCore.checklistEdit(input, fields[2].toInt(), fields[3].toInt(), fields[4] == "1"))
            // Checklists in an open note (design checklists-77). Fields: selection from, to, the line, "up" or "down".
            "move" -> placed(FormatCore.moveItemEdit(input, fields[4].toInt(), fields[5], fields[2].toInt(), fields[3].toInt()))
            // Fields: the line.
            "slots" -> FormatCore.dropSlots(input, fields[2].toInt()).joinToString(",") { "${it.before}:${it.minLevel}:${it.maxLevel}" }
            // Fields: selection from, to, the line, the line it lands in front of, the level.
            "drop" -> placed(FormatCore.dropItemEdit(input, fields[4].toInt(), fields[5].toInt(), fields[6].toInt(), fields[2].toInt(), fields[3].toInt()))
            // Fields: selection from, to, the line.
            "delete" -> counted(FormatCore.deleteItemEdit(input, fields[4].toInt(), fields[2].toInt(), fields[3].toInt()))
            // Fields: the line.
            "span" -> FormatCore.itemSpan(input, fields[2].toInt())?.let { "${it.line}:${it.end}:${it.count}:${it.place}:${it.of}" } ?: "null"
            // Fields: selection from, to.
            "uncheckAll" -> counted(FormatCore.uncheckAllEdit(input, fields[2].toInt(), fields[3].toInt()))
            "deleteChecked" -> counted(FormatCore.deleteCheckedEdit(input, fields[2].toInt(), fields[3].toInt()))
            // Fields: selection from, to, the pasted text (base64).
            "paste" -> edit(FormatCore.pasteLinesEdit(input, fields[2].toInt(), fields[3].toInt(), text(fields.getOrElse(4) { "" })))
            // The ticked end of a list and "+ List item" (design checklists-77-v2, part 6). Fields of addItem: the line.
            "tail" -> FormatCore.checkedTail(input).joinToString(",") { "${it.from}:${it.to}:${it.count}" }
            "addItem" -> placed(FormatCore.addItemEdit(input, fields[2].toInt()))
            else -> error("Unknown case ${fields[0]}")
        }
    }
    File(arguments[1]).writeText(output.joinToString("\n"))
    println("Android format core: ${output.size} cases answered")
}
