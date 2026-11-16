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
            else -> error("Unknown case ${fields[0]}")
        }
    }
    File(arguments[1]).writeText(output.joinToString("\n"))
    println("Android format core: ${output.size} cases answered")
}
