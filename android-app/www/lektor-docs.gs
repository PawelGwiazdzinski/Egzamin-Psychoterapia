/**
 * Lektor → Google Docs
 * ---------------------
 * Ten skrypt zapisuje notatki z aplikacji Lektor w Twoich dokumentach Google.
 * Działa na Twoim koncie, nikt poza Tobą nie ma dostępu do dokumentów.
 *
 * Jak wdrożyć (raz, ok. 2 minuty, najlepiej na komputerze):
 *  1. Wejdź na https://script.google.com/home/projects/create
 *  2. Usuń przykładowy kod, wklej cały ten plik i zapisz (Ctrl+S).
 *  3. Kliknij „Wdróż” → „Nowe wdrożenie” → typ „Aplikacja internetowa”:
 *        Wykonaj jako: Ja          Kto ma dostęp: Każdy
 *     Kliknij „Wdróż” i zezwól na dostęp (ostrzeżenie „Google nie zweryfikował tej aplikacji”
 *     → Zaawansowane → Otwórz …). Skopiuj „Adres URL aplikacji internetowej”.
 *  4. Otwórz ten adres w przeglądarce na telefonie i stuknij „Otwórz w Lektorze”
 *     (albo wklej adres w Lektorze: ⚙ → Google Docs).
 *
 * Każda czytana pozycja dostaje własny dokument „Notatki – <tytuł>”. Grupy notatek to nagłówki.
 * Nowa notatka trafia na koniec sekcji swojej grupy, więc Twoje własne zmiany w dokumencie zostają.
 */

var TITLE_PREFIX = 'Notatki – ';

function doGet(e) {
  var url = ScriptApp.getService().getUrl();
  var intent = 'intent://connect?u=' + encodeURIComponent(url) + '#Intent;scheme=lektor;package=pl.lektor.app;end';
  var plain = 'lektor://connect?u=' + encodeURIComponent(url);
  var html = '<!doctype html><html lang="pl"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Lektor – Google Docs</title>'
    + '<style>body{font:17px/1.5 system-ui,sans-serif;margin:0;padding:28px 20px;background:#f4f1ea;color:#2b2620}'
    + 'h1{font-size:24px;margin:0 0 6px}.ok{color:#15803d;font-weight:600}.btn{display:block;text-align:center;background:#c2410c;color:#fff;'
    + 'text-decoration:none;border-radius:12px;padding:14px;font-weight:700;margin:18px 0 10px}.ghost{display:block;text-align:center;'
    + 'border:1px solid #d6cdbf;border-radius:12px;padding:12px;text-decoration:none;color:#2b2620;margin:8px 0}'
    + 'code{display:block;word-break:break-all;background:#fff;border:1px solid #e4ddd0;border-radius:8px;padding:10px;font-size:12px;margin-top:14px}'
    + 'p.s{color:#7a7064;font-size:14px}</style></head><body>'
    + '<h1>Lektor ▸ Google Docs</h1><p class="ok">✓ Skrypt działa. Notatki będą zapisywane na koncie: '
    + esc(Session.getEffectiveUser().getEmail() || '') + '</p>'
    + '<a class="btn" href="' + intent + '" id="open">Otwórz w Lektorze</a>'
    + '<a class="ghost" href="' + plain + '">Nie zadziałało? Spróbuj tego linku</a>'
    + '<a class="ghost" href="mailto:?subject=Lektor%20%E2%80%93%20adres%20Google%20Docs&body=' + encodeURIComponent(url) + '">Wyślij adres na mój e-mail</a>'
    + '<p class="s">Na komputerze: skopiuj poniższy adres i wklej go w Lektorze (⚙ → Google Docs → Wklej adres skryptu).'
    + ' Adres jest jak hasło – nie udostępniaj go.</p>'
    + '<code>' + esc(url) + '</code>'
    + '</body></html>';
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json({ error: 'Nieprawidłowe dane' }); }
  try {
    switch (req.action) {
      case 'ping': return json({ ok: true, email: Session.getEffectiveUser().getEmail() });
      case 'append': return json(appendNote(req.docKey, req.title, req.note));
      case 'rebuild': return json(rebuild(req.docKey, req.title, req.notes || []));
      case 'link': return json(linkDoc(req.docKey, req.docId));
      default: return json({ error: 'Nieznana akcja: ' + req.action });
    }
  } catch (err) {
    return json({ error: String(err && err.message || err) });
  }
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}

