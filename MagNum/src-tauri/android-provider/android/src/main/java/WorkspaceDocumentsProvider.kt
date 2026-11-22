package com.green.magnum.provider

import android.annotation.TargetApi
import android.content.Context
import android.content.Intent
import android.database.MatrixCursor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileNotFoundException
import java.util.Locale

internal const val workspaceDirectory = "agent-workspaces"

private const val rootId = "workspaces"
private const val rootDocumentId = "/"
private const val title = "MagNum Workspaces"

class WorkspaceDocumentsProvider : DocumentsProvider() {
    private val base get() = File(requireNotNull(context).filesDir, workspaceDirectory)

    override fun onCreate() = true

    override fun queryRoots(projection: Array<out String>?): MatrixCursor =
        MatrixCursor(projection ?: arrayOf(
            Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE,
            Root.COLUMN_FLAGS, Root.COLUMN_MIME_TYPES
        )).apply {
            newRow()
                .add(Root.COLUMN_ROOT_ID, rootId)
                .add(Root.COLUMN_DOCUMENT_ID, rootDocumentId)
                .add(Root.COLUMN_TITLE, title)
                .add(Root.COLUMN_FLAGS, Root.FLAG_LOCAL_ONLY or Root.FLAG_SUPPORTS_IS_CHILD)
                .add(Root.COLUMN_MIME_TYPES, "*/*")
        }

    override fun queryDocument(documentId: String, projection: Array<out String>?): MatrixCursor =
        documentCursor(projection).apply {
            addDocument(documentId, resolve(documentId))
        }

    override fun queryChildDocuments(
        parentDocumentId: String,
        projection: Array<out String>?,
        sortOrder: String?
    ): MatrixCursor {
        val parent = resolve(parentDocumentId)
        if (!parent.isDirectory && (parentDocumentId != rootDocumentId || parent.exists())) {
            throw FileNotFoundException("The document is not a workspace folder.")
        }
        return documentCursor(projection).apply {
            parent.listFiles().orEmpty().sortedBy { it.name }.forEach { child ->
                val id = if (parentDocumentId == rootDocumentId) child.name else "$parentDocumentId/${child.name}"
                try {
                    addDocument(id, resolve(id))
                } catch (_: FileNotFoundException) {
                    // A hidden staging entry, unsupported file type, or a file removed during listing.
                }
            }
        }
    }

    override fun openDocument(
        documentId: String,
        mode: String,
        signal: CancellationSignal?
    ): ParcelFileDescriptor {
        signal?.throwIfCanceled()
        val file = resolve(documentId)
        if (mode != "r" || !file.isFile) {
            throw FileNotFoundException("Workspace files are available for reading.")
        }
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean = try {
        val parent = resolve(parentDocumentId)
        val child = resolve(documentId)
        child.path.startsWith(parent.path + File.separator)
    } catch (_: FileNotFoundException) {
        false
    }

    @TargetApi(26)
    override fun findDocumentPath(parentDocumentId: String?, childDocumentId: String): DocumentsContract.Path {
        resolve(childDocumentId)
        val ids = mutableListOf(rootDocumentId)
        if (childDocumentId != rootDocumentId) {
            var path = ""
            for (part in childDocumentId.split('/')) {
                path = if (path.isEmpty()) part else "$path/$part"
                ids.add(path)
            }
        }
        if (parentDocumentId == null) return DocumentsContract.Path(rootId, ids)
        val start = ids.indexOf(parentDocumentId)
        if (start == -1) throw FileNotFoundException("The document is outside the selected folder.")
        return DocumentsContract.Path(null, ids.drop(start))
    }

    private fun resolve(id: String): File {
        var file = base
        if (id == rootDocumentId) return file
        val parts = id.split('/')
        if (parts.first().startsWith('.')) throw missingDocument()
        for ((index, name) in parts.withIndex()) {
            if (name.isEmpty() || name == "." || name == ".." || '\\' in name || '\u0000' in name ||
                name.startsWith(".magnum-write-")) throw missingDocument()
            file = File(file, name)
            val mode = try {
                Os.lstat(file.path).st_mode
            } catch (_: ErrnoException) {
                throw missingDocument()
            }
            if (!OsConstants.S_ISDIR(mode) && (index == 0 || index != parts.lastIndex || !OsConstants.S_ISREG(mode))) {
                throw missingDocument()
            }
        }
        return file
    }

    private fun missingDocument() = FileNotFoundException("The workspace document is unavailable.")

    private fun documentCursor(projection: Array<out String>?) = MatrixCursor(projection ?: arrayOf(
        Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
        Document.COLUMN_FLAGS, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED
    ))

    private fun MatrixCursor.addDocument(id: String, file: File) {
        val isDirectory = id == rootDocumentId || file.isDirectory
        val extension = file.extension.lowercase(Locale.ROOT)
        val mimeType = if (isDirectory) Document.MIME_TYPE_DIR
            else MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "application/octet-stream"
        newRow()
            .add(Document.COLUMN_DOCUMENT_ID, id)
            .add(Document.COLUMN_DISPLAY_NAME, if (id == rootDocumentId) title else file.name)
            .add(Document.COLUMN_MIME_TYPE, mimeType)
            .add(Document.COLUMN_FLAGS, 0)
            .add(Document.COLUMN_SIZE, if (isDirectory) null else file.length())
            .add(Document.COLUMN_LAST_MODIFIED, file.lastModified().takeIf { it > 0 })
    }

    companion object {
        fun browse(context: Context, action: String): Intent {
            val root = DocumentsContract.buildRootUri("${context.packageName}.workspaces", rootId)
            return Intent(action).setDataAndType(root, Root.MIME_TYPE_ITEM)
        }
    }
}
