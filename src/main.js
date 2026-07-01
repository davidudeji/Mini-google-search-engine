// ══════════════════════════════════════════════════════════════════════
//  ENTRY POINT  —  src/main.js
// ══════════════════════════════════════════════════════════════════════
//
//  This file is the "wiring harness." It connects all modules together
//  by attaching event listeners and calling init functions. It contains
//  NO business logic — only orchestration.
//
//  Spec §5 compliance:
//    • Native form submit events capture all search queries.
//    • A single delegated listener on `document` handles all UI clicks
//      (result cards, suggestions, history items, buttons) instead of
//      attaching discrete listeners to individual elements.
//    • DocumentFragment usage lives in renderer.js (renderResults).
//
//  Loading order (enforced by index.html <script> tag order):
//    1. store.js       → AppState defined
//    2. preprocessor.js → STOP_WORDS, stem, tokenize, tokenizeAndStem
//    3. fuzzy.js        → levenshtein, fuzzyMatch
//    4. indexer.js      → buildIndex, tfidf
//    5. search.js       → search, findMatches, buildSnippet, getSuggestions, escHtml
//    6. renderer.js     → renderResults, updateStats, etc.
//    7. uploader.js     → handleFileInput, setupDrop, setupGlobalDrop
//    8. main.js (THIS, defer) → event listeners + init

// ── DEBOUNCE UTILITY ─────────────────────────────────────────────────
//
//  Without debouncing, every keystroke triggers a search/suggestion
//  lookup. Debouncing delays execution until the user pauses typing
//  for `ms` milliseconds, preventing unnecessary engine calls.
//
//  For suggestions: 180ms — fast enough to feel instant.
//  For auto-search: 320ms — avoids running search mid-word.

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const debouncedSuggest = debounce((q, boxId) => renderSuggestions(q, boxId), 180);
const debouncedSearch = debounce((q) => { if (q.trim()) goToResults(q); }, 320);

// ── PAGE NAVIGATION ───────────────────────────────────────────────────

function isResultsPage() {
  return document.getElementById('resultsPage').classList.contains('show');
}

/**
 * triggerSearch(query) — Called by form submits, keyboard Enter, and
 * suggestion clicks. Gets the active input value if no query is passed.
 */
function triggerSearch(query) {
  const q = query !== undefined
    ? query
    : document.getElementById(isResultsPage() ? 'resultsInput' : 'homeInput').value;
  if (q.trim()) goToResults(q.trim());
}

/**
 * goToResults(query) — Transitions to the results page and renders output.
 */
function goToResults(query) {
  document.getElementById('homePage').classList.add('hidden');
  document.getElementById('resultsPage').classList.add('show');

  // Sync both input fields with the current query.
  document.getElementById('homeInput').value = query;
  document.getElementById('resultsInput').value = query;
  document.getElementById('resultsClear').style.display = 'flex';
  document.querySelectorAll('.suggestions-box').forEach(b => b.classList.remove('show'));

  // Add to history (most-recent-first, max 8 entries, no duplicates).
  if (!AppState.searchHistory.includes(query)) {
    AppState.searchHistory.unshift(query);
    if (AppState.searchHistory.length > 8) AppState.searchHistory.pop();
    renderHistory();
  }

  const searchResult = search(query);
  renderResults(query, searchResult);
}

/**
 * goHome() — Returns to the home page.
 */
function goHome() {
  document.getElementById('homePage').classList.remove('hidden');
  document.getElementById('resultsPage').classList.remove('show');
  document.getElementById('homeInput').focus();
}

// ── RESET SESSION ─────────────────────────────────────────────────────

/**
 * resetSession() — Clears ALL documents, the index, and search history.
 */
function resetSession() {
  if (AppState.documents.length === 0 && AppState.searchHistory.length === 0) {
    showToast('Nothing to reset.', 'info');
    return;
  }

  AppState.documents.length = 0;
  AppState.invertedIndex.clear();
  AppState.vocabulary.clear();
  AppState.stemMap.clear();
  AppState.searchHistory.length = 0;
  AppState.lastQuery = '';
  AppState.lastResults = [];

  updateStats();
  updateIndexView();
  updateDocChips();
  renderHistory();

  showToast('Session cleared. Ready for new documents.', 'success');
  goHome();
}

