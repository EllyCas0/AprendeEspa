/* Aprende Español - PWA escalable con JSON */

const CONTENT_CACHE_KEY = "aprendespa_content_cache_v1";
const STORE_KEY = "aprende_espanol_v1";

let selectedDeckId = "";
const deckSelect = $("#deckSelect");
const studyArea = $("#studyArea");

function updateStudyAreaVisibility() {
  const hasDeckSelected = !!deckSelect?.value;
  studyArea?.classList.toggle("hidden", !hasDeckSelected);
}


/* -------------------- Cache de contenido (JSON) -------------------- */
function loadContentCache() {
  try { return JSON.parse(localStorage.getItem(CONTENT_CACHE_KEY) || "{}"); }
  catch { return {}; }
}

function saveContentCache(cache) {
  localStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify(cache));
}

async function fetchJson(url, { cacheKey } = {}) {
  const cache = loadContentCache();

  if (cacheKey && cache[cacheKey]) return cache[cacheKey];

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`No se pudo cargar ${url} (${res.status})`);

  const data = await res.json();

  if (cacheKey) {
    cache[cacheKey] = data;
    saveContentCache(cache);
  }
  return data;
}

function assertDeck(deck) {
  if (!deck || typeof deck !== "object") throw new Error("Deck inválido");
  if (!deck.id || !Array.isArray(deck.items)) throw new Error("Deck sin id/items");
  for (const it of deck.items) {
    if (!it.id || !it.type) throw new Error("Item inválido (id/type)");
  }
  return deck;
}

/* -------------------- Estado del usuario (progreso) -------------------- */
function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { known: {}, learning: {}, quiz: { correct: 0, total: 0 } };
    const parsed = JSON.parse(raw);
    return {
      known: parsed.known ?? {},
      learning: parsed.learning ?? {},
      quiz: parsed.quiz ?? { correct: 0, total: 0 },
    };
  } catch {
    return { known: {}, learning: {}, quiz: { correct: 0, total: 0 } };
  }
}

