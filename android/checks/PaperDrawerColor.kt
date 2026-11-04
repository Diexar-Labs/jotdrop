package androidx.compose.ui.graphics

// Stand-in for Compose's Color (an Android library), so Metadata.kt compiles for checkPaperDrawer on a bare JVM.
class Color(val value: Long)
