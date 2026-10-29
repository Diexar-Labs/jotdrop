package com.diexar.keepcapture.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import com.diexar.keepcapture.R

// House style "Paper and ink", as on the website: paper, ink, amber and sky. Dark is the ink side, with amber as the main color.
private val Paper = Color(0xFFFBF8F1)
private val Ink = Color(0xFF14213D)
private val Amber = Color(0xFFF4C458)
private val Butter = Color(0xFFFFE9B0)
private val Sky = Color(0xFFDCE6F7)
private val InkPage = Color(0xFF0E1626)

private val LightColors = lightColorScheme(
    primary = Color(0xFF315FB4),
    onPrimary = Color.White,
    primaryContainer = Sky,
    onPrimaryContainer = Ink,
    secondary = Amber,
    onSecondary = Ink,
    secondaryContainer = Butter,
    onSecondaryContainer = Ink,
    background = Paper,
    onBackground = Ink,
    surface = Paper,
    onSurface = Ink,
    surfaceVariant = Color(0xFFF1EADB),
    onSurfaceVariant = Color(0xFF56607A),
    outline = Color(0xFFC9C1AE),
    outlineVariant = Color(0xFFE2D9C3),
)

private val DarkColors = darkColorScheme(
    primary = Amber,
    onPrimary = Ink,
    primaryContainer = Color(0xFF5A4718),
    onPrimaryContainer = Butter,
    secondary = Sky,
    onSecondary = Ink,
    secondaryContainer = Color(0xFF22325A),
    onSecondaryContainer = Sky,
    background = InkPage,
    onBackground = Paper,
    surface = InkPage,
    onSurface = Paper,
    surfaceVariant = Color(0xFF22325A),
    onSurfaceVariant = Color(0xFFB7BFD0),
    outline = Color(0xFF3A4A70),
    outlineVariant = Color(0xFF2B3A5C),
)

// Bricolage Grotesque for headings and titles, Instrument Sans for text (SIL Open Font License, bundled: no font download).
// Variable font weights: the API is stable in newer Compose, still marked experimental in this BOM.
@OptIn(ExperimentalTextApi::class)
private fun variable(resource: Int, weight: Int) = Font(resource, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))
private val Display = FontFamily(listOf(500, 600, 700, 800).map { variable(R.font.bricolage_grotesque, it) })
private val Text = FontFamily(listOf(400, 500, 600, 700).map { variable(R.font.instrument_sans, it) })

private val HouseTypography = Typography().run {
    fun TextStyle.display(weight: Int) = copy(fontFamily = Display, fontWeight = FontWeight(weight))
    fun TextStyle.text() = copy(fontFamily = Text)
    copy(
        displayLarge = displayLarge.display(800), displayMedium = displayMedium.display(800), displaySmall = displaySmall.display(800),
        headlineLarge = headlineLarge.display(800), headlineMedium = headlineMedium.display(700), headlineSmall = headlineSmall.display(700),
        titleLarge = titleLarge.display(700), titleMedium = titleMedium.display(700), titleSmall = titleSmall.display(600),
        bodyLarge = bodyLarge.text(), bodyMedium = bodyMedium.text(), bodySmall = bodySmall.text(),
        labelLarge = labelLarge.text(), labelMedium = labelMedium.text(), labelSmall = labelSmall.text(),
    )
}

/**
 * The screen background: plain paper (or ink), like the website. Kept as a Brush so callers stay the same.
 *
 * Geen @Composable — zo kan de aanroeper het resultaat met `remember(dark)`
 * cachen en wordt er niet bij elke recomposition een nieuwe Brush gemaakt.
 */
fun screenBackgroundBrush(darkTheme: Boolean): Brush = SolidColor(if (darkTheme) InkPage else Paper)

/**
 * Kaartvulling: diagonale gradient van [base] naar een ietsje donkerder/lichter
 * variant, voor een gevoel van diepte zonder zware schaduw.
 */
fun noteCardBrush(base: Color, darkTheme: Boolean): Brush {
    val tinted = if (darkTheme) base.darken(0.08f) else base.darken(0.05f)
    return Brush.linearGradient(
        colors = listOf(base, tinted),
        start = Offset(0f, 0f),
        end = Offset.Infinite,
    )
}

private fun Color.darken(fraction: Float): Color {
    val f = fraction.coerceIn(0f, 1f)
    return Color(
        red = (red * (1f - f)).coerceIn(0f, 1f),
        green = (green * (1f - f)).coerceIn(0f, 1f),
        blue = (blue * (1f - f)).coerceIn(0f, 1f),
        alpha = alpha,
    )
}

@Composable
fun JotDropTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = HouseTypography,
        content = content,
    )
}