function saveState(state) {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

/* -------------------- Helpers DOM -------------------- */
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

/* -------------------- Variables globales de contenido -------------------- */
let contentIndex = null;   // data/manifest.json
let currentDeck = null;    // deck cargado
let DATA = [];             // normalizado a formato legacy (id, es, en, topic)

/* -------------------- UI: Tabs -------------------- */
const tabs = $all(".tab");
tabs.forEach(btn => {
  btn.addEventListener("click", () => {
    const view = btn.dataset.view;
    tabs.forEach(t => t.classList.toggle("active", t === btn));
    tabs.forEach(t => t.setAttribute("aria-selected", t === btn ? "true" : "false"));
    $all(".view").forEach(v => v.classList.toggle("active", v.id === view));
    renderAll();
  });
});

/* -------------------- Flashcards -------------------- */
const state = loadState();

let cardIndex = 0;
let showingTranslation = false;

const flashcardBtn = $("#flashcardBtn");
const flashcardText = $("#flashcardText");
const prevCard = $("#prevCard");
const nextCard = $("#nextCard");
const markKnown = $("#markKnown");
const markLearning = $("#markLearning");


deckSelect?.addEventListener("change", async () => {
  const deckId = deckSelect.value;

  if (!deckId) {
    DATA = [];
    currentDeck = null;
    cardIndex = 0;
    showingTranslation = false;
    updateStudyAreaVisibility();
    return;
  }

  await loadDeckById(deckId);
  updateStudyAreaVisibility();
  renderAll();
});
function currentCard() {
  if (!DATA.length) return null;
  return DATA[cardIndex % DATA.length];
}
updateStudyAreaVisibility();
function renderFlashcard() {
  const c = currentCard();
  if (!c) {
    flashcardText.textContent = "No hay contenido cargado.";
    return;
  }

  const isKnown = !!state.known[c.id];
  const isLearning = !!state.learning[c.id];

  const label = flashcardBtn.querySelector(".flashcard-label");
  label.textContent = showingTranslation ? "EN" : "ES";

  flashcardText.textContent = showingTranslation ? c.en : c.es;
  flashcardText.style.opacity = (isKnown ? "0.95" : "1");

  const hint = flashcardBtn.querySelector(".flashcard-hint");
  const flags = [
    isKnown ? "Conocida" : null,
    isLearning ? "Aprendiendo" : null,
    c.topic ? `Tema: ${c.topic}` : null,
  ].filter(Boolean).join(" • ");
  hint.textContent = flags || "Click para voltear";
}

flashcardBtn?.addEventListener("click", () => {
  if (!DATA.length) return;
  showingTranslation = !showingTranslation;
  renderFlashcard();
});

prevCard?.addEventListener("click", () => {
  if (!DATA.length) return;
  cardIndex = (cardIndex - 1 + DATA.length) % DATA.length;
  showingTranslation = false;
  renderFlashcard();
});

nextCard?.addEventListener("click", () => {
  if (!DATA.length) return;
  cardIndex = (cardIndex + 1) % DATA.length;
  showingTranslation = false;
  renderFlashcard();
});

markKnown?.addEventListener("click", () => {
  const c = currentCard();
  if (!c) return;
  state.known[c.id] = true;
  delete state.learning[c.id];
  saveState(state);
  renderAll();
});

markLearning?.addEventListener("click", () => {
  const c = currentCard();
  if (!c) return;
  state.learning[c.id] = true;
  delete state.known[c.id];
  saveState(state);
  renderAll();
});

/* -------------------- Quiz -------------------- */
const quizMeta = $("#quizMeta");
const quizQuestion = $("#quizQuestion");
const quizAnswers = $("#quizAnswers");
const quizFeedback = $("#quizFeedback");
const nextQuestion = $("#nextQuestion");
const resetQuiz = $("#resetQuiz");

let quizItem = null;
let quizLocked = false;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickQuizItem() {
  if (!DATA.length) return null;

  const learningIds = Object.keys(state.learning);
  const pool = learningIds.length
    ? DATA.filter(x => learningIds.includes(x.id))
    : DATA;

  return pool[Math.floor(Math.random() * pool.length)];
}

function renderQuiz() {
  if (!DATA.length) {
    if (quizQuestion) quizQuestion.textContent = "No hay contenido cargado.";
    if (quizAnswers) quizAnswers.innerHTML = "";
    if (quizMeta) quizMeta.textContent = "";
    if (quizFeedback) quizFeedback.textContent = "";
    return;
  }

  quizLocked = false;
  quizFeedback.textContent = "";

  quizItem = pickQuizItem();
  if (!quizItem) return;

  const correct = quizItem.en;
  const distractors = shuffle(
    DATA.filter(x => x.id !== quizItem.id).map(x => x.en)
  ).slice(0, 3);

  const options = shuffle([correct, ...distractors]);

  quizMeta.textContent = `Tema: ${quizItem.topic || "General"} • Progreso quiz: ${state.quiz.correct}/${state.quiz.total}`;
  quizQuestion.textContent = `¿Qué significa "${quizItem.es}"?`;

  quizAnswers.innerHTML = "";
  options.forEach(opt => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "answer";
    btn.textContent = opt;
    btn.addEventListener("click", () => onAnswer(btn, opt === correct, correct));
    quizAnswers.appendChild(btn);
  });
}

function onAnswer(button, isCorrect, correctText) {
  if (quizLocked) return;
  quizLocked = true;

  state.quiz.total += 1;

  if (isCorrect) {
    state.quiz.correct += 1;
    button.classList.add("correct");
    quizFeedback.textContent = "Correcto.";
    state.known[quizItem.id] = true;
    delete state.learning[quizItem.id];
  } else {
    button.classList.add("wrong");
    quizFeedback.textContent = `Incorrecto. Respuesta: ${correctText}`;
    state.learning[quizItem.id] = true;
    delete state.known[quizItem.id];

    Array.from(quizAnswers.children).forEach(b => {
      if (b.textContent === correctText) b.classList.add("correct");
    });
  }

  saveState(state);
  renderProgress();
  quizMeta.textContent = `Tema: ${quizItem.topic || "General"} • Progreso quiz: ${state.quiz.correct}/${state.quiz.total}`;
}

nextQuestion?.addEventListener("click", renderQuiz);

resetQuiz?.addEventListener("click", () => {
  state.quiz = { correct: 0, total: 0 };
  saveState(state);
  renderAll();
});

/* -------------------- Progreso -------------------- */
const statKnown = $("#statKnown");
const statLearning = $("#statLearning");
const statQuizScore = $("#statQuizScore");
const exportData = $("#exportData");
const importData = $("#importData");
const wipeData = $("#wipeData");
const dataBox = $("#dataBox");

function renderProgress() {
  const knownCount = Object.keys(state.known).length;
  const learningCount = Object.keys(state.learning).length;

  statKnown.textContent = String(knownCount);
  statLearning.textContent = String(learningCount);

  const total = state.quiz.total || 0;
  const correct = state.quiz.correct || 0;
  const pct = total ? Math.round((correct / total) * 100) : 0;
  statQuizScore.textContent = `${pct}%`;
}

exportData?.addEventListener("click", () => {
  dataBox.value = JSON.stringify(state, null, 2);
});

importData?.addEventListener("click", () => {
  try {
    const parsed = JSON.parse(dataBox.value || "{}");
    const next = {
      known: parsed.known ?? {},
      learning: parsed.learning ?? {},
      quiz: parsed.quiz ?? { correct: 0, total: 0 },
    };
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
    location.reload();
  } catch {
    alert("JSON inválido.");
  }
});

wipeData?.addEventListener("click", () => {
  localStorage.removeItem(STORE_KEY);
  location.reload();
});

/* -------------------- Render general -------------------- */
function renderAll() {
  renderFlashcard();
  renderQuiz();
  renderProgress();
}

/* -------------------- Carga de contenido (manifest + deck) -------------------- */
function normalizeDeckItems(deck) {
  // Convertimos deck.items => DATA legacy (id, es, en, topic)
  // Solo usamos items type=card por ahora
  const cards = deck.items
    .filter(it => it.type === "card")
    .map(it => ({
      id: it.id,
      es: it.front?.text ?? "",
      en: it.back?.text ?? "",
      topic: it.meta?.topic ?? it.meta?.tag ?? ""
    }))
    .filter(x => x.id && x.es && x.en);

  return cards;
}

async function loadDeckById(deckId) {
  const def = contentIndex.decks.find(d => d.id === deckId);
  if (!def) throw new Error(`Deck no encontrado: ${deckId}`);

  const url = `./data/${def.file.replace("./", "")}`;
  currentDeck = assertDeck(await fetchJson(url, { cacheKey: `deck:${deckId}` }));
  DATA = normalizeDeckItems(currentDeck);

  // reset índice si quedara fuera
  cardIndex = 0;
  showingTranslation = false;
}

async function initContent() {
  contentIndex = await fetchJson("./data/manifest.json", { cacheKey: "manifest" });

  if (!contentIndex.decks?.length) {
    throw new Error("No hay decks en data/manifest.json");
  }

  deckSelect.innerHTML = '<option value="">Selecciona un deck</option>';

  contentIndex.decks.forEach(deck => {
    const option = document.createElement("option");
    option.value = deck.id;
    option.textContent = deck.title;
    deckSelect.appendChild(option);
  });

  DATA = [];
  currentDeck = null;
  updateStudyAreaVisibility();
}

/* -------------------- Init -------------------- */
(async function init() {
  try {
    await initContent();
  } catch (e) {
    console.error(e);
    if (flashcardText) flashcardText.textContent = "Error cargando contenido JSON.";
    if (quizQuestion) quizQuestion.textContent = "Error cargando contenido JSON.";
  }
})();