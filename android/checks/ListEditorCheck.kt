package com.diexar.keepcapture

fun main() {
    fun enter(text: String, expected: String, start: Int = text.length, end: Int = start) {
        val edit = checkNotNull(listEnterEdit(text, start, end)) { "Expected a list edit: $text" }
        check(text.replaceRange(edit.from, edit.to, edit.insert) == expected) { "Wrong list edit: $text" }
    }
    enter("- alpha", "- alpha\n- ")
    enter("* alpha", "* alpha\n- ")
    enter("  - [x] alpha", "  - [x] alpha\n  - [ ] ")
    enter("\t* alpha", "\t* alpha\n\t- ")
    enter("- [X] alpha", "- [X] alpha\n- [ ] ")
    enter("- ", "")
    enter("  - [ ] ", "")
    enter("- [x]", "")
    enter("- alpha\n  * \nnext", "- alpha\n\nnext", 12)
    enter("- alpha beta", "- alpha\n-  beta", 7)
    enter("- [x] alpha beta", "- [x] alpha\n- [ ]  beta", 11)
    enter("- alpha beta", "- al\n- beta", 4, 8)
    enter("- alpha\n- beta", "- alpha\n- \n- beta", 7)
    enter("```\n- code\n```\n- note", "```\n- code\n```\n- note\n- ")
    for (text in listOf("plain", "-no list", "---", "*em*", "```\n- code", "~~~text\n- code", "````\n```\n- code")) {
        check(listEnterEdit(text, text.length) == null) { "Unexpected list edit: $text" }
    }
    check(listEnterEdit("- alpha", 1) == null)
    check(listEnterEdit("- alpha\n- beta", 4, 12) == null)
    val source = "- alpha\n  * beta\n- [x] task\n```\n- code\n```\n+ gamma"
    val rendered = renderListBullets(source)
    check(rendered == "\u2022 alpha\n  \u2022 beta\n- [x] task\n```\n- code\n```\n\u2022 gamma")
    check(source.length == rendered.length) { "Visual transformation must preserve every source offset" }
    println("Android list editor checks passed")
}
