package com.diexar.keepcapture

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/** Three buttons on the home screen. It shows no note text, so nothing private ends up on the home screen. */
class QuickCaptureWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = update(context, manager, ids)

    private fun update(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val views = RemoteViews(context.packageName, R.layout.widget_quick_capture)
        views.setOnClickPendingIntent(R.id.widget_note, screen(context, 1, list(context, ACTION_NOTE)))
        // The shortcut already handles the microphone question, a running recording and an unsaved memo.
        views.setOnClickPendingIntent(R.id.widget_voice, screen(context, 2, Intent(context, VoiceMemoShortcutActivity::class.java)))
        views.setOnClickPendingIntent(R.id.widget_photo, screen(context, 3, list(context, ACTION_PHOTO)))
        manager.updateAppWidget(ids, views)
    }

    /** REORDER_TO_FRONT leaves an open editor alive behind the list, with its unsaved text. */
    private fun list(context: Context, action: String) = Intent(context, NotesListActivity::class.java).setAction(action).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)

    private fun screen(context: Context, request: Int, intent: Intent) = PendingIntent.getActivity(context, request, intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    companion object {
        const val ACTION_NOTE = "com.diexar.keepcapture.action.WIDGET_NOTE"
        const val ACTION_PHOTO = "com.diexar.keepcapture.action.WIDGET_PHOTO"

        /** Force stopping the app cancels the buttons, which many phones do to save battery. Opening the app repairs them. */
        fun refresh(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, QuickCaptureWidget::class.java))
            if (ids.isNotEmpty()) QuickCaptureWidget().update(context, manager, ids)
        }
    }
}
