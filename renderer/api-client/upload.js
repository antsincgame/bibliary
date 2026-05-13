/**
 * Browser → backend file upload + drag&drop helper.
 *
 * Файл пушится через multipart POST на /api/library/upload, backend
 * пересылает в Appwrite Storage (`book-originals`) с per-user
 * permissions и возвращает `fileId`. Renderer затем зовёт
 * library.importFiles([fileId, ...]) для парсинга.
 *
 * Progress tracking: используем XMLHttpRequest вместо fetch т.к.
 * fetch не отдаёт upload progress events нативно (только download).
 * Через xhr.upload.onprogress UI может показать live %.
 */

/**
 * @typedef {Object} UploadResult
 * @property {string} fileId
 * @property {string} name
 * @property {number} size
 */

/**
 * @param {File} file
 * @param {{onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal}} [opts]
 * @returns {Promise<UploadResult>}
 */
export function uploadFile(file, opts = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/library/upload");
    xhr.withCredentials = true;
    xhr.responseType = "json";

    if (opts.onProgress) {
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) opts.onProgress(e.loaded, e.total);
      });
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        xhr.abort();
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      opts.signal.addEventListener("abort", () => xhr.abort());
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(/** @type {UploadResult} */ (xhr.response));
      } else {
        const body = xhr.response || {};
        reject(
          new Error(
            typeof body === "object" && body && "message" in body
              ? String(body.message)
              : `upload failed: HTTP ${xhr.status}`,
          ),
        );
      }
    };
    xhr.onerror = () => reject(new Error("upload network error"));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));

    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

/**
 * Attach drag-and-drop handlers to a DOM element. Returns detach fn.
 *
 * @param {Element} element
 * @param {(files: File[]) => void} onDrop
 * @returns {() => void}
 */
export function attachDropZone(element, onDrop) {
  /** @type {(e: Event) => void} */
  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  /** @type {(e: DragEvent) => void} */
  const onDragOver = (e) => {
    stop(e);
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    element.classList.add("drag-over");
  };
  /** @type {(e: DragEvent) => void} */
  const onDragLeave = (e) => {
    stop(e);
    /* dragleave fires when crossing child boundaries — игнорируем
     * если событие реально не покидает контейнер. */
    if (e.target === element) element.classList.remove("drag-over");
  };
  /** @type {(e: DragEvent) => void} */
  const onDropEvent = (e) => {
    stop(e);
    element.classList.remove("drag-over");
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    onDrop(Array.from(files));
  };

  element.addEventListener("dragenter", stop);
  element.addEventListener("dragover", /** @type {EventListener} */ (onDragOver));
  element.addEventListener("dragleave", /** @type {EventListener} */ (onDragLeave));
  element.addEventListener("drop", /** @type {EventListener} */ (onDropEvent));

  return () => {
    element.removeEventListener("dragenter", stop);
    element.removeEventListener("dragover", /** @type {EventListener} */ (onDragOver));
    element.removeEventListener("dragleave", /** @type {EventListener} */ (onDragLeave));
    element.removeEventListener("drop", /** @type {EventListener} */ (onDropEvent));
    element.classList.remove("drag-over");
  };
}

/**
 * Convenience: upload N files sequentially, then call library.importFiles.
 * Returns aggregate import result. Per-file upload errors logged + included
 * как failed entries в результате, не abort'ят весь batch.
 *
 * @param {File[]} files
 * @param {{onFileProgress?: (idx: number, file: File, loaded: number, total: number) => void, onFileDone?: (idx: number, file: File, fileId: string) => void, signal?: AbortSignal}} [opts]
 */
export async function uploadAndImport(files, opts = {}) {
  /** @type {string[]} */
  const fileIds = [];
  /** @type {Array<{name: string, error: string}>} */
  const uploadErrors = [];
  for (let i = 0; i < files.length; i++) {
    if (opts.signal?.aborted) break;
    const f = files[i];
    try {
      const result = await uploadFile(f, {
        onProgress: opts.onFileProgress
          ? (loaded, total) => opts.onFileProgress(i, f, loaded, total)
          : undefined,
        signal: opts.signal,
      });
      fileIds.push(result.fileId);
      if (opts.onFileDone) opts.onFileDone(i, f, result.fileId);
    } catch (err) {
      uploadErrors.push({
        name: f.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (fileIds.length === 0) {
    return {
      importedCount: 0,
      duplicateCount: 0,
      failedCount: 0,
      unsupportedCount: 0,
      uploadErrors,
      results: [],
    };
  }

  const api = /** @type {any} */ (window).api;
  const importResult = await api.library.importFiles(fileIds);
  return { ...importResult, uploadErrors };
}
