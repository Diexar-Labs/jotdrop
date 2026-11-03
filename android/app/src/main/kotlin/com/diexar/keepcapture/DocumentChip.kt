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
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/**
 * A file in a note that is not a photo or recording (a PDF, a document) shows as a chip with a
 * paper clip and its name, on the card and in the editor, like the web app (Eric, 3 Nov). A tap
 * opens it in another app. The clip, not only the text, says it is a file.
 */
@Composable
internal fun DocumentChip(name: String, foreground: Color, onClick: () -> Unit) {
    Surface(
        color = foreground.copy(alpha = 0.14f),
        contentColor = foreground,
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.clickable(onClick = onClick),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.AttachFile, contentDescription = null, modifier = Modifier.size(13.dp))
            Spacer(Modifier.size(3.dp))
            Text(
                text = name,
                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Medium),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
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
        for (document in documents) {
            DocumentChip(document.name, foreground) {
                if (selectionMode) onCardClick() else openAttachment(context, document.uri, document.name)
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