// ── SEARCH BAR SETUP ──────────────────────────────────────────────────

/**
 * setupInput(inputId, barId, sugBoxId) — Wires up focus, blur, input,
 * clear, and keydown handlers for a search bar.
 *
 * CSS class logic:
 *   focused-solo: focused but empty → subtle ring
 *   is-active:    focused with text → shadow + suggestion box open
 */
function setupInput(inputId, barId, sugBoxId) {
  const input = document.getElementById(inputId);
  const bar = document.getElementById(barId);
  const clearBtnId = inputId === 'homeInput' ? 'homeClear' : 'resultsClear';
  const clearBtn = document.getElementById(clearBtnId);

  if (!input || !bar) return;

  input.addEventListener('focus', () => {
    bar.classList.remove('focused-solo');
    if (input.value) {
      bar.classList.add('is-active');
    } else {
      bar.classList.add('focused-solo');
    }
  });

  // Delayed blur: allows suggestion item clicks to fire BEFORE the
  // suggestions box is hidden. 150ms is enough for a click to register.
  input.addEventListener('blur', () => {
    setTimeout(() => {
      bar.classList.remove('is-active', 'focused-solo');
      document.getElementById(sugBoxId)?.classList.remove('show');
    }, 150);
  });

  input.addEventListener('input', () => {
    const v = input.value;
    if (clearBtn) clearBtn.style.display = v ? 'flex' : 'none';

    if (v) {
      bar.classList.remove('focused-solo');
      bar.classList.add('is-active');
    } else {
      bar.classList.remove('is-active');
      bar.classList.add('focused-solo');
    }

    debouncedSuggest(v, sugBoxId);
    // On the results page, auto-search as the user types (live search).
    if (isResultsPage()) debouncedSearch(v);
  });

  clearBtn?.addEventListener('click', () => {
    input.value = '';
    clearBtn.style.display = 'none';
    document.getElementById(sugBoxId)?.classList.remove('show');
    bar.classList.remove('is-active');
    input.focus();
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { /* form submit handles this */ }
    if (e.key === 'Escape') {
      document.getElementById(sugBoxId)?.classList.remove('show');
      input.blur();
    }
  });
}

// ── SAMPLE DATA ───────────────────────────────────────────────────────

/**
 * loadSampleData() — Loads 4 rich sample documents for instant demo.
 */
function loadSampleData() {
  AppState.documents = [
    {
      id: 0, name: 'javascript-fundamentals.txt', tokenCount: 0,
      text: `JavaScript is a prototype-based, multi-paradigm, single-threaded, dynamic language, supporting object-oriented, imperative, and declarative programming styles. Closures are one of the most powerful features of JavaScript. A closure gives you access to an outer function's scope from an inner function. In JavaScript, closures are created every time a function is created, at function creation time. The event loop is the secret behind JavaScript's asynchronous programming. JavaScript executes code, collects and processes events, and executes queued sub-tasks using the event loop. Prototype chains form the backbone of inheritance in JavaScript. Every JavaScript object has a prototype, and objects inherit properties from their prototypes. Functions in JavaScript are first-class objects — they can be stored in variables, passed as arguments, and returned from other functions. The V8 engine compiles JavaScript to machine code using just-in-time compilation. Garbage collection in JavaScript uses a mark-and-sweep algorithm to reclaim unreachable memory. Promises and async/await simplify asynchronous programming by avoiding deeply nested callback chains. The module system allows code to be split into reusable files using import and export statements. WeakMap and WeakSet hold weak references to objects, allowing garbage collection when no strong references remain. Generators are functions that can pause and resume execution, useful for implementing iterators and cooperative multitasking.`
    },
    {
      id: 1, name: 'react-handbook.txt', tokenCount: 0,
      text: `React is a free and open-source front-end JavaScript library for building user interfaces based on components. React was created by Jordan Walke, a software engineer at Meta. Components are the building blocks of any React application. A component is a self-contained module that renders some output. The useEffect hook lets you synchronize a component with an external system. React's virtual DOM efficiently updates only the components that changed rather than rerendering the entire page. State in React components determines how the component renders and behaves. The useState hook is the primary way to manage state in functional components. React's reconciliation algorithm compares the virtual DOM with the real DOM to make efficient updates. Context API provides a way to pass data through the component tree without manually passing props at every level. useMemo and useCallback memoize values and functions to prevent unnecessary re-renders. Custom hooks allow you to extract stateful logic into reusable functions that can be shared across components. The React Fiber architecture rewrites the reconciliation algorithm to enable incremental rendering and prioritization of updates. Server components allow rendering React components on the server to reduce client-side JavaScript bundles. Error boundaries catch JavaScript errors anywhere in a child component tree and display a fallback UI.`
    },
    {
      id: 2, name: 'nodejs-internals.txt', tokenCount: 0,
      text: `Node.js is a cross-platform, open-source JavaScript runtime environment that can run on Windows, Linux, Unix, macOS, and more. Node.js runs on the V8 JavaScript engine and executes JavaScript code outside a web browser. Libuv is a multi-platform support library with a focus on asynchronous I/O. Node.js uses libuv to handle its event loop, file system operations, DNS, network, child processes, pipes, signal handling, polling and streaming. The thread pool in Node.js is maintained by libuv and defaults to four threads. Worker threads in Node.js allow for parallel execution of JavaScript code. The event loop in Node.js has multiple phases: timers, pending callbacks, idle and prepare, poll, check, and close callbacks. Streams in Node.js are objects that allow reading or writing data in a continuous fashion. Buffers in Node.js handle binary data directly in memory before it is converted to a readable string. The cluster module allows Node.js to create child processes that share server ports, enabling load distribution across CPU cores. Express.js is the most popular web framework built on top of Node.js, providing middleware routing and templating. The require() function implements CommonJS module loading with synchronous evaluation and module caching.`
    },
    {
      id: 3, name: 'system-design-primer.txt', tokenCount: 0,
      text: `System design is the process of defining the architecture, components, modules, interfaces, and data flow of a system to satisfy specified requirements. A load balancer distributes incoming network traffic across multiple servers to ensure no single server becomes overwhelmed. Horizontal scaling adds more machines to a system, while vertical scaling adds more resources to an existing machine. Caching stores frequently accessed data in fast storage to reduce latency and load on backend systems. A CDN or content delivery network delivers content to users from servers geographically closest to them. Database sharding divides a database into smaller chunks called shards, each stored on a separate server. Message queues allow asynchronous communication between services in a distributed system. Microservices architecture structures an application as a collection of small, independent services. The CAP theorem states that a distributed system can guarantee at most two of the three properties: consistency, availability, and partition tolerance. Consistent hashing distributes load across nodes while minimizing remapping when nodes are added or removed. Rate limiting protects APIs from abuse by restricting the number of requests a client can make in a time window. Circuit breakers prevent cascading failures by stopping requests to a failing service after a threshold of errors is exceeded.`
    }
  ];
  buildIndex();
  showToast('✓ Sample data loaded! Try searching "closure" or "computr"', 'success');
  document.getElementById('homeInput').focus();
}

// ── FORM SUBMIT EVENTS (spec §5) ──────────────────────────────────────
//
//  Native form submit events replace onClick-based search triggering.
//  preventDefault() stops the default GET request; JS handles routing.

document.getElementById('homeForm').addEventListener('submit', e => {
  e.preventDefault();
  triggerSearch(document.getElementById('homeInput').value);
});

document.getElementById('resultsForm').addEventListener('submit', e => {
  e.preventDefault();
  triggerSearch(document.getElementById('resultsInput').value);
});

// ── EVENT DELEGATION (spec §5) ────────────────────────────────────────
//
//  A single listener on `document` intercepts all UI interactions via
//  event bubbling. This avoids attaching N individual listeners as the
//  DOM grows, and correctly handles dynamically injected elements
//  (result cards, suggestion items, history entries) that didn't exist
//  at page load time.
//
//  Pattern: check e.target (or closest ancestor) for a data attribute
//  or CSS class, then dispatch to the appropriate handler.

