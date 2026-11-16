package com.diexar.keepcapture

import android.content.Context
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.FormatListBulleted
import androidx.compose.material.icons.filled.BorderColor
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.EmojiEmotions
import androidx.compose.material.icons.filled.FormatBold
import androidx.compose.material.icons.filled.FormatItalic
import androidx.compose.material.icons.filled.FormatListNumbered
import androidx.compose.material.icons.filled.FormatQuote
import androidx.compose.material.icons.filled.FormatStrikethrough
import androidx.compose.material.icons.filled.HorizontalRule
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Title
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The editor's own choices on this device: the Markdown switch and the recently used emoji. */
internal object EditorPrefs {
    private fun prefs(context: Context) = context.getSharedPreferences("editor", Context.MODE_PRIVATE)
    fun markdown(context: Context): Boolean = prefs(context).getBoolean("markdown", false)
    fun setMarkdown(context: Context, on: Boolean) = prefs(context).edit().putBoolean("markdown", on).apply()
    fun recentEmoji(context: Context): List<String> =
        prefs(context).getString("recent_emoji", "").orEmpty().split(' ').filter { it in EMOJI_ALL }.take(8)
    fun useEmoji(context: Context, emoji: String) {
        val recent = (listOf(emoji) + recentEmoji(context).filter { it != emoji }).take(8)
        prefs(context).edit().putString("recent_emoji", recent.joinToString(" ")).apply()
    }
}

/** The same emoji, in the same groups, as the web app (cloud/web/app.js, EMOJI). TalkBack reads each emoji's own name. */
private val EMOJI = listOf(
    R.string.emoji_smileys to listOf("😀", "😂", "😊", "😍", "🤔", "😎", "😢", "😮", "😴", "🥳"),
    R.string.emoji_hands to listOf("👍", "👎", "👏", "🙏", "👋", "💪", "🤝", "✌️"),
    R.string.emoji_hearts to listOf("❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "💔"),
    R.string.emoji_ticks to listOf("✅", "✔️", "☑️", "❌", "⭐", "🌟", "✨", "⚡", "🔥", "💯"),
    R.string.emoji_food to listOf("☕", "🍕", "🍎", "🥗", "🍰", "🍷", "🥖", "🧀"),
    R.string.emoji_travel to listOf("✈️", "🚗", "🚲", "🏠", "🏖️", "🗺️", "🧳", "⛰️"),
    R.string.emoji_symbols to listOf("📌", "📅", "⏰", "💡", "📝", "🎁", "🎉", "⚠️", "❓", "💬"),
)
private val EMOJI_ALL = EMOJI.flatMap { it.second }.toSet()

/** The body after a formatting button: one replacement from the shared core; null when nothing changes. */
internal fun TextFieldValue.withFormat(command: String): TextFieldValue? {
    val edit = FormatCore.applyFormat(text, selection.min, selection.max, command) ?: return null
    return TextFieldValue(text.replaceRange(edit.from, edit.to, edit.insert), TextRange(edit.selFrom, edit.selTo))
}

/** The body as it is saved: an empty pair at the caret (a button pressed, nothing typed yet) is not kept. */
internal fun TextFieldValue.withoutEmptyPair(): TextFieldValue {
    val pair = FormatCore.emptyPair(text, selection.min, selection.max) ?: return this
    return TextFieldValue(text.removeRange(pair.from, pair.to), TextRange(pair.from))
}

/**
 * [next] after [this]: when only the caret moved and it left an empty pair (a button pressed, then tapped elsewhere),
 * the pair goes, so no `****` stays behind in the note.
 */
internal fun TextFieldValue.leavingEmptyPair(next: TextFieldValue): TextFieldValue {
    if (next.text != text) return next
    val pair = FormatCore.emptyPair(text, selection.min, selection.max) ?: return next
    if (FormatCore.emptyPair(next.text, next.selection.min, next.selection.max)?.from == pair.from) return next
    val size = pair.to - pair.from
    fun map(at: Int) = when {
        at <= pair.from -> at
        at >= pair.to -> at - size
        else -> pair.from
    }
    return TextFieldValue(text.removeRange(pair.from, pair.to), TextRange(map(next.selection.start), map(next.selection.end)))
}

/**
 * [next] after [this]: when it is one Backspace right behind signs the formatted view hides, it becomes the shared
 * core's Backspace (FormatCore.backspaceEdit): the last visible letter goes, not half a hidden sign that would then show.
 */
internal fun TextFieldValue.backspacing(next: TextFieldValue, formatted: Boolean): TextFieldValue {
    if (!formatted || !selection.collapsed || !next.selection.collapsed) return next
    val caret = selection.start
    val removed = caret - next.selection.start
    if (removed !in 1..2 || next.text.length != text.length - removed || next.text != text.removeRange(caret - removed, caret)) return next
    val edit = FormatCore.backspaceEdit(text, caret, hiddenSigns(text)) ?: return next
    return TextFieldValue(text.replaceRange(edit.from, edit.to, edit.insert), TextRange(edit.selFrom))
}

/** One button of the bar: an icon with its name for TalkBack; "on" is a frame and a line under it, not only a color. */
@Composable
private fun BarButton(icon: ImageVector, @StringRes label: Int, foreground: Color, on: Boolean? = null, onClick: () -> Unit) {
    val name = stringResource(label)
    val shape = RoundedCornerShape(8.dp)
    val action = if (on == null) Modifier.clickable(role = Role.Button, onClick = onClick)
        else Modifier.toggleable(value = on, role = Role.Switch, onValueChange = { onClick() })
    Box(
        modifier = Modifier
            .size(44.dp)
            .padding(2.dp)
            .clip(shape)
            .then(if (on == true) Modifier.border(2.dp, foreground, shape) else Modifier)
            .then(action)
            .semantics { contentDescription = name },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = foreground)
        if (on == true) Box(
            Modifier.align(Alignment.BottomCenter).padding(bottom = 3.dp).width(18.dp).height(2.dp)
                .background(foreground, RoundedCornerShape(1.dp)),
        )
    }
}

