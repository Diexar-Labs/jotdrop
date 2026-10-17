package com.diexar.keepcapture

internal object CloudDiagnostics {
    enum class Phase {
        REQUEST_SETUP, REQUEST_SEND, REQUEST_HEADERS, REQUEST_BODY, REQUEST_DEADLINE, REQUEST_DECODE,
        VAULT_VALIDATION, STATE_LOAD, RECOVERY, RECONCILE, REMOTE_LIST, REMOTE_WRITE, REMOTE_DELETE, STATE_SAVE,
    }

    // Only allowlisted labels and numeric measurements may reach logs, never exception text or causes.
    fun failure(error: Exception, phase: Phase, elapsedMs: Long, receivedBytes: Int? = null): String {
        val category = when (error) {
            is java.net.SocketTimeoutException -> "timeout"
            is javax.net.ssl.SSLException -> "tls"
            is java.net.UnknownHostException -> "dns"
            is java.net.ConnectException -> "connect"
            is java.io.EOFException -> "truncated"
            is java.net.SocketException -> "socket"
            is java.io.IOException -> "io"
            is SecurityException -> "permission"
            is java.security.GeneralSecurityException -> "crypto"
            is IllegalArgumentException, is IllegalStateException -> "validation"
            else -> "other"
        }
        return "[DEBUG:error] phase=$phase category=$category elapsedMs=$elapsedMs" +
            if (receivedBytes != null) " receivedBytes=$receivedBytes" else ""
    }
}
