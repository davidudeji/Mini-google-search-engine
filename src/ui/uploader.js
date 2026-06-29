// ══════════════════════════════════════════════════════════════════════
//  FILE UPLOADER  —  src/ui/uploader.js
// ══════════════════════════════════════════════════════════════════════
//
//  ┌─ EXPLAIN-BEFORE-CODE: CONCEPTUAL 'WHY' ───────────────────────────┐
//  │                                                                    │
//  │  THE BUG IN THE ORIGINAL CODE:                                     │
//  │  The monolith called buildIndex() inside each FileReader.onload   │
//  │  callback. For N files, this means buildIndex() runs N times,     │
//  │  each time rebuilding the entire index from scratch.              │
//  │                                                                    │
//  │    Old cost: O(N × D × T) — quadratic in document count          │
//  │    New cost: O(D × T)     — linear, index built exactly once      │
//  │                                                                    │
//  │  THE FIX: Promise.all()                                            │
//  │  Wrap each FileReader in a Promise, then use Promise.all() to      │
//  │  wait for ALL files to finish loading before calling buildIndex(). │
//  │                                                                    │
//  │  WHY FILEREADER NEEDS WRAPPING IN A PROMISE:                       │
//  │  FileReader is an event-driven API (onload callbacks), not a      │
//  │  Promise-based API. Wrapping it gives us:                          │
//  │  1. Composability with Promise.all() for parallel execution        │
//  │  2. Consistent error handling via Promise.reject()                │
//  │  3. Modern async/await compatibility if we refactor later          │
//  │                                                                    │
//  │  ARE FILEREADERS PARALLEL?                                         │
//  │  Yes — the browser can initiate multiple FileReader instances      │
//  │  simultaneously. They are I/O operations (reading from the OS     │
//  │  file handle) and do not block the JavaScript thread. The JS      │
//  │  callbacks fire on the event loop after the OS returns the data.  │
//  └────────────────────────────────────────────────────────────────────┘
//
//  ┌─ EXPLAIN-BEFORE-CODE: COMPLEXITY ──────────────────────────────────┐
//  │  handleFileInput(files) for N files of total T bytes:              │
//  │    FileReader phase:    O(T) — I/O bound, not CPU                  │
//  │    buildIndex() once:  O(D × T_tokens) — one full rebuild          │
//  │    Old approach:       O(N × D × T_tokens) — N full rebuilds       │
//  │    Saving:             (N-1) × O(D × T_tokens) avoided             │
//  └────────────────────────────────────────────────────────────────────┘
//
//  ┌─ INTERVIEW DEFENCE ────────────────────────────────────────────────┐
//  │  Q: "Why wrap FileReader in a Promise when FileReader already has  │
//  │     an event-based API?"                                            │
//  │  A: Promises allow COMPOSITION. With callbacks, you must manually  │
//  │     track a counter (filesLoaded++) and check if it equals total   │
//  │     files before calling buildIndex() — this is the "callback      │
//  │     counter" anti-pattern. Promise.all() handles this bookkeeping  │
//  │     automatically, is race-condition-free, and supports error      │
//  │     propagation in a structured way.                               │
//  │                                                                    │
//  │  Q: "What happens if the user uploads a file that is too large?"  │
//  │  A: The spec caps total session size at 25MB. We validate file     │
//  │     size before creating the FileReader (see MAX_FILE_BYTES).      │
//  │     If exceeded, we reject the Promise immediately without reading │
//  │     the file. The OS file handle is never opened, so no memory    │
//  │     is allocated. The error is surfaced as a toast notification.  │
//  └─────────────────────────────────────────────────────────────────────┘

// ── CONSTANTS ─────────────────────────────────────────────────────────
// Max size per individual file (10MB). Total session cap enforced below.
const MAX_FILE_BYTES    = 10 * 1024 * 1024; // 10 MB
const MAX_SESSION_BYTES = 25 * 1024 * 1024; // 25 MB total per spec

/**
 * readFileAsText(file) — Wraps the FileReader callback API in a Promise
 * so we can use Promise.all() to parallelise multiple file reads.
 *
 * @param  {File}   file — a File object from the input or drop event
 * @returns {Promise<{name, text}>}
 */
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    // ── Size validation ──────────────────────────────────────────────
    if (file.size > MAX_FILE_BYTES) {
      reject(new Error(`"${file.name}" is too large (max 10MB per file).`));
      return;
    }

    const reader = new FileReader();

    // Resolve the Promise when the file finishes loading.
    reader.onload = ev => resolve({ name: file.name, text: ev.target.result });

    // Reject on any I/O error (e.g., file was deleted while reading).
    reader.onerror = () => reject(new Error(`Failed to read "${file.name}".`));

    // Begin reading — this is non-blocking; the browser handles I/O.
    reader.readAsText(file);
  });
}

/**
 * handleFileInput(files) — Entry point for both drag-drop and file picker.
 * Uses Promise.all() to read all files in parallel, then calls buildIndex()
 * exactly ONCE after all reads complete.
 *
 * @param {FileList | File[]} files — from input.files or dataTransfer.files
 */
