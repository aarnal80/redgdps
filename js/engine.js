/* ============================================================
   Deck engine — Consulta de diabetes con IA
   API pública para las slides:
     Deck.register(id, { onEnter(el), onLeave(el), onStep(el, i, total), onReset(el) })
     Deck.gsap  -> referencia a GSAP (o shim mínimo si no cargó)
     Deck.on('change', fn)
   Convenciones:
     - Escenario fijo 1920x1080. Diseña a esa resolución.
     - Fragmentos: elementos con class="fragment" se revelan en orden.
       Añade data-step="n" para agrupar varios en el mismo paso.
     - Slides 3D: usa .scene-canvas + .fallback-3d, crea en onEnter, libera en onLeave.
   ============================================================ */
(function () {
  "use strict";

  const Deck = {
    slides: [],
    index: 0,
    step: 0,
    handlers: {},
    _listeners: {},
    gsap: window.gsap || null,
    register(id, h) { this.handlers[String(id)] = h || {}; },
    on(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    _emit(ev, data) { (this._listeners[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); },
  };
  window.Deck = Deck;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---------- WebGL capability ---------- */
  (function detectWebGL() {
    try {
      const c = document.createElement("canvas");
      const ok = !!(window.WebGLRenderingContext &&
        (c.getContext("webgl") || c.getContext("experimental-webgl")));
      if (!ok) document.documentElement.classList.add("no-webgl");
    } catch (e) { document.documentElement.classList.add("no-webgl"); }
  })();

  /* ---------- Escalado del escenario ---------- */
  const stage = $("#stage");
  function fit() {
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  }
  window.addEventListener("resize", fit);

  /* ---------- Carga de slides (fetch de parciales) ---------- */
  async function loadSlides(manifest) {
    const bar = $("#loader .lbar > i");
    const txt = $("#loader .ltext");
    let done = 0;
    // Cargamos en orden para preservar la secuencia en el DOM.
    for (const file of manifest) {
      try {
        const res = await fetch("slides/" + file, { cache: "no-cache" });
        if (res.ok) injectSlide(await res.text());
        else console.warn("Slide pendiente:", file);
      } catch (e) {
        console.warn("Slide pendiente:", file, e.message);
      }
      done++;
      const pct = Math.round((done / manifest.length) * 100);
      if (bar) {
        bar.style.width = pct + "%";
        bar.parentElement.setAttribute("aria-valuenow", String(pct));
      }
      if (txt) txt.textContent = "Cargando presentación… " + pct + "%";
    }
  }

  // Inserta el HTML de una slide y RE-EJECUTA sus <script> (innerHTML no los corre).
  function injectSlide(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    const frag = tpl.content;
    // La sección de esta slide (referencia viva tras insertar en el DOM)
    const section = frag.querySelector(".slide");
    // Extrae scripts para reejecutarlos DENTRO de su sección (innerHTML no los corre).
    const scripts = Array.from(frag.querySelectorAll("script"));
    scripts.forEach(s => s.remove());
    stage.appendChild(frag);
    scripts.forEach(old => {
      const s = document.createElement("script");
      if (old.src) s.src = old.src; else s.textContent = old.textContent;
      // Insertar dentro de la sección para que document.currentScript.closest('.slide') funcione.
      (section || document.body).appendChild(s);
    });
  }

  /* ---------- Fragmentos ---------- */
  function fragmentsOf(slide) {
    // Agrupa por data-step si existe; si no, cada .fragment es un paso.
    const els = $$(".fragment", slide);
    const byStep = new Map();
    let auto = 0;
    els.forEach(el => {
      let key = el.getAttribute("data-step");
      if (key === null) { auto++; key = "auto-" + auto; }
      if (!byStep.has(key)) byStep.set(key, []);
      byStep.get(key).push(el);
    });
    return Array.from(byStep.values()); // array de grupos
  }

  function applyStep(slide, step) {
    const groups = slide.__groups || [];
    groups.forEach((g, i) => {
      g.forEach(el => el.classList.toggle("revealed", i < step));
    });
    const h = Deck.handlers[slide.dataset.slide];
    if (h && h.onStep) { try { h.onStep(slide, step, groups.length); } catch (e) { console.error(e); } }
  }

  /* ---------- Lienzo Prezi: cámara sobre una lona con todas las slides -------
     En vez de apilar diapositivas, las colocamos sobre un plano grande siguiendo
     un recorrido serpenteante (a la derecha dentro de una fila, y abajo al
     cambiar de fila). Una "cámara" —un transform sobre #world— viaja de una a
     otra con zoom-out → desplazamiento → zoom-in, como caminar por el mapa.
     En los saltos largos (menú, inicio/fin) se aleja más: "vuela" sobre la lona. */
  const SW = 1920, SH = 1080;            // tamaño de la pantalla = de cada celda
  const GAP_X = 720, GAP_Y = 480;        // aire entre tarjetas en la lona
  const PITCH_X = SW + GAP_X, PITCH_Y = SH + GAP_Y;
  let world = null;
  const cell = [];                       // {col,row,x,y,cx,cy} por índice

  function buildWorld() {
    world = document.createElement("div");
    world.id = "world";

    // Recorrido en ESCALERA: siempre a la derecha dentro de una parte y RECTO
    // hacia abajo al empezar una parte nueva. Nunca diagonal ni hacia atrás, de
    // modo que la cámara solo se deslice a la derecha o hacia abajo.
    const partStart = new Set();          // primer índice de cada parte (menos la 1ª)
    const partColor = {};                 // índice -> color de su parte
    MENU_GROUPS.forEach((grp, gi) => {
      grp.ids.forEach((id, j) => {
        const idx = Deck.slides.findIndex(s => s.dataset.slide === id);
        if (idx === -1) return;
        partColor[idx] = grp.color;
        if (gi > 0 && j === 0) partStart.add(idx);   // cabecera de parte -> bajar
      });
    });

    let col = 0, row = 0;
    Deck.slides.forEach((s, i) => {
      if (i > 0) { if (partStart.has(i)) row++; else col++; }  // abajo al cambiar de parte; si no, derecha
      const x = col * PITCH_X, y = row * PITCH_Y;
      cell[i] = { col, row, x, y, cx: x + SW / 2, cy: y + SH / 2 };
      s.style.left = x + "px";
      s.style.top = y + "px";
      if (partColor[i]) s.style.setProperty("--part", partColor[i]);
      world.appendChild(s);               // mover la slide a la lona
    });
    stage.appendChild(world);
    // El índice usa la misma fuente de colores que las slides y el menú.
    $$(".agenda-item[data-section]", stage).forEach(item => {
      const group = MENU_GROUPS.find(g => g.ids.includes(item.dataset.section));
      if (group) item.style.setProperty("--part", group.color);
    });
  }

  // Sitúa la cámara: el punto (fx,fy) del mundo queda en el centro de la
  // pantalla con zoom z. Requiere transform-origin:0 0 en #world.
  function setCam(fx, fy, z) {
    world.style.transform =
      `translate(${SW / 2 - fx * z}px, ${SH / 2 - fy * z}px) scale(${z})`;
  }

  // Solo se pintan las slides "cercanas"; el resto se ocultan (.far) para no
  // componer 40 tarjetas en reposo. Durante el viaje se revelan todas (mapa).
  function setVisible(indices) {
    const keep = new Set(indices);
    Deck.slides.forEach((s, i) => s.classList.toggle("far", !keep.has(i)));
  }

  // Efectos "al llegar": se disparan cuando la cámara SE DETIENE en la slide
  // (no al arrancar el viaje), para que animaciones como los contadores se
  // vean en pantalla y no se pierdan durante el desplazamiento.
  function fireArrive(index) {
    const s = Deck.slides[index];
    const h = s && Deck.handlers[s.dataset.slide];
    if (h && h.onArrive) { try { h.onArrive(s); } catch (e) { console.error(e); } }
  }

  let camTween = null;
  function moveCamera(fromIndex, toIndex, instant) {
    const B = cell[toIndex];
    const g = Deck.gsap;
    if (instant || !g || fromIndex == null || fromIndex === toIndex) {
      if (camTween) { camTween.kill(); camTween = null; }
      setCam(B.cx, B.cy, 1);
      setVisible([toIndex]);
      fireArrive(toIndex);
      return;
    }
    const A = cell[fromIndex];
    const dCol = Math.abs(A.col - B.col), dRow = Math.abs(A.row - B.row);
    const dist = Math.hypot(dCol, dRow) || 1;
    const dur = Math.max(0.55, Math.min(1.15, 0.5 + 0.16 * dist));
    // Deslizamiento a zoom fijo (sin alejarse). En pasos adyacentes solo se
    // pintan origen y destino; en saltos del menú se revela todo el recorrido.
    const near = dist <= 1.4;
    setVisible(near ? [fromIndex, toIndex] : Deck.slides.map((_, i) => i));
    const obj = { t: 0 };
    if (camTween) camTween.kill();
    camTween = g.to(obj, {
      t: 1, duration: dur, ease: "power2.inOut",
      onUpdate() {
        const t = obj.t;                                   // desplazamiento puro, z=1
        setCam(A.cx + (B.cx - A.cx) * t, A.cy + (B.cy - A.cy) * t, 1);
      },
      onComplete() { setCam(B.cx, B.cy, 1); setVisible([toIndex]); camTween = null; fireArrive(toIndex); }
    });
  }

  /* ---------- Navegación ---------- */
  function show(newIndex, dir, instant) {
    newIndex = Math.max(0, Math.min(Deck.slides.length - 1, newIndex));
    const prevIndex = Deck.index;
    const prev = Deck.slides[prevIndex];
    const next = Deck.slides[newIndex];

    if (prev && prev !== next) {
      const ph = Deck.handlers[prev.dataset.slide];
      if (ph && ph.onLeave) { try { ph.onLeave(prev); } catch (e) { console.error(e); } }
      prev.classList.remove("active");
    }
    Deck.index = newIndex;
    Deck.step = 0;
    next.__groups = fragmentsOf(next);
    $$(".fragment", next).forEach(el => el.classList.remove("revealed"));
    next.classList.add("active");
    const nh = Deck.handlers[next.dataset.slide];
    if (nh && nh.onReset) { try { nh.onReset(next); } catch (e) { console.error(e); } }
    if (nh && nh.onEnter) { try { nh.onEnter(next); } catch (e) { console.error(e); } }
    applyStep(next, 0);
    updateChrome();
    moveCamera(prev && prev !== next ? prevIndex : null, newIndex, instant);
    Deck._emit("change", { index: newIndex, slide: next });
    if (location.hash !== "#" + (newIndex + 1)) history.replaceState(null, "", "#" + (newIndex + 1));
  }

  function next() {
    const slide = Deck.slides[Deck.index];
    const total = (slide.__groups || []).length;
    if (Deck.step < total) { Deck.step++; applyStep(slide, Deck.step); }
    else if (Deck.index < Deck.slides.length - 1) show(Deck.index + 1, 1);
  }
  function prev() {
    const slide = Deck.slides[Deck.index];
    if (Deck.step > 0) { Deck.step--; applyStep(slide, Deck.step); }
    else if (Deck.index > 0) {
      show(Deck.index - 1, -1);
      // al retroceder, mostrar todos los fragmentos de la slide anterior
      const s = Deck.slides[Deck.index];
      Deck.step = (s.__groups || []).length;
      applyStep(s, Deck.step);
    }
  }

  Deck.nextSlide = () => show(Deck.index + 1, 1);

  function updateChrome() {
    const n = Deck.index + 1, t = Deck.slides.length;
    $("#progress").style.width = (n / t) * 100 + "%";
    const nextButton = $("#next-slide");
    if (nextButton) nextButton.hidden = !["8", "13"].includes(Deck.slides[Deck.index].dataset.slide);
    const hud = $("#hud");
    if (hud) hud.innerHTML = `<b>${String(n).padStart(2, "0")}</b> / ${t}`;
  }

  /* ---------- Índice de diapositivas (menú tipo app) ---------- */
  // Título curado por slide (data-slide -> etiqueta corta), agrupado por bloque de la charla.
  const MENU_GROUPS = [
    { title: "Apertura", color: "#a6093d", ids: ["1", "bienvenida", "2", "3", "ia4"] },
    { title: "Qué es la IA", color: "#1665b0", ids: ["ia5", "ia6", "ia8", "ia9", "ia10"] },
    { title: "De juguete a herramienta", color: "#b45309", ids: ["ia13", "ia14", "ia15", "ia16", "amie-consulta", "amie-seguimiento", "mai-dxo-comite", "mai-dxo-resultados", "ia-agentes"] },
    { title: "Preparar la consulta", color: "#2a7d4f", ids: ["4", "5", "7", "8"] },
    { title: "Durante la consulta", color: "#6a3d9a", ids: ["9", "10", "consulta3000-web"] },
    { title: "GlucoGuía y feedback", color: "#b02a7d", ids: ["13", "feedback"] },
    { title: "Indicaciones para Adriana", color: "#087e8b", ids: ["16"] },
    { title: "Seguimiento", color: "#4338ca", ids: ["sara-seguimiento", "postconsulta-video", "18"] },
    { title: "Herramientas y límites", color: "#65740b", ids: ["ia33", "ia35", "ia36"] },
    { title: "Seguridad clínica", color: "#80412b", ids: ["ia37", "ia38", "ia39"] },
    { title: "Cierre", color: "#475569", ids: ["ia42", "ia44"] },
  ];
  const MENU_LABELS = {
    "bienvenida": "Gracias al congreso redGDPS y a Fran Adán",
    "ia4": "El recorrido de hoy",
    "ia33": "Vuestros pacientes ya usan IA",
    "ia35": "Hecho en la consulta, con IA",
    "ia36": "Lo que todavía no funciona",
    "ia37": "La regla de oro: datos de pacientes",
    "ia38": "Quién firma: tú firmas",
    "ia39": "El sesgo de automatización",
    "ia42": "El mensaje",
    "ia44": "Gracias, recursos y preguntas",
    "ia5": "La IA no nació en 2022",
    "ia6": "Estrecha, general, superinteligencia",
    "ia8": "Qué es un LLM",
    "ia9": "Cómo aprende: comprimir el conocimiento",
    "ia10": "El mapa del significado",
    "ia13": "Ya aprueban el MIR y el USMLE",
    "ia14": "El último examen de la humanidad",
    "ia15": "Luna en la misma liga que o3",
    "ia16": "Mismo examen, otra escala",
    "amie-consulta": "AMIE: una consulta clínica con IA",
    "amie-seguimiento": "AMIE: seguimiento entre consultas",
    "mai-dxo-comite": "Microsoft MAI-DxO: comité virtual de diagnóstico",
    "mai-dxo-resultados": "Microsoft MAI-DxO: resultados y límites",
    "ia-agentes": "Un sistema de cuatro agentes",
    "1": "La inteligencia artificial en el cuidado de las personas con diabetes. Experiencia de un médico de familia",
    "2": "El gancho: ¿quién lo escribió?", "3": "Quién os habla",
    "4": "Ada y Lía preparan la cita de Adriana", "5": "La llamada previa",
    "7": "Coordinar cita y analítica",
    "8": "Adriana: dossier preconsulta para el médico",
    "9": "Transcripción: iniciar con permiso",
    "10": "Escuchar a Adriana sin perder el contacto",
    "consulta3000-web": "Demo de Consulta3000 en ChatGPT",
    "13": "GlucoGuía · Edición Congreso redGDPS",
    "feedback": "Antonio y ChatGPT: feedback de la presentación",
    "16": "Una hoja imprimible para Adriana",
    "sara-seguimiento": "Sara: preparar el seguimiento a las dos semanas",
    "postconsulta-video": "Vídeo y transcripción del seguimiento",
    "18": "Lo que Sara recoge del seguimiento",
  };

  const menuOverlay = $("#menu-overlay");
  const menuBtn = $("#menu-btn");
  const menuList = $("#menu-list");
  const menuSearch = $("#menu-search");
  let menuBuilt = false;

  function norm(s) {
    return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  }

  function buildMenu() {
    if (menuBuilt || !menuList) return;
    let html = "";
    MENU_GROUPS.forEach((group, gi) => {
      const items = group.ids
        .map(id => ({ id, idx: Deck.slides.findIndex(s => s.dataset.slide === id) }))
        .filter(it => it.idx !== -1);
      if (!items.length) return;
      const color = group.color;    // color de la parte
      html += `<div class="menu-group" data-group>`;
      html += `<div class="menu-group-title" style="color:${color}"><span class="mg-dot" style="background:${color}"></span>${group.title}</div>`;
      items.forEach(it => {
        const label = MENU_LABELS[it.id] || ("Diapositiva " + it.id);
        html += `<button type="button" class="menu-item" data-index="${it.idx}" data-search="${norm(label)} ${it.id}">`
              + `<span class="mi-num">${String(it.idx + 1).padStart(2, "0")}</span>`
              + `<span class="mi-label">${label}</span>`
              + `</button>`;
      });
      html += `</div>`;
    });
    html += `<div id="menu-empty">Sin resultados.</div>`;
    menuList.innerHTML = html;
    menuList.addEventListener("click", e => {
      const btn = e.target.closest(".menu-item");
      if (!btn) return;
      const idx = parseInt(btn.dataset.index, 10);
      closeMenu();
      show(idx, idx >= Deck.index ? 1 : -1);
    });
    menuBuilt = true;
  }

  function highlightCurrent() {
    $$(".menu-item", menuList).forEach(el => {
      el.classList.toggle("active", parseInt(el.dataset.index, 10) === Deck.index);
    });
    const active = menuList.querySelector(".menu-item.active");
    if (active) active.scrollIntoView({ block: "center" });
  }

  function filterMenu(query) {
    const q = norm(query.trim());
    let anyVisible = false;
    $$(".menu-group", menuList).forEach(group => {
      let groupHas = false;
      $$(".menu-item", group).forEach(item => {
        const match = !q || item.dataset.search.includes(q);
        item.classList.toggle("hidden", !match);
        if (match) groupHas = true;
      });
      group.classList.toggle("hidden", !groupHas);
      if (groupHas) anyVisible = true;
    });
    const empty = $("#menu-empty");
    if (empty) empty.classList.toggle("show", !anyVisible);
  }

  function openMenu() {
    buildMenu();
    filterMenu("");
    if (menuSearch) menuSearch.value = "";
    highlightCurrent();
    menuOverlay.classList.add("open");
    menuOverlay.setAttribute("aria-hidden", "false");
    menuBtn.classList.add("on");
    menuBtn.setAttribute("aria-expanded", "true");
    setTimeout(() => menuSearch && menuSearch.focus(), 60);
  }
  function closeMenu() {
    menuOverlay.classList.remove("open");
    menuOverlay.setAttribute("aria-hidden", "true");
    menuBtn.classList.remove("on");
    menuBtn.setAttribute("aria-expanded", "false");
  }
  function toggleMenu() { menuOverlay.classList.contains("open") ? closeMenu() : openMenu(); }
  function isMenuOpen() { return menuOverlay && menuOverlay.classList.contains("open"); }

  /* ---------- Visor de apps (web incrustada) ---------- */
  const appOverlay = $("#app-overlay");
  const appFrame = $("#app-frame");
  const appTitle = $("#app-title");
  const appDot = $("#app-dot");
  const appExternal = $("#app-external");
  const appClose = $("#app-close");

  let appTrigger = null;
  function openApp(a) {
    appTrigger = a;
    const external = a.getAttribute("href");
    const src = a.getAttribute("data-embed-src") || external;   // URL a incrustar
    const title = a.getAttribute("data-embed") || "Aplicación";
    const color = a.getAttribute("data-embed-color");
    appTitle.textContent = title;
    if (appDot) appDot.style.background = color || "var(--accent)";
    if (appExternal) { appExternal.href = external || src; appExternal.hidden = a.hasAttribute("data-internal"); }
    appFrame.title = title;
    appOverlay.classList.remove("loaded");
    appFrame.src = src;
    appOverlay.classList.add("open");
    appOverlay.setAttribute("aria-hidden", "false");
    appClose?.focus();
  }
  function closeApp() {
    appOverlay.classList.remove("open");
    appOverlay.setAttribute("aria-hidden", "true");
    appTrigger?.focus();
    appFrame.src = "about:blank";   // detiene la app (sonido/cámara) al volver
  }
  function isAppOpen() { return appOverlay && appOverlay.classList.contains("open"); }
  if (appFrame) appFrame.addEventListener("load", () => appOverlay.classList.add("loaded"));
  if (appClose) appClose.addEventListener("click", closeApp);
  // Clic en un enlace marcado con data-embed -> abrir dentro del deck.
  stage.addEventListener("click", e => {
    const a = e.target.closest("a[data-embed]");
    if (!a) return;
    e.preventDefault();
    openApp(a);
  });

  /* ---------- Input ---------- */
  function onKey(e) {
    const inField = e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    if (isAppOpen()) { if (e.key === "Escape") { e.preventDefault(); closeApp(); } return; }
    if (e.key === "Escape") { if (isMenuOpen()) { e.preventDefault(); closeMenu(); } return; }
    if (e.key === "o" || e.key === "O") { if (!inField) { e.preventDefault(); toggleMenu(); } return; }
    if (isMenuOpen() || inField) return; // no navegar diapositivas con el menú abierto o escribiendo
    switch (e.key) {
      case "ArrowRight": case " ": case "PageDown": e.preventDefault(); next(); hideHint(); break;
      case "ArrowLeft": case "PageUp": e.preventDefault(); prev(); break;
      case "Home": e.preventDefault(); show(0, -1); break;
      case "End": e.preventDefault(); show(Deck.slides.length - 1, 1); break;
      case "f": case "F":
        if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
        else document.exitFullscreen?.();
        break;
    }
  }
  // Clic/tap avanza (salvo sobre elementos interactivos)
  function onClick(e) {
    if (isMenuOpen() || isAppOpen()) return;
    if (e.target.closest("button, a, input, select, textarea, [data-no-advance]")) return;
    if (e.clientX < window.innerWidth * 0.18) prev(); else { next(); hideHint(); }
  }
  let hintTimer;
  function hideHint() { const h = $("#hint"); if (h) h.classList.add("hide"); }

  /* ---------- Arranque ---------- */
  async function boot() {
    fit();
    await loadSlides(window.DECK_MANIFEST || []);
    Deck.slides = $$(".slide", stage);
    Deck.slides.forEach((s, i) => { if (!s.dataset.slide) s.dataset.slide = String(i + 1); });
    buildWorld();                       // reparte las slides por la lona
    // loader off
    const loader = $("#loader");
    if (loader) { loader.classList.add("done"); setTimeout(() => loader.remove(), 700); }
    // primera slide (respeta hash), cámara colocada de golpe (sin viaje)
    const fromHash = parseInt((location.hash || "").replace("#", ""), 10);
    show(Number.isFinite(fromHash) && fromHash > 0 ? fromHash - 1 : 0, 1, true);
    document.addEventListener("keydown", onKey);
    document.getElementById("viewport").addEventListener("click", onClick);
    hintTimer = setTimeout(hideHint, 6000);

    // Índice de diapositivas (menú)
    buildMenu();
    $("#next-slide")?.addEventListener("click", () => Deck.nextSlide());
    if (menuBtn) menuBtn.addEventListener("click", toggleMenu);
    const menuCloseBtn = $("#menu-close");
    if (menuCloseBtn) menuCloseBtn.addEventListener("click", closeMenu);
    if (menuOverlay) menuOverlay.addEventListener("click", e => { if (e.target === menuOverlay) closeMenu(); });
    if (menuSearch) menuSearch.addEventListener("input", () => filterMenu(menuSearch.value));
    Deck.on("change", () => { if (isMenuOpen()) highlightCurrent(); });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