// ------------------------------------------------------------------ dokumenty
function props() { return PropertiesService.getScriptProperties(); }

function getDoc(docKey, title) {
  var id = props().getProperty('doc:' + docKey);
  var doc = null;
  if (id) { try { doc = DocumentApp.openById(id); } catch (err) { doc = null; } }
  if (!doc) {
    doc = DocumentApp.create(TITLE_PREFIX + (title || 'Dokument'));
    var body = doc.getBody();
    var first = body.getParagraphs()[0];
    first.setText(TITLE_PREFIX + (title || 'Dokument')).setHeading(DocumentApp.ParagraphHeading.TITLE);
    props().setProperty('doc:' + docKey, doc.getId());
  }
  return doc;
}

function linkDoc(docKey, docId) {
  var doc = DocumentApp.openById(docId); // rzuci błąd, jeśli brak dostępu
  props().setProperty('doc:' + docKey, docId);
  return { url: doc.getUrl(), docId: docId };
}

function isHeading(p) {
  var h = p.getHeading();
  return h === DocumentApp.ParagraphHeading.HEADING1 || h === DocumentApp.ParagraphHeading.HEADING2 || h === DocumentApp.ParagraphHeading.TITLE;
}

function noteLines(note) {
  var lines = [];
  if (note.quote) {
    lines.push({ text: '„' + String(note.quote).trim() + '”' + (note.page != null ? ' — s. ' + (note.page + 1) : ''), kind: 'quote' });
  }
  if (note.thought) {
    String(note.thought).trim().split('\n').forEach(function (p, i) {
      if (p.trim()) lines.push({ text: (i ? '   ' : '→ ') + p.trim(), kind: 'thought' });
    });
  }
  lines.push({ text: '', kind: 'spacer' });
  return lines;
}

function stylePara(p, kind) {
  p.setHeading(DocumentApp.ParagraphHeading.NORMAL);
  if (kind === 'quote') {
    p.setIndentStart(18).setIndentFirstLine(18);
    var t = p.editAsText();
    t.setItalic(true).setForegroundColor('#555555');
  } else {
    p.setIndentStart(0).setIndentFirstLine(0);
    var t2 = p.editAsText();
    if (p.getText()) t2.setItalic(false).setForegroundColor('#000000');
  }
}

function writeLines(body, insertAt, lines) {
  lines.forEach(function (l) {
    var p = insertAt == null ? body.appendParagraph(l.text) : body.insertParagraph(insertAt++, l.text);
    stylePara(p, l.kind);
  });
  return insertAt;
}

function appendNote(docKey, title, note) {
  var doc = getDoc(docKey, title);
  var body = doc.getBody();
  var group = String(note.group || 'Bez grupy').trim();
  var paras = body.getParagraphs();
  var hi = -1;
  for (var i = 0; i < paras.length; i++) {
    if (paras[i].getHeading() === DocumentApp.ParagraphHeading.HEADING2 && paras[i].getText().trim() === group) { hi = i; break; }
  }
  var insertAt = null;
  if (hi < 0) {
    var h = body.appendParagraph(group);
    h.setHeading(DocumentApp.ParagraphHeading.HEADING2);
  } else {
    var j = hi + 1;
    while (j < paras.length && !isHeading(paras[j])) j++;
    if (j < paras.length) insertAt = body.getChildIndex(paras[j]);
  }
  writeLines(body, insertAt, noteLines(note));
  doc.saveAndClose();
  return { url: doc.getUrl(), docId: doc.getId() };
}

function rebuild(docKey, title, notes) {
  var doc = getDoc(docKey, title);
  var body = doc.getBody();
  body.clear();
  var first = body.getParagraphs()[0];
  first.setText(TITLE_PREFIX + (title || 'Dokument')).setHeading(DocumentApp.ParagraphHeading.TITLE);
  var groups = {}, order = [];
  notes.forEach(function (n) {
    var g = String(n.group || 'Bez grupy').trim();
    if (!groups[g]) { groups[g] = []; order.push(g); }
    groups[g].push(n);
  });
  order.forEach(function (g) {
    body.appendParagraph(g).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    groups[g].forEach(function (n) { writeLines(body, null, noteLines(n)); });
  });
  doc.saveAndClose();
  return { url: doc.getUrl(), docId: doc.getId() };
}