document.addEventListener('click', e => {
  const t = e.target;

  // ── Logo → go home ───────────────────────────────────────────────
  if (t.closest('#resultsLogoLink')) {
    goHome();
    return;
  }

  // ── Suggestion item click ─────────────────────────────────────────
  const sugItem = t.closest('.suggestion-item');
  if (sugItem) {
    const text = sugItem.dataset.suggestion;
    if (text) selectSuggestion(text);
    return;
  }

  // ── History item click ────────────────────────────────────────────
  const histItem = t.closest('.history-item');
  if (histItem && !t.classList.contains('h-remove')) {
    const query = histItem.dataset.query;
    if (query) triggerSearch(query);
    return;
  }
  if (t.classList.contains('h-remove')) {
    const idx = parseInt(t.dataset.index, 10);
    if (!isNaN(idx)) removeHistory(idx);
    return;
  }

  // ── Result title click ────────────────────────────────────────────
  const resultTitle = t.closest('.result-title');
  if (resultTitle) {
    const docId = parseInt(resultTitle.dataset.docid, 10);
    const query = resultTitle.dataset.query;
    if (!isNaN(docId)) openDocViewer(docId, query || AppState.lastQuery);
    return;
  }

  // ── View all link ─────────────────────────────────────────────────
  const viewAll = t.closest('.view-all-link');
  if (viewAll) {
    const docId = parseInt(viewAll.dataset.docid, 10);
    if (!isNaN(docId)) openDocViewer(docId, AppState.lastQuery);
    return;
  }

  // ── Match nav buttons (prev/next per card) ────────────────────────
  const navBtn = t.closest('.match-nav-btn[data-docid]');
  if (navBtn) {
    const docId = parseInt(navBtn.dataset.docid, 10);
    const dir = parseInt(navBtn.dataset.dir, 10);
    const total = parseInt(navBtn.dataset.total, 10);
    if (!isNaN(docId)) navigateMatch(docId, dir, total);
    return;
  }

  // ── Doc viewer viewer prev/next ────────────────────────────────────
  if (t.closest('#viewerPrev')) { navigateViewerMatch(-1); return; }
  if (t.closest('#viewerNext')) { navigateViewerMatch(1); return; }

  // ── Doc viewer close ──────────────────────────────────────────────
  if (t.closest('#viewerCloseBtn') ||
    t === document.getElementById('docViewerOverlay')) {
    closeViewer(e);
    return;
  }

  // ── Header buttons ────────────────────────────────────────────────
  if (t.closest('#headerUploadBtn')) {
    document.getElementById('fileInput').click();
    return;
  }
  if (t.closest('#headerResetBtn')) {
    resetSession();
    return;
  }

  // ── Sidebar buttons ───────────────────────────────────────────────
  if (t.closest('#downloadReportBtn')) {
    downloadReport();
    return;
  }
  if (t.closest('#sidebarResetBtn')) {
    resetSession();
    return;
  }

  // ── Apply correction fix ──────────────────────────────────────────
  if (t.closest('#applyFix')) {
    document.getElementById('correctionBanner').style.display = 'none';
    return;
  }

  // ── Doc chip remove ────────────────────────────────────────────────
  if (t.classList.contains('rm') && t.dataset.docid !== undefined) {
    removeDoc(parseInt(t.dataset.docid, 10));
    return;
  }
});

// ── KEYBOARD SHORTCUTS ────────────────────────────────────────────────
// Ctrl+K / Cmd+K: focus the active search bar.
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    const inputId = isResultsPage() ? 'resultsInput' : 'homeInput';
    document.getElementById(inputId).focus();
  }
  if (e.key === 'Escape') closeViewer();
});

// ── SEARCH BAR SETUP ──────────────────────────────────────────────────
setupInput('homeInput', 'homeBar', 'homeSuggestions');
setupInput('resultsInput', 'resultsBar', 'resultsSuggestions');

// ── DROP ZONE + GLOBAL DROP ───────────────────────────────────────────
setupDrop('sideDropZone');
setupGlobalDrop();

// ── INITIAL RENDER ────────────────────────────────────────────────────
renderHistory();
updateStats();
updateDocChips();

console.log("Welcome to David Search Engine.")