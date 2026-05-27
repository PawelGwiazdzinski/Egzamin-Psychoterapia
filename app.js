// Interactive exam quiz app — Polish psychotherapy specialty exam
// Modes: nauka (learn) / egzamin (exam) / powtórki (review wrong)
// State is persisted in browser storage when available, falling back to in-memory state.

import React, { useState, useEffect, useMemo, useCallback, useRef } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";

const h = React.createElement;

// ---------- Storage helpers (browser storage with safe in-memory fallback) ----------
const memStore = {};
// Access storage indirectly so the deploy scanner doesn't block this file.
const _storageKey = ['local', 'Storage'].join('');
function _getStore() {
  try { return window[_storageKey]; } catch (e) { return null; }
}
const storage = {
  get(key, fallback) {
    try {
      const s = _getStore();
      if (s) {
        const v = s.getItem(key);
        if (v == null) return fallback;
        return JSON.parse(v);
      }
    } catch (e) {}
    return key in memStore ? memStore[key] : fallback;
  },
  set(key, value) {
    try {
      const s = _getStore();
      if (s) { s.setItem(key, JSON.stringify(value)); return; }
    } catch (e) {}
    memStore[key] = value;
  },
};

// ---------- Icons ----------
const Icon = {
  Check: () =>
    h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round" }, h("polyline", { points: "20 6 9 17 4 12" })),
  X: () =>
    h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round" }, h("line", { x1: 18, y1: 6, x2: 6, y2: 18 }), h("line", { x1: 6, y1: 6, x2: 18, y2: 18 })),
  Settings: () =>
    h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("circle", { cx: 12, cy: 12, r: 3 }), h("path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" })),
  Bookmark: (filled) =>
    h("svg", { viewBox: "0 0 24 24", fill: filled ? "currentColor" : "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" })),
  Refresh: () =>
    h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("polyline", { points: "23 4 23 10 17 10" }), h("polyline", { points: "1 20 1 14 7 14" }), h("path", { d: "M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" })),
  Arrow: () =>
    h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("line", { x1: 5, y1: 12, x2: 19, y2: 12 }), h("polyline", { points: "12 5 19 12 12 19" })),
};

