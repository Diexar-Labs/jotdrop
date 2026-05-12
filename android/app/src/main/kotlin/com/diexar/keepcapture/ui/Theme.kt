package com.diexar.keepcapture.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

// Sunset/dusk-vibe — perzik naar violet/indigo. Bewust geen groen.
private val LightColors = lightColorScheme(
    primary = Color(0xFFC2185B),
    onPrimary = Color.White,
    secondary = Color(0xFF7B3FBF),
    onSecondary = Color.White,
    background = Color(0xFFFFF6F1),
    onBackground = Color(0xFF1F1626),
    surface = Color(0xFFFFFBF7),
    onSurface = Color(0xFF1F1626),
    surfaceVariant = Color(0xFFF1E3EA),
    onSurfaceVariant = Color(0xFF52414C),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFFF8FB1),
    onPrimary = Color(0xFF3A0E20),
    secondary = Color(0xFFCEA8FF),
    onSecondary = Color(0xFF22113F),
    background = Color(0xFF15101F),
    onBackground = Color(0xFFEDE3EE),
    surface = Color(0xFF1E1730),
    onSurface = Color(0xFFEDE3EE),
    surfaceVariant = Color(0xFF2D2342),
    onSurfaceVariant = Color(0xFFC7B7CC),
)

/**
 * Subtiele verticale achtergrond-gradient — boven warm (perzik/koraal),
 * onder koel (lavendel/indigo). Vermijd het gebruik op kaart-achtergronden:
 * cards behouden hun pastel-kleur en krijgen een eigen lichte diagonale
 * gradient via [noteCardBrush] voor wat diepte zonder kleur te overheersen.
 *
 * Geen @Composable — zo kan de aanroeper het resultaat met `remember(dark)`
 * cachen en wordt er niet bij elke recomposition een nieuwe Brush gemaakt.
 */
fun screenBackgroundBrush(darkTheme: Boolean): Brush {
    return if (darkTheme) {
        Brush.verticalGradient(
            colors = listOf(
                Color(0xFF2A1530),
                Color(0xFF15101F),
                Color(0xFF1B1530),
            ),
        )
    } else {
        Brush.verticalGradient(
            colors = listOf(
                Color(0xFFFFE4D6),
                Color(0xFFFFF1EC),
                Color(0xFFEDE0FF),
            ),
        )
    }
}

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
fun ObsiDropTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content,
    )
}
