package com.diexar.keepcapture

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

// Videos and PDFs from cloud/shared/filekinds.json (kept equal by cloud/shared/filekinds-parity.test.mjs); photos and
// sounds are in Storage.kt and EditorActivity.kt. Anything else is a file with a paper clip.
private val VIDEO_EXTENSIONS = setOf("mp4", "mov", "mkv", "avi")
private val PDF_EXTENSIONS = setOf("pdf")

/** The icon for a file that shows as a chip: a PDF, a video, or any other file. The icon is never the only sign: the name is next to it. */
private fun chipIcon(name: String): ImageVector = when (name.substringAfterLast('.', "").lowercase()) {
    in PDF_EXTENSIONS -> Icons.Filled.PictureAsPdf
    in VIDEO_EXTENSIONS -> Icons.Filled.Movie
    else -> Icons.Filled.AttachFile
}

/** How many file chips a card shows before "+ N files", like the plugin and the website. */
internal const val CARD_FILE_CHIPS = 3

/**
 * A file in a note that is not a photo or recording (a PDF, a document) shows as a chip with its kind's icon, its
 * name and its size, on the card and in the editor, like the web app (Eric, 3 Nov; size 11 Nov). A tap opens it in
 * another app. With [onRemove] (the editor) a cross takes it off the note. In a row that scrolls sideways, give it a
 * [modifier] with a maximum width, or a long name gets no room next to the size.
 */
@Composable
internal fun DocumentChip(name: String, foreground: Color, size: Long = -1L, onRemove: (() -> Unit)? = null, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val sizeText = size.takeIf { it >= 0 }?.let(Attachments::formatSize)
    val openLabel = stringResource(R.string.attach_open, name)
    Surface(
        color = foreground.copy(alpha = 0.14f),
        contentColor = foreground,
        shape = RoundedCornerShape(10.dp),
        modifier = modifier,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Row(
                modifier = Modifier
                    .clickable(onClick = onClick)
                    .semantics { contentDescription = if (sizeText != null) "$openLabel, $sizeText" else openLabel }
                    .padding(start = 7.dp, end = if (onRemove != null) 2.dp else 7.dp, top = 2.dp, bottom = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(chipIcon(name), contentDescription = null, modifier = Modifier.size(13.dp))
                Spacer(Modifier.size(3.dp))
                Text(
                    text = name,
                    style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Medium),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (sizeText != null) {
                    Spacer(Modifier.size(4.dp))
                    Text(
                        text = sizeText,
                        style = MaterialTheme.typography.labelSmall,
                        color = foreground.copy(alpha = 0.7f),
                        maxLines = 1,
                    )
                }
            }
            if (onRemove != null) {
                val removeLabel = stringResource(R.string.attach_remove, name)
                Icon(
                    Icons.Filled.Close,
                    contentDescription = removeLabel,
                    modifier = Modifier
                        .clickable(onClick = onRemove)
                        .padding(horizontal = 5.dp, vertical = 3.dp)
                        .size(14.dp),
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun DocumentChips(documents: List<NoteDocument>, foreground: Color, selectionMode: Boolean, onCardClick: () -> Unit) {
    val context = LocalContext.current
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        for (document in documents.take(CARD_FILE_CHIPS)) {
            DocumentChip(document.name, foreground, size = document.size) {
                if (selectionMode) onCardClick() else openAttachment(context, document.uri, document.name)
            }
        }
        val more = documents.size - CARD_FILE_CHIPS
        if (more > 0) {
            // The rest is in the note: a tap opens it, like a tap on the card.
            Surface(
                color = foreground.copy(alpha = 0.08f),
                contentColor = foreground,
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.clickable(onClick = onCardClick),
            ) {
                Text(
                    text = pluralStringResource(R.plurals.attach_more, more, more),
                    style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Medium),
                    modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp),
                )
            }
        }
    }
}

/** Opens an attachment in the app the system has for it, like the lightbox's "Open externally". */
internal fun openAttachment(context: Context, uri: Uri, name: String) {
    val extension = name.substringAfterLast('.', "").lowercase()
    val type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "*/*"
    try {
        context.startActivity(
            Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, type)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            },
        )
    } catch (e: Throwable) {
        Toast.makeText(context, context.getString(R.string.toast_error, e.message ?: ""), Toast.LENGTH_SHORT).show()
    }
}