/**
 * The formatting bar right above the keyboard (design part 5.3, 7.1): Bold · Italic · Heading · Bullets · Numbers ·
 * Checklist · Highlight · Emoji · More (Strikethrough, Quote, Code, Line), and at the end the Markdown switch, always in sight
 * so someone who knows Markdown switches to the raw text in one tap (Eric, 16 Nov). Tapping a button keeps the focus
 * and the keyboard in the text. Tables come with their grid (phase 4).
 */
@Composable
internal fun FormatBar(
    active: List<String>,
    markdown: Boolean,
    foreground: Color,
    onFormat: (String) -> Unit,
    onChecklist: () -> Unit,
    onEmoji: (String) -> Unit,
    onMarkdown: () -> Unit,
) {
    val context = LocalContext.current
    var emojiOpen by remember { mutableStateOf(false) }
    var moreOpen by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        HorizontalDivider(color = foreground.copy(alpha = 0.15f))
        if (emojiOpen) EmojiPanel(foreground) { emoji ->
            EditorPrefs.useEmoji(context, emoji)
            emojiOpen = false
            onEmoji(emoji)
        }
        // The buttons scroll sideways; the Markdown switch stays in sight at the end.
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(
            modifier = Modifier.weight(1f).horizontalScroll(rememberScrollState()),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BarButton(Icons.Filled.FormatBold, R.string.format_bold, foreground, "bold" in active) { onFormat("bold") }
            BarButton(Icons.Filled.FormatItalic, R.string.format_italic, foreground, "italic" in active) { onFormat("italic") }
            BarButton(Icons.Filled.Title, R.string.format_heading, foreground, "heading" in active) { onFormat("heading") }
            BarButton(Icons.AutoMirrored.Filled.FormatListBulleted, R.string.format_bullet, foreground, "bullet" in active) { onFormat("bullet") }
            BarButton(Icons.Filled.FormatListNumbered, R.string.format_numbered, foreground, "ordered" in active) { onFormat("ordered") }
            BarButton(Icons.Filled.CheckBox, R.string.action_checklist, foreground, "checklist" in active) { onChecklist() }
            BarButton(Icons.Filled.BorderColor, R.string.format_highlight, foreground, "highlight" in active) { onFormat("highlight") }
            BarButton(Icons.Filled.EmojiEmotions, R.string.format_emoji, foreground) { emojiOpen = !emojiOpen }
            Box {
                BarButton(Icons.Filled.MoreHoriz, R.string.format_more, foreground) { moreOpen = true }
                DropdownMenu(expanded = moreOpen, onDismissRequest = { moreOpen = false }) {
                    for ((command, label, icon) in listOf(
                        Triple("strike", R.string.format_strike, Icons.Filled.FormatStrikethrough),
                        Triple("quote", R.string.format_quote, Icons.Filled.FormatQuote),
                        Triple("code", R.string.format_code, Icons.Filled.Code),
                        Triple("rule", R.string.format_rule, Icons.Filled.HorizontalRule),
                    )) {
                        DropdownMenuItem(
                            text = { Text(stringResource(label) + if (command in active) "  ✓" else "") },
                            leadingIcon = { Icon(icon, contentDescription = null) },
                            onClick = { moreOpen = false; onFormat(command) },
                        )
                    }
                }
            }
        }
        MarkdownSwitch(markdown, foreground, onMarkdown)
        }
    }
}

/** The Markdown switch: "Markdown" or "✓ Markdown", a frame when on; TalkBack hears a switch with its state. */
@Composable
private fun MarkdownSwitch(on: Boolean, foreground: Color, onToggle: () -> Unit) {
    val shape = RoundedCornerShape(8.dp)
    Box(
        modifier = Modifier
            .padding(horizontal = 4.dp)
            .heightIn(min = 40.dp)
            .clip(shape)
            .border(if (on) 2.dp else 1.dp, foreground.copy(alpha = if (on) 1f else 0.4f), shape)
            .toggleable(value = on, role = Role.Switch, onValueChange = { onToggle() })
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            (if (on) "✓ " else "") + stringResource(R.string.format_markdown),
            color = foreground,
            fontWeight = if (on) FontWeight.Bold else FontWeight.Normal,
            style = MaterialTheme.typography.labelLarge,
        )
    }
}

/** About 60 emoji in groups plus the recently used ones; more come from the keyboard's own emoji key. */
@Composable
private fun EmojiPanel(foreground: Color, onPick: (String) -> Unit) {
    val context = LocalContext.current
    val recent = remember { EditorPrefs.recentEmoji(context) }
    val groups = (if (recent.isEmpty()) emptyList() else listOf(R.string.emoji_recent to recent)) + EMOJI
    LazyVerticalGrid(
        columns = GridCells.Adaptive(44.dp),
        modifier = Modifier.fillMaxWidth().height(220.dp).padding(horizontal = 8.dp),
        horizontalArrangement = Arrangement.Center,
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Text(stringResource(R.string.format_emoji_more), color = foreground.copy(alpha = 0.7f), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 6.dp))
        }
        for ((label, list) in groups) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Text(stringResource(label), color = foreground, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 8.dp, bottom = 2.dp))
            }
            items(list) { emoji ->
                Box(
                    modifier = Modifier.size(44.dp).clip(RoundedCornerShape(8.dp)).clickable(role = Role.Button) { onPick(emoji) },
                    contentAlignment = Alignment.Center,
                ) { Text(emoji, fontSize = 24.sp) }
            }
        }
    }
}