function handleFileInput(files) {
  if (!files || files.length === 0) return;

  // ── Total session size guard ─────────────────────────────────────
  const incomingBytes = Array.from(files).reduce((sum, f) => sum + f.size, 0);
  const currentBytes  = AppState.documents.reduce((sum, d) => sum + d.text.length, 0);

  if (currentBytes + incomingBytes > MAX_SESSION_BYTES) {
    showToast('⚠ Session limit: total uploads must stay under 25MB.', 'warn');
    return;
  }

  // Show loading indicator while files are being read.
  showLoadingOverlay(true);

  // Filter out already-indexed files by name to prevent duplicates.
  const existingNames = new Set(AppState.documents.map(d => d.name));
  const newFiles = Array.from(files).filter(f => {
    if (existingNames.has(f.name)) {
      showToast(`"${f.name}" is already indexed.`, 'info');
      return false;
    }
    return true;
  });

  if (newFiles.length === 0) {
    showLoadingOverlay(false);
    return;
  }

  // ── PARALLEL FILE READS ──────────────────────────────────────────
  // All FileReaders start simultaneously. Promise.all waits for every
  // one to complete before proceeding — if ANY fails, the .catch fires.
  Promise.all(newFiles.map(readFileAsText))
    .then(loaded => {
      // All files read successfully. Add them to the document store.
      loaded.forEach(({ name, text }) => {
        AppState.documents.push({
          // Use a timestamp + random offset as a collision-resistant ID.
          // Math.random() is sufficient here — this is not a security context.
          id:   Date.now() + Math.random(),
          name,
          text,
          tokenCount: 0  // will be populated by buildIndex()
        });
      });

      // Build the index exactly once after ALL documents are loaded.
      buildIndex();
      showToast(`✓ Indexed ${loaded.length} file${loaded.length > 1 ? 's' : ''}.`, 'success');

      // If we're already on the results page with a query, re-run it
      // so the new documents appear in results immediately.
      if (AppState.lastQuery && isResultsPage()) {
        goToResults(AppState.lastQuery);
      }
    })
    .catch(err => {
      showToast(`Error: ${err.message}`, 'error');
    })
    .finally(() => {
      showLoadingOverlay(false);
      // Reset the file input so the same file can be re-selected if needed.
      const inp = document.getElementById('fileInput');
      if (inp) inp.value = '';
    });
}

/**
 * setupDrop(zoneId) — Attaches drag-and-drop event handlers to a DOM element.
 * Also sets up a click handler to open the hidden file input.
 *
 * Why e.preventDefault() on 'dragover'?
 * The browser's default dragover behaviour is to show a "not allowed" cursor
 * and refuse the drop. Calling preventDefault() signals to the browser that
 * this element accepts the drop, changing the cursor to "copy" or "move".
 *
 * @param {string} zoneId — id of the drop zone element
 */
function setupDrop(zoneId) {
  const zone = document.getElementById(zoneId);
  if (!zone) return;

  zone.addEventListener('dragover', e => {
    e.preventDefault(); // required to allow the drop (see explanation above)
    zone.classList.add('drag-over');
  });

  zone.addEventListener('dragleave', e => {
    // Only remove drag-over if the pointer truly left the zone,
    // not just moved to a child element within it.
    if (!zone.contains(e.relatedTarget)) {
      zone.classList.remove('drag-over');
    }
  });

  zone.addEventListener('drop', e => {
    e.preventDefault(); // prevent browser from navigating to the dropped file
    zone.classList.remove('drag-over');
    handleFileInput(e.dataTransfer.files);
  });

  // Allow clicking the zone to open the file picker.
  zone.addEventListener('click', () => document.getElementById('fileInput').click());
}

/**
 * setupGlobalDrop() — Turns the entire page into a drop target.
 * When files are dragged anywhere over the window, a full-page overlay
 * appears with a visual cue. Files dropped anywhere are processed.
 */
function setupGlobalDrop() {
  const overlay = document.getElementById('globalDropOverlay');
  if (!overlay) return;

  let dragCounter = 0; // Counter prevents flickering on child element crossings.

  document.addEventListener('dragenter', e => {
    // Only activate for file drags, not text/element drags.
    if (e.dataTransfer.types.includes('Files')) {
      dragCounter++;
      overlay.classList.add('show');
    }
  });

  document.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      overlay.classList.remove('show');
    }
  });

  document.addEventListener('dragover', e => e.preventDefault());

  document.addEventListener('drop', e => {
    e.preventDefault();
    dragCounter = 0;
    overlay.classList.remove('show');
    if (e.dataTransfer.files.length > 0) {
      handleFileInput(e.dataTransfer.files);
    }
  });
}

// ── UI HELPERS ────────────────────────────────────────────────────────

/**
 * showLoadingOverlay(show) — Shows/hides the indexing progress indicator.
 */
function showLoadingOverlay(show) {
  const el = document.getElementById('loadingIndicator');
  if (el) el.style.display = show ? 'flex' : 'none';
}

/**
 * showToast(message, type) — Displays a transient notification.
 * Types: 'success' | 'warn' | 'error' | 'info'
 */
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Trigger enter animation on next frame.
  requestAnimationFrame(() => toast.classList.add('show'));

  // Auto-dismiss after 3 seconds.
  setTimeout(() => {
    toast.classList.remove('show');
    // Remove from DOM after the CSS transition completes.
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