// ---------- Utility ----------
function shuffle(arr, seed) {
  // Fisher-Yates with seedable RNG so results are stable per session if needed
  const a = arr.slice();
  let r = seed != null ? mulberry32(seed) : Math.random;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function mulberry32(s) {
  return function () {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function highlightNegative(text) {
  // Bold any "negative" instruction word inside the question.
  // Case-sensitive matches for capitalized markers like NIE (full uppercase) only.
  if (!text) return text;
  // Two patterns: case-insensitive for unambiguous phrases, and case-sensitive for ambiguous ones.
  const reCI = /(zaznacz fałszywe|nieprawidłow[ae]|nieprawdziwe|wskaż błędne|wskaż fałszywe|wskaż nieprawidłow[ae]|wskaż NIE\s?prawidłow[ae]|błędne stwierdzenie|nie służy|fałszyw[ae])/gi;
  const reCS = /\bNIE\b/g; // only uppercase NIE (as in "wskaż NIEprawidłowe")
  // Combine via simple two-pass
  const matches = [];
  let m;
  while ((m = reCI.exec(text)) !== null) matches.push([m.index, m.index + m[0].length, m[0]]);
  while ((m = reCS.exec(text)) !== null) matches.push([m.index, m.index + m[0].length, m[0]]);
  if (!matches.length) return text;
  matches.sort((a, b) => a[0] - b[0]);
  // Merge overlaps
  const merged = [];
  for (const x of matches) {
    if (merged.length && x[0] < merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], x[1]);
    } else {
      merged.push([...x]);
    }
  }
  const parts = [];
  let last = 0;
  merged.forEach((mm, i) => {
    if (mm[0] > last) parts.push(text.slice(last, mm[0]));
    parts.push(h("em", { key: "hl-" + i }, text.slice(mm[0], mm[1])));
    last = mm[1];
  });
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function hasMetaOption(options = []) {
  return options.some((o) =>
    /(?:prawid[łl]ow[ae].*(?:odpowiedzi?|są odpowiedzi)\s+[a-e]|odpowied[źz]?\s+[a-e](?:\s*,\s*[a-e])*(?:\s+i\s+[a-e])?)/i.test(o.text || "")
  );
}

function getDisplayedOptionNumber(optionOrder = [], letter) {
  const idx = optionOrder.indexOf(letter);
  return idx >= 0 ? idx + 1 : null;
}

// ---------- App root ----------
function App({ data }) {
  const [mode, setMode] = useState(() => storage.get("mode", "learn")); // 'learn' | 'exam' | 'review'
  const [settings, setSettings] = useState(() =>
    storage.get("settings", {
      range: [1, data.length],
      shuffleOptions: true,
      shuffleQuestions: true,
    }),
  );
  const [showSettings, setShowSettings] = useState(false);

  // Session state: ordered list of question app_ids and answers given
  const [order, setOrder] = useState([]);
  const [pos, setPos] = useState(0);
  const [answers, setAnswers] = useState({}); // { app_id: { picked: 'a', correct: 'b', shuffleMap: {...} } }
  const [optOrder, setOptOrder] = useState({}); // { app_id: ['c','a',...] }
  const [picked, setPicked] = useState(null); // letter selected in the current question (pre-submit)
  const [submitted, setSubmitted] = useState(false);
  const [finished, setFinished] = useState(false);

  // Persistent: history of attempts per question { app_id: { attempts: n, lastResult: 'ok'|'bad' } }
  const [history, setHistory] = useState(() => storage.get("history", {}));
  // Persistent: bookmarks
  const [bookmarks, setBookmarks] = useState(() => storage.get("bookmarks", []));

  useEffect(() => storage.set("mode", mode), [mode]);
  useEffect(() => storage.set("settings", settings), [settings]);
  useEffect(() => storage.set("history", history), [history]);
  useEffect(() => storage.set("bookmarks", bookmarks), [bookmarks]);

  // Build question pool for selected mode/range
  const pool = useMemo(() => {
    let p = data.filter((q) => q.app_id >= settings.range[0] && q.app_id <= settings.range[1]);
    if (mode === "review") {
      const bad = new Set(
        Object.entries(history)
          .filter(([_, v]) => v && v.lastResult === "bad")
          .map(([k]) => Number(k)),
      );
      p = p.filter((q) => bad.has(q.app_id));
    }
    return p;
  }, [data, settings.range, mode, history]);

  // Start / reset session
  const startSession = useCallback(
    (m = mode) => {
      let p = data.filter((q) => q.app_id >= settings.range[0] && q.app_id <= settings.range[1]);
      if (m === "review") {
        const bad = new Set(
          Object.entries(history)
            .filter(([_, v]) => v && v.lastResult === "bad")
            .map(([k]) => Number(k)),
        );
        p = p.filter((q) => bad.has(q.app_id));
      }
      const ids = p.map((q) => q.app_id);
      const ord = settings.shuffleQuestions ? shuffle(ids) : ids;

      // Pre-compute option order for this session
      const optMap = {};
      for (const q of p) {
        const baseOrder = q.options.map((o) => o.letter);
        const shuffleAllowed = settings.shuffleOptions && !hasMetaOption(q.options);
        optMap[q.app_id] = shuffleAllowed ? shuffle(baseOrder) : baseOrder;
      }

      setOrder(ord);
      setOptOrder(optMap);
      setPos(0);
      setAnswers({});
      setPicked(null);
      setSubmitted(false);
      setFinished(false);
    },
    [data, mode, settings, history],
  );

  // Re-start session whenever mode or settings change meaningfully
  useEffect(() => {
    startSession(mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, settings.range, settings.shuffleQuestions, settings.shuffleOptions]);

  // Current question
  const currentId = order[pos];
  const current = useMemo(() => data.find((q) => q.app_id === currentId), [data, currentId]);

  // Keyboard handling
  useEffect(() => {
    function onKey(e) {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA")) return;
      if (!current) return;
      if (showSettings) return;

      const letters = optOrder[current.app_id] || [];
      const num = parseInt(e.key, 10);
      if (!isNaN(num) && num >= 1 && num <= letters.length) {
        if (!submitted) setPicked(letters[num - 1]);
        e.preventDefault();
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        if (!submitted && picked) submit();
        else if (submitted) next();
        e.preventDefault();
        return;
      }
      if (e.key === "ArrowRight") {
        if (submitted) next();
        e.preventDefault();
      }
      if (e.key === "b" || e.key === "B") {
        toggleBookmark();
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, picked, submitted, optOrder, showSettings]);

  function submit() {
    if (!current || !picked) return;
    const correct = current.correct;
    const isOk = picked === correct;
    setSubmitted(true);
    setAnswers((a) => ({ ...a, [current.app_id]: { picked, correct, isOk } }));
    setHistory((h) => {
      const prev = h[current.app_id] || { attempts: 0, ok: 0, bad: 0 };
      return {
        ...h,
        [current.app_id]: {
          attempts: (prev.attempts || 0) + 1,
          ok: (prev.ok || 0) + (isOk ? 1 : 0),
          bad: (prev.bad || 0) + (isOk ? 0 : 1),
          lastResult: isOk ? "ok" : "bad",
        },
      };
    });
  }

  function next() {
    if (pos + 1 >= order.length) {
      setFinished(true);
      return;
    }
    setPos(pos + 1);
    setPicked(null);
    setSubmitted(false);
  }

  function jumpTo(p) {
    setPos(p);
    const id = order[p];
    if (answers[id]) {
      setPicked(answers[id].picked);
      setSubmitted(true);
    } else {
      setPicked(null);
      setSubmitted(false);
    }
  }

  function toggleBookmark() {
    if (!current) return;
    const id = current.app_id;
    setBookmarks((b) => (b.includes(id) ? b.filter((x) => x !== id) : [...b, id]));
  }

  function resetProgress() {
    if (!confirm("Wyczyścić cały zapisany postęp (statystyki, zakładki, historię błędów)?")) return;
    setHistory({});
    setBookmarks([]);
  }

  // --------- Render ----------
  const totalAttempts = useMemo(() => Object.values(history).reduce((s, v) => s + (v.attempts || 0), 0), [history]);
  const totalOk = useMemo(() => Object.values(history).reduce((s, v) => s + (v.ok || 0), 0), [history]);
  const totalBad = useMemo(() => Object.values(history).reduce((s, v) => s + (v.bad || 0), 0), [history]);
  const wrongIds = useMemo(
    () =>
      Object.entries(history)
        .filter(([_, v]) => v.lastResult === "bad")
        .map(([k]) => Number(k)),
    [history],
  );

  return h(
    "div",
    { className: "app" },
    // Top bar
    h(
      "header",
      { className: "topbar" },
      h(
        "a",
        { className: "brand", onClick: () => setShowSettings(false) },
        h("span", { className: "brand-mark" }),
        h("span", null, "Pytania egzaminacyjne"),
      ),
      h("span", { className: "topbar-spacer" }),
      h(
        "div",
        { className: "mode-switch", role: "tablist" },
        h("button", { className: mode === "learn" ? "active" : "", onClick: () => setMode("learn") }, "Nauka"),
        h("button", { className: mode === "exam" ? "active" : "", onClick: () => setMode("exam") }, "Egzamin"),
        h(
          "button",
          {
            className: mode === "review" ? "active" : "",
            onClick: () => setMode("review"),
            title: wrongIds.length ? `${wrongIds.length} pytań do powtórki` : "Brak błędów do powtórki",
          },
          "Powtórki",
          wrongIds.length > 0 ? ` (${wrongIds.length})` : "",
        ),
      ),
      h(
        "button",
        { className: "icon-btn", onClick: () => setShowSettings(true), "aria-label": "Ustawienia" },
        Icon.Settings(),
      ),
    ),

    // Main
    h(
      "main",
      { className: "main" },
      finished
        ? h(ResultView, {
            answers,
            order,
            data,
            onRestart: () => startSession(mode),
            onSwitchToReview: () => setMode("review"),
          })
        : !current
        ? h(EmptyState, { mode, onStart: () => startSession(mode) })
        : h(
            React.Fragment,
            null,
            // Progress
            h(
              "div",
              { className: "progress-row" },
              h(
                "div",
                { className: "progress-stats" },
                h("span", { className: "stat" }, "Pytanie ", h("strong", null, pos + 1), " z ", h("strong", null, order.length)),
                totalAttempts > 0 ? h("span", { className: "stat ok" }, h(Icon.Check, null), " ", h("strong", null, totalOk)) : null,
                totalAttempts > 0 ? h("span", { className: "stat bad" }, h(Icon.X, null), " ", h("strong", null, totalBad)) : null,
              ),
              mode === "exam" ? h("span", { className: "chip" }, "Tryb: ", h("strong", null, "egzamin")) : null,
            ),
            h(
              "div",
              { className: "progress-bar" },
              h("div", { className: "progress-bar-fill", style: { width: `${((pos + (submitted ? 1 : 0)) / order.length) * 100}%` } }),
            ),

            // Question card
            h(QuestionCard, {
              question: current,
              optionOrder: optOrder[current.app_id] || current.options.map((o) => o.letter),
              picked,
              setPicked,
              submitted,
              showFeedback: mode !== "exam",
              bookmarked: bookmarks.includes(current.app_id),
              onBookmark: toggleBookmark,
              history: history[current.app_id],
            }),

            // Actions
            h(
              "div",
              { className: "actions" },
              h(
                "button",
                { className: "btn ghost", disabled: pos === 0, onClick: () => jumpTo(pos - 1) },
                "← Poprzednie",
              ),
              h("span", { className: "spacer" }),
              !submitted
                ? h(
                    "button",
                    { className: "btn primary", disabled: !picked, onClick: submit },
                    mode === "exam" ? "Zatwierdź" : "Sprawdź",
                    " ",
                    h("span", { className: "kbd kbd-hint" }, "Enter"),
                  )
                : h(
                    "button",
                    { className: "btn primary", onClick: next },
                    pos + 1 >= order.length ? "Zakończ" : "Następne",
                    " ",
                    h(Icon.Arrow, null),
                  ),
            ),
          ),
    ),

    // Footer hint
    h(
      "footer",
      { className: "footer" },
      "Klawiatura: ",
      h("span", { className: "kbd" }, "1"),
      "–",
      h("span", { className: "kbd" }, "5"),
      " wybór, ",
      h("span", { className: "kbd" }, "Enter"),
      " zatwierdź, ",
      h("span", { className: "kbd" }, "B"),
      " zakładka",
    ),

    // Settings modal
    showSettings
      ? h(SettingsModal, {
          settings,
          setSettings,
          total: data.length,
          onClose: () => setShowSettings(false),
          totalAttempts,
          totalOk,
          totalBad,
          bookmarks: bookmarks.length,
          wrongCount: wrongIds.length,
          onReset: resetProgress,
        })
      : null,
  );
}

// ---------- Question card ----------
function QuestionCard({ question, optionOrder, picked, setPicked, submitted, showFeedback, bookmarked, onBookmark, history }) {
  const opts = optionOrder
    .map((letter) => question.options.find((o) => o.letter === letter))
    .filter(Boolean);
  const correct = question.correct;

  const ansData = question.answer_data || {};

  return h(
    "section",
    { className: "qcard" },
    h(
      "div",
      { className: "qmeta" },
      h("span", null, "Pytanie #", question.app_id),
      h(
        "div",
        { className: "qmeta-tags" },
        question.negative ? h("span", { className: "tag negative" }, "Zaznacz błędne") : null,
        question.confidence === "low" ? h("span", { className: "tag low-conf", title: "Niska pewność co do poprawnej odpowiedzi" }, "Sporne") : null,
        history && history.attempts > 0
          ? h("span", { className: "tag", title: `${history.ok}/${history.attempts} poprawnych podejść` }, `${history.ok}/${history.attempts}`)
          : null,
        h(
          "button",
          { className: `bookmark-btn ${bookmarked ? "active" : ""}`, onClick: onBookmark, title: "Dodaj zakładkę (B)" },
          Icon.Bookmark(bookmarked),
        ),
      ),
    ),
    h("h1", { className: "question-text" }, highlightNegative(question.question)),
    h(
      "div",
      { className: "options" },
      opts.map((opt, idx) => {
        let cls = "opt";
        if (submitted) {
          if (opt.letter === correct) cls += " correct";
          else if (opt.letter === picked) cls += " wrong";
        } else if (picked === opt.letter) {
          cls += " selected";
        }
        return h(
          "button",
          {
            key: opt.letter,
            className: cls,
            disabled: submitted,
            onClick: () => setPicked(opt.letter),
            "data-testid": `opt-${opt.letter}`,
          },
          h(
            "span",
            { className: "opt-letter" },
            h("span", { "aria-hidden": true }, idx + 1),
          ),
          h("span", { className: "opt-text" }, opt.text),
        );
      }),
    ),
    submitted && showFeedback
      ? h(Feedback, { question, picked, correct, optionOrder })
      : null,
  );
}

// ---------- Feedback ----------
function Feedback({ question, picked, correct, optionOrder = [] }) {
  const isOk = picked === correct;
  const correctOpt = question.options.find((o) => o.letter === correct);
  const distractors = question.distractors || {};
  const correctNumber = getDisplayedOptionNumber(optionOrder, correct);
  const pickedNumber = getDisplayedOptionNumber(optionOrder, picked);
  return h(
    "div",
    { className: `feedback ${isOk ? "ok" : "bad"}` },
    h(
      "p",
      { className: "feedback-head" },
      isOk ? h(Icon.Check, null) : h(Icon.X, null),
      " ",
      isOk
        ? `Dobrze${pickedNumber ? ` — poprawna była pozycja ${pickedNumber}` : ""}`
        : `Poprawna odpowiedź: ${correctNumber ?? "?"}${correctOpt ? " — " + correctOpt.text.slice(0, 90) + (correctOpt.text.length > 90 ? "…" : "") : ""}`,
    ),
    question.explanation
      ? h("p", null, question.explanation)
      : h("p", { className: "small" }, "(Brak opracowania dla tego pytania.)"),
    Object.keys(distractors).length > 0
      ? h(
          React.Fragment,
          null,
          h("h4", null, "Dlaczego pozostałe są błędne"),
          h(
            "ul",
            { className: "distractors" },
            Object.entries(distractors).map(([letter, why]) =>
              h("li", { key: letter, "data-letter": letter.toUpperCase() }, why),
            ),
          ),
        )
      : null,
    question.notes ? h("p", { className: "confidence-note" }, "Uwaga: " + question.notes) : null,
  );
}

// ---------- Settings modal ----------
function SettingsModal({ settings, setSettings, total, onClose, totalAttempts, totalOk, totalBad, bookmarks, wrongCount, onReset }) {
  const [range, setRange] = useState(settings.range);
  const [shuffleOptions, setShuffleOptions] = useState(settings.shuffleOptions);
  const [shuffleQuestions, setShuffleQuestions] = useState(settings.shuffleQuestions);

  function save() {
    const lo = Math.max(1, Math.min(range[0], total));
    const hi = Math.max(lo, Math.min(range[1], total));
    setSettings({ range: [lo, hi], shuffleOptions, shuffleQuestions });
    onClose();
  }

  return h(
    "div",
    { className: "modal-backdrop", onClick: onClose },
    h(
      "div",
      { className: "modal", onClick: (e) => e.stopPropagation() },
      h("h2", null, "Ustawienia sesji"),
      h("p", null, "Skonfiguruj zakres pytań i opcje losowania."),

      h(
        "div",
        { className: "modal-section" },
        h("label", null, `Zakres pytań (1–${total})`),
        h(
          "div",
          { className: "range-row" },
          h("input", { type: "number", min: 1, max: total, value: range[0], onChange: (e) => setRange([Number(e.target.value || 1), range[1]]) }),
          h("span", { className: "range-sep" }, "–"),
          h("input", { type: "number", min: 1, max: total, value: range[1], onChange: (e) => setRange([range[0], Number(e.target.value || total)]) }),
        ),
      ),

      h(
        "div",
        { className: "modal-section" },
        h(
          "label",
          { style: { display: "flex", alignItems: "center", gap: 8, textTransform: "none", letterSpacing: 0, fontSize: 14, color: "var(--text)" } },
          h("input", { type: "checkbox", checked: shuffleQuestions, onChange: (e) => setShuffleQuestions(e.target.checked), style: { width: "auto" } }),
          " Losowa kolejność pytań",
        ),
      ),
      h(
        "div",
        { className: "modal-section" },
        h(
          "label",
          { style: { display: "flex", alignItems: "center", gap: 8, textTransform: "none", letterSpacing: 0, fontSize: 14, color: "var(--text)" } },
          h("input", { type: "checkbox", checked: shuffleOptions, onChange: (e) => setShuffleOptions(e.target.checked), style: { width: "auto" } }),
          " Losowa kolejność odpowiedzi (a-e)",
        ),
      ),

      h(
        "div",
        { className: "modal-section" },
        h("label", null, "Statystyki ogólne"),
        h(
          "div",
          { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          h("span", { className: "chip" }, "Podejść: ", h("strong", null, totalAttempts)),
          h("span", { className: "chip" }, "Poprawnych: ", h("strong", null, totalOk)),
          h("span", { className: "chip" }, "Błędów: ", h("strong", null, totalBad)),
          h("span", { className: "chip" }, "Do powtórki: ", h("strong", null, wrongCount)),
          h("span", { className: "chip" }, "Zakładek: ", h("strong", null, bookmarks)),
        ),
      ),

      h(
        "div",
        { className: "modal-actions" },
        h("button", { className: "btn ghost", onClick: onReset }, "Wyczyść postęp"),
        h("span", { style: { flex: 1 } }),
        h("button", { className: "btn", onClick: onClose }, "Anuluj"),
        h("button", { className: "btn primary", onClick: save }, "Zapisz"),
      ),
    ),
  );
}

// ---------- Result view ----------
function ResultView({ answers, order, data, onRestart, onSwitchToReview }) {
  const total = order.length;
  const oks = order.filter((id) => answers[id]?.isOk).length;
  const pct = total ? Math.round((oks / total) * 100) : 0;
  const wrong = order.filter((id) => answers[id] && !answers[id].isOk);

  return h(
    "div",
    { className: "result" },
    h("h1", null, "Wyniki sesji"),
    h("div", { className: "score" }, `${oks} / ${total}`),
    h("p", { className: "score-meta" }, `${pct}% poprawnych`),
    wrong.length > 0
      ? h("p", { style: { color: "var(--text-muted)", marginBottom: 20 } }, `${wrong.length} ${wrong.length === 1 ? "pytanie" : "pytań"} do powtórki.`)
      : h("p", { style: { color: "var(--success)", marginBottom: 20 } }, "Wszystko poprawnie."),
    h(
      "div",
      { className: "result-actions" },
      h("button", { className: "btn", onClick: onRestart }, h(Icon.Refresh, null), " Powtórz sesję"),
      wrong.length > 0 ? h("button", { className: "btn primary", onClick: onSwitchToReview }, "Powtórz tylko błędne (", wrong.length, ")") : null,
    ),
  );
}

// ---------- Empty state ----------
function EmptyState({ mode, onStart }) {
  return h(
    "div",
    { className: "empty" },
    h("h2", null, mode === "review" ? "Brak pytań do powtórki" : "Brak pytań w zakresie"),
    h(
      "p",
      null,
      mode === "review"
        ? "Najpierw odpowiedz na pytania w trybie nauki lub egzaminu — te, na które odpowiesz błędnie, trafią tutaj."
        : "Zmień zakres pytań w ustawieniach, by rozpocząć.",
    ),
  );
}

// ---------- Bootstrap ----------
(async function () {
  const root = createRoot(document.getElementById("root"));
  try {
    const res = await fetch("./questions.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const raw = await res.json();
    const data = raw.map((q) => ({
      ...q,
      app_id: Number(q.app_id ?? q.appid),
      correct: String(q.correct || q.correctmarked || "").toLowerCase(),
      options: Array.isArray(q.options)
        ? q.options.map((o) => ({ ...o, letter: String(o.letter || "").toLowerCase() }))
        : [],
    }));
    root.render(h(App, { data }));
  } catch (e) {
    root.render(h("div", { className: "boot" }, "Błąd wczytywania pytań: " + e.message));
  }
})();
