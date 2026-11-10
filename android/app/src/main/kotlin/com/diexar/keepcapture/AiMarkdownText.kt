package com.diexar.keepcapture

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp

/**
 * The answer of Ask JotDrop with its simple Markdown shown: bold, italic, code, headings and bullets (AiMarkdown).
 * Bullets carry a dot and tasks a box character, so the meaning never rests on colour alone.
 */
@Composable
fun AiMarkdownText(text: String, modifier: Modifier = Modifier) {
    val blocks = remember(text) { AiMarkdown.parse(text) }
    val codeBackground = MaterialTheme.colorScheme.surfaceVariant
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        for (block in blocks) {
            when (block.kind) {
                MdKind.SPACE -> Spacer(Modifier.height(6.dp))
                MdKind.HEADING -> Text(
                    styled(block.spans, codeBackground),
                    style = when (block.level) {
                        1 -> MaterialTheme.typography.titleLarge
                        2 -> MaterialTheme.typography.titleMedium
                        else -> MaterialTheme.typography.titleSmall
                    },
                    modifier = Modifier.padding(top = 4.dp),
                )
                MdKind.BULLET -> Row(Modifier.padding(start = (16 * block.level).dp)) {
                    Text("•", modifier = Modifier.width(20.dp))
                    Text(styled(block.spans, codeBackground), modifier = Modifier.weight(1f))
                }
                MdKind.CODE -> Text(
                    styled(block.spans, codeBackground),
                    modifier = Modifier.fillMaxWidth(),
                )
                MdKind.PARAGRAPH -> Text(styled(block.spans, codeBackground))
            }
        }
    }
}

private fun styled(spans: List<MdSpan>, codeBackground: androidx.compose.ui.graphics.Color): AnnotatedString = buildAnnotatedString {
    for (span in spans) {
        withStyle(
            SpanStyle(
                fontWeight = if (span.bold) FontWeight.Bold else null,
                fontStyle = if (span.italic) FontStyle.Italic else null,
                fontFamily = if (span.code) FontFamily.Monospace else null,
                background = if (span.code) codeBackground else androidx.compose.ui.graphics.Color.Unspecified,
            ),
        ) { append(span.text) }
    }
}
