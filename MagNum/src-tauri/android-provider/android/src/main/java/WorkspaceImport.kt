package com.green.magnum.provider

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import java.io.File
import java.util.UUID

internal class WorkspaceImport(private val activity: Activity) {
    private val resolver = activity.contentResolver
    private var entries = 0
    private var bytes = 0L

    fun copy(tree: Uri): File {
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        val rootUri = DocumentsContract.buildDocumentUriUsingTree(tree, rootId)
        val label = resolver.query(rootUri, arrayOf(Document.COLUMN_DISPLAY_NAME), null, null, null)
            ?.use { if (it.moveToFirst()) it.getString(0) else null }
            ?: "Imported project"
        val name = label.map { if (it.isLetterOrDigit() || it in " ._-") it else '_' }
            .joinToString("").trim(' ', '.').take(48).ifBlank { "Imported project" }
        val base = File(activity.filesDir, workspaceDirectory)
        check(base.isDirectory || base.mkdirs()) { "Could not open app-owned storage." }
        val id = UUID.randomUUID().toString()
        val staging = File(base, ".import-$id")
        check(staging.mkdir()) { "Could not create a workspace copy." }
        try {
            copyDirectory(tree, rootId, staging, 0)
            val target = File(base, "$name-${id.take(8)}")
            check(!target.exists() && staging.renameTo(target)) { "Could not save the workspace copy." }
            return target
        } finally {
            staging.deleteRecursively()
        }
    }

    private fun copyDirectory(tree: Uri, id: String, target: File, depth: Int) {
        check(depth <= 24) { "The folder tree exceeds 24 levels." }
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id)
        val columns = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_FLAGS)
        val cursor = resolver.query(children, columns, null, null, null)
            ?: error("Android could not list the selected folder.")
        cursor.use {
            while (it.moveToNext()) {
                check(++entries <= 4000) { "The folder contains more than 4,000 entries." }
                val childId = it.getString(0)
                val name = it.getString(1)
                check(!name.isNullOrBlank() && name != "." && name != ".." && name.none { c -> c == '/' || c == '\\' || c == '\u0000' }) {
                    "A document has an invalid file name."
                }
                val file = File(target, name)
                check(!file.exists()) { "The folder contains multiple documents named $name." }
                if (it.getString(2) == Document.MIME_TYPE_DIR) {
                    check(file.mkdir()) { "Could not create $name." }
                    copyDirectory(tree, childId, file, depth + 1)
                } else {
                    check(it.getInt(3) and Document.FLAG_VIRTUAL_DOCUMENT == 0) { "$name is a virtual document and cannot be copied." }
                    val source = DocumentsContract.buildDocumentUriUsingTree(tree, childId)
                    val input = resolver.openInputStream(source) ?: error("Could not open $name.")
                    input.use { stream ->
                        file.outputStream().use { output ->
                            val buffer = ByteArray(32 * 1024)
                            while (true) {
                                val count = stream.read(buffer)
                                if (count == -1) break
                                bytes += count
                                check(bytes <= 128L * 1024 * 1024) { "The folder exceeds the 128 MiB import limit." }
                                output.write(buffer, 0, count)
                            }
                        }
                    }
                }
            }
        }
    }

    companion object {
        fun picker() = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
}
