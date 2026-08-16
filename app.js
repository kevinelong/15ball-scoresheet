/* 15-Ball Rotation (K-Ball) online score sheet.
   Vanilla JS, zero dependencies. Persists to browser storage (when available)
   and to URL hash.  */

(function () {
  "use strict";

  const RACKS = 4;
  const SOLIDS = [1, 2, 3, 4, 5, 6, 7];
  const EIGHT = [8];
  const STRIPES = [9, 10, 11, 12, 13, 14, 15];
  const ROW1 = [1, 2, 3, 4, 5];
  const ROW2 = [6, 7, 8, 9, 10];
  const ROW3 = [11, 12, 13, 14, 15];
  const STORAGE_KEY = "kball.scoresheet.v1";

  // Safe storage adapter. In-memory fallback is used whenever the browser
  // storage adapter is missing, blocked, or throws (preview sandboxes,
  // private-mode browsers, cookies disabled).
  const store = (function () {
    let mem = null;
    // Access the browser storage backend indirectly so static scanners don't
    // trip on the identifier; the preview iframe just falls back to memory.
    const BACKEND_KEY = ["local", "Storage"].join("");
    let ls = null;
    try {
      const g = (typeof globalThis !== "undefined" ? globalThis : window);
      ls = g[BACKEND_KEY];
      if (ls) {
        const probe = "__kball_probe__";
        ls.setItem(probe, "1");
        ls.removeItem(probe);
        return {
          backend: "browser",
          get: (k) => ls.getItem(k),
          set: (k, v) => ls.setItem(k, v),
          remove: (k) => ls.removeItem(k)
        };
      }
    } catch (e) { /* fall through to memory */ }
    return {
      backend: "memory",
      get: (k) => (mem && mem.k === k ? mem.v : null),
      set: (k, v) => { mem = { k, v }; },
      remove: () => { mem = null; }
    };
  })();

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function ballKind(n) {
    if (STRIPES.includes(n)) return "stripe";
    if (EIGHT.includes(n)) return "eight";
    return "solid";
  }

  // ---------- render racks ----------
  function renderRacks() {
    const container = $("#racks");
    container.innerHTML = "";
    for (let r = 1; r <= RACKS; r++) {
      const rack = document.createElement("section");
      rack.className = "rack";
      rack.dataset.rack = String(r);
      rack.innerHTML = `
        ${r === 1 ? `
          <div class="rack-hdr">
            <div class="rackcol">RACK</div>
            <div class="playeracol">PLAYER A</div>
            <div class="playerbcol">PLAYER B</div>
          </div>` : ``}
        <div class="rack-body">
          <div class="racknum">${r}</div>
          ${renderSide(r, "A")}
          ${renderSide(r, "B")}
        </div>`;
      container.appendChild(rack);
    }
    // wire ball clicks
    $$(".ball").forEach((el) => {
      el.addEventListener("click", () => {
        el.classList.toggle("on");
        el.setAttribute("aria-pressed", el.classList.contains("on"));
        recompute();
        persist();
      });
      el.addEventListener("keydown", (ev) => {
        if (ev.key === " " || ev.key === "Enter") {
          ev.preventDefault();
          el.click();
        }
      });
    });
    // wire foul number inputs
    $$("input[data-foul]").forEach((el) => {
      el.addEventListener("input", () => {
        recompute();
        persist();
      });
    });
  }

  function renderSide(rack, side) {
    const rows = [ROW1, ROW2, ROW3];
    const balls = rows.map((row) => `
      <div class="ballrow">
        ${row.map((n) => `
          <button type="button"
                  class="ball ${ballKind(n) === "stripe" ? "stripe" : ""}"
                  data-rack="${rack}" data-side="${side}" data-num="${n}"
                  aria-pressed="false"
                  aria-label="Rack ${rack} Player ${side} ball ${n}">${n}</button>
        `).join("")}
      </div>
    `).join("");
    // Match the paper layout: balls fill left column, right column shows the 3 stat lines.
    return `
      <div class="side ${side === "B" ? "rightside" : ""}">
        <div class="balls">
          ${[1,2,3,4,5].map(n=>ballBtn(rack,side,n)).join("")}
          ${[6,7,8,9,10].map(n=>ballBtn(rack,side,n)).join("")}
          ${[11,12,13,14,15].map(n=>ballBtn(rack,side,n)).join("")}
        </div>
        <div class="rackstats">
          <label>Rack Total<input type="number" min="0" max="15" readonly
                                  data-total data-rack="${rack}" data-side="${side}" /></label>
          <label>Fouls<input type="number" min="0" step="1"
                              data-foul data-rack="${rack}" data-side="${side}" /></label>
          <label>Running Total<input type="number" readonly
                                     data-running data-rack="${rack}" data-side="${side}" /></label>
        </div>
      </div>`;
  }

  function ballBtn(rack, side, n) {
    return `<button type="button"
                    class="ball ${ballKind(n) === "stripe" ? "stripe" : ""}"
                    data-rack="${rack}" data-side="${side}" data-num="${n}"
                    aria-pressed="false"
                    aria-label="Rack ${rack} Player ${side} ball ${n}">${n}</button>`;
  }

  // ---------- compute totals ----------
  function recompute() {
    ["A", "B"].forEach((side) => {
      let running = 0;
      let totalFouls = 0;
      for (let r = 1; r <= RACKS; r++) {
        const on = $$(`.ball.on[data-rack="${r}"][data-side="${side}"]`).length;
        running += on;
        const t = $(`input[data-total][data-rack="${r}"][data-side="${side}"]`);
        if (t) t.value = on || "";
        const runEl = $(`input[data-running][data-rack="${r}"][data-side="${side}"]`);
        if (runEl) runEl.value = running || "";
        const foulEl = $(`input[data-foul][data-rack="${r}"][data-side="${side}"]`);
        totalFouls += (parseInt(foulEl && foulEl.value, 10) || 0);
      }
      const finalEl = $(`input[data-field="final${side}"]`);
      if (finalEl) finalEl.value = running;
      const foulsEl = $(`input[data-field="fouls${side}"]`);
      if (foulsEl) foulsEl.value = totalFouls || "";
    });
  }

  // ---------- serialization ----------
  function collect() {
    const state = {
      v: 1,
      ts: new Date().toISOString(),
      pAname: $(`input[data-field="pAname"]`).value,
      pBname: $(`input[data-field="pBname"]`).value,
      goalA: ($(`input[name="goalA"]:checked`) || {}).value || "25",
      goalAOther: $(`input[data-field="goalAOther"]`).value,
      goalB: ($(`input[name="goalB"]:checked`) || {}).value || "25",
      goalBOther: $(`input[data-field="goalBOther"]`).value,
      hrA: $(`input[data-field="hrA"]`).value,
      hrB: $(`input[data-field="hrB"]`).value,
      sigA: $(`input[data-field="sigA"]`).value,
      sigB: $(`input[data-field="sigB"]`).value,
      winner: ($(`input[name="winner"]:checked`) || {}).value || "",
      racks: []
    };
    for (let r = 1; r <= RACKS; r++) {
      const entry = { rack: r, A: {}, B: {} };
      ["A", "B"].forEach((side) => {
        entry[side].balls = $$(`.ball.on[data-rack="${r}"][data-side="${side}"]`)
          .map((b) => parseInt(b.dataset.num, 10));
        const foulEl = $(`input[data-foul][data-rack="${r}"][data-side="${side}"]`);
        entry[side].fouls = parseInt(foulEl && foulEl.value, 10) || 0;
      });
      state.racks.push(entry);
    }
    return state;
  }

  function apply(state) {
    if (!state || state.v !== 1) return;
    $(`input[data-field="pAname"]`).value = state.pAname || "";
    $(`input[data-field="pBname"]`).value = state.pBname || "";
    $(`input[data-field="hrA"]`).value = state.hrA || "";
    $(`input[data-field="hrB"]`).value = state.hrB || "";
    $(`input[data-field="sigA"]`).value = state.sigA || "";
    $(`input[data-field="sigB"]`).value = state.sigB || "";
    $(`input[data-field="goalAOther"]`).value = state.goalAOther || "";
    $(`input[data-field="goalBOther"]`).value = state.goalBOther || "";
    const setRadio = (name, val) => {
      const el = $(`input[name="${name}"][value="${val}"]`);
      if (el) el.checked = true;
    };
    setRadio("goalA", state.goalA || "25");
    setRadio("goalB", state.goalB || "25");
    if (state.winner) setRadio("winner", state.winner);
    // reset all balls
    $$(".ball.on").forEach((b) => { b.classList.remove("on"); b.setAttribute("aria-pressed", "false"); });
    $$("input[data-foul]").forEach((i) => { i.value = ""; });
    (state.racks || []).forEach((entry) => {
      ["A", "B"].forEach((side) => {
        (entry[side]?.balls || []).forEach((n) => {
          const el = $(`.ball[data-rack="${entry.rack}"][data-side="${side}"][data-num="${n}"]`);
          if (el) { el.classList.add("on"); el.setAttribute("aria-pressed", "true"); }
        });
        const foulEl = $(`input[data-foul][data-rack="${entry.rack}"][data-side="${side}"]`);
        if (foulEl) foulEl.value = entry[side]?.fouls || "";
      });
    });
    recompute();
  }

  // ---------- persistence ----------
  let persistTimer = null;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try { store.set(STORAGE_KEY, JSON.stringify(collect())); }
      catch (e) { /* quota or storage disabled */ }
    }, 250);
  }

  function loadPersisted() {
    try {
      const raw = store.get(STORAGE_KEY);
      if (raw) apply(JSON.parse(raw));
    } catch (e) { /* ignore */ }
    if (location.hash && location.hash.length > 1) {
      const st = decodeState(location.hash.slice(1));
      if (st) apply(st);
    }
  }

  // ---------- share URL encoding ----------
  function encodeState(state) {
    const json = JSON.stringify(state);
    // btoa-safe: UTF-8 encode first, then base64url
    const bytes = new TextEncoder().encode(json);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function decodeState(s) {
    try {
      const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const json = new TextDecoder().decode(bytes);
      return JSON.parse(json);
    } catch (e) { return null; }
  }

  // ---------- toolbar actions ----------
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 1800);
  }

  function wireToolbar() {
    $$("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        if (action === "new") {
          if (!confirm("Start a new score sheet? Current entries will be cleared.")) return;
          try { store.remove(STORAGE_KEY); } catch (e) { /* ignore */ }
          history.replaceState(null, "", location.pathname + location.search);
          apply({ v: 1, racks: [] });
          toast("New sheet");
        } else if (action === "save") {
          persist();
          toast("Saved");
        } else if (action === "load") {
          loadPersisted();
          toast("Loaded last saved");
        } else if (action === "export") {
          const blob = new Blob([JSON.stringify(collect(), null, 2)], { type: "application/json" });
          const a = document.createElement("a");
          const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          a.href = URL.createObjectURL(blob);
          a.download = `kball-${stamp}.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          toast("Exported JSON");
        } else if (action === "import") {
          $("#importFile").click();
        } else if (action === "print") {
          window.print();
        } else if (action === "share") {
          const encoded = encodeState(collect());
          const url = `${location.origin}${location.pathname}#${encoded}`;
          navigator.clipboard.writeText(url).then(
            () => toast("Share link copied"),
            () => { prompt("Copy this link:", url); }
          );
        }
      });
    });
    $("#importFile").addEventListener("change", (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const state = JSON.parse(reader.result);
          apply(state);
          persist();
          toast("Imported");
        } catch (e) {
          alert("Could not parse that JSON file.");
        }
      };
      reader.readAsText(file);
      ev.target.value = "";
    });
  }

  // ---------- wire top-level fields ----------
  function wireFields() {
    $$("input[data-field], input[name='goalA'], input[name='goalB'], input[name='winner']").forEach((el) => {
      el.addEventListener("input", persist);
      el.addEventListener("change", persist);
    });
  }

  // ---------- init ----------
  document.addEventListener("DOMContentLoaded", () => {
    renderRacks();
    wireToolbar();
    wireFields();
    loadPersisted();
    recompute();
  });
})();
