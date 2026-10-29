package com.diexar.keepcapture

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp

/**
 * Markdown help: the codes most people forget, the same list as the web app
 * and the Obsidian plugin. Each row shows the code and what it turns into.
 */
private val MARKDOWN_HELP_ROWS = listOf(
    "# Heading" to R.string.md_help_heading,
    "## Smaller heading" to R.string.md_help_smaller_heading,
    "**bold**" to R.string.md_help_bold,
    "*italic*" to R.string.md_help_italic,
    "~~strikethrough~~" to R.string.md_help_strikethrough,
    "==highlight==" to R.string.md_help_highlight,
    "- item" to R.string.md_help_bullet,
    "1. item" to R.string.md_help_numbered,
    "- [ ] task" to R.string.md_help_task,
    "- [x] done" to R.string.md_help_done,
    "> quote" to R.string.md_help_quote,
    "`code`" to R.string.md_help_code,
    "[text](https://example.com)" to R.string.md_help_web_link,
    "[[Note name]]" to R.string.md_help_note_link,
    "#tag" to R.string.md_help_tag,
    "---" to R.string.md_help_divider,
    "| A | B |\n| --- | --- |\n| 1 | 2 |" to R.string.md_help_table,
)

@Composable
fun MarkdownHelpDialog(onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.md_help_title)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(
                    stringResource(R.string.md_help_intro),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 8.dp),
                )
                for ((code, result) in MARKDOWN_HELP_ROWS) {
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                        Text(code, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f).padding(end = 12.dp))
                        Text(styled(code, stringResource(result)), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    }
                    HorizontalDivider()
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_close)) } },
    )
}

/** Shows the result the way Markdown apps render it: bold, italic, struck through, highlighted. */
private fun styled(code: String, text: String) = buildAnnotatedString {
    val style = when {
        code.startsWith("# ") || code.startsWith("## ") || code.startsWith("**") -> SpanStyle(fontWeight = FontWeight.Bold)
        code.startsWith("*") -> SpanStyle(fontStyle = FontStyle.Italic)
        code.startsWith("~~") -> SpanStyle(textDecoration = TextDecoration.LineThrough)
        code.startsWith("==") -> SpanStyle(background = Color(0x66FFE066))
        code.startsWith("`") -> SpanStyle(fontFamily = FontFamily.Monospace)
        code.startsWith("[") -> SpanStyle(textDecoration = TextDecoration.Underline)
        else -> SpanStyle()
    }
    withStyle(style) { append(text) }
}
