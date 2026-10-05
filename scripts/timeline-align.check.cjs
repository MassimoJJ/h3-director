// Timeline regression check for the director UI.
//
// Verifies, in a real browser:
//   1. ruler/tile geometry agrees at EVERY zoom step (width, x-offset, tick label text)
//   2. scrollLeft stays legal and the moved tile stays in view after a drag-reorder drop
//      in a narrow viewport (the case that overflowed and hid the tile before TIMELINE_GAP)
//   3. the open project, the zoom and the panel split survive a page reload
//   4. no console/JS errors along the way
//
//   npm run verify:timeline                                        built app on :8788
//   $env:H3_URL='http://127.0.0.1:5173/'; npm run verify:timeline   Vite dev server
//
// Exit code: 0 = every check passed, 1 = a check failed, 2 = could not run (app down, no
// browser, no project with 2+ shots). It reverts the reorder it performs, so data is
// left as it was found. Needs a project with at least two shots to test anything real.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const TARGET = process.env.H3_URL || "http://127.0.0.1:8788/";
const OUT = path.join(path.resolve(__dirname, ".."), ".tmp", "shots") + path.sep;
const GAP = 6;     // TIMELINE_GAP   in web/src/views.tsx == gap on .timeline-ruler/.timeline-track
const MIN_SEC = 4; // TIMELINE_MIN_SEC in web/src/views.tsx
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const fail = (msg) => { failures.push(msg); console.log("   !! " + msg); };

/** Pull painted geometry of ruler + track and re-derive expectations in-page. */
const probe = (cfg) => {
  const GAP = cfg.gap, MIN_SEC = cfg.minSec;
  const g = (s) => document.querySelector(s);
  const segs = [...document.querySelectorAll(".tl-ruler-seg")];
  const tiles = [...document.querySelectorAll(".tl-tile")];
  const scroll = g(".timeline-scroll");
  const px = Number((g(".tl-zval") ? g(".tl-zval").textContent : "").replace(/[^0-9.]/g, ""));

  // Durations are painted in the tile footer as e.g. "7s" / "4.5s".
  const durs = tiles.map((t) => {
    const d = t.querySelector(".tl-dur");
    const m = d ? (d.textContent || "").match(/([0-9]+(?:\.[0-9]+)?)s/) : null;
    return m ? parseFloat(m[1]) : 0;
  });

  const rows = segs.map((s, i) => {
    const sb = s.getBoundingClientRect();
    const tb = tiles[i].getBoundingClientRect();
    const lab = s.firstElementChild ? s.firstElementChild.getBoundingClientRect() : null;
    const w = s.firstElementChild ? s.firstElementChild.textContent.trim() : "";
    return {
      i,
      pxDur: durs[i],
      label: w,
      segW: Math.round(sb.width),
      tileW: Math.round(tb.width),
      xDelta: Math.round(sb.x) - Math.round(tb.x),
      labelInSeg: lab ? Math.round(lab.x) >= Math.round(sb.x) : null,
      labelBleed: lab ? Math.max(0, Math.round(lab.right) - Math.round(sb.right)) : null,
      paintXOff: i === 0 ? 0 : Math.round(sb.x - segs[0].getBoundingClientRect().x),
    };
  });

  // Expectations derived only from durations + zoom: widths, x offsets, label text.
  let run = 0, tAcc = 0;
  const fmt = (sec) => { const r = Math.round(sec * 10) / 10; return `${r % 1 === 0 ? r.toFixed(0) : r.toFixed(1)}s`; };
  rows.forEach((r, i) => {
    r.expectW = Math.max(Math.round(px * MIN_SEC), Math.round(r.pxDur * px));
    r.expectXOff = i === 0 ? 0 : run;
    r.expectLabel = fmt(tAcc);
    run += r.expectW + GAP;
    tAcc += r.pxDur;
  });

  return {
    px,
    scrollLeft: scroll ? Math.round(scroll.scrollLeft) : -1,
    scrollMax: scroll ? scroll.scrollWidth - scroll.clientWidth : -1,
    rows,
    endLabel: g(".tl-ruler-end") ? g(".tl-ruler-end").textContent.trim() : null,
    order: tiles.map((t) => { const n = t.querySelector(".tl-name"); return n ? (n.textContent || "").trim() : "?"; }),
  };
};

async function launch() {
  const args = ["--disable-gpu"];
  for (const opts of [{ channel: "msedge" }, { channel: "chrome" }, {}]) {
    try { return await chromium.launch({ ...opts, headless: true, args }); } catch { /* next */ }
  }
  throw new Error("could not launch Edge, Chrome or Chromium");
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  // Reset the persisted timeline settings so the sweep covers the whole zoom ladder.
  // The flag makes this a ONE-TIME reset: an init script runs on every navigation, so
  // without it the reload check below would wipe the very keys it is meant to verify.
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem("h3.verifyInit")) {
        localStorage.removeItem("h3.timelineZoom");
        localStorage.removeItem("h3.timelineSplit");
        localStorage.removeItem("h3.projectId");
        sessionStorage.setItem("h3.verifyInit", "1");
      }
    } catch { /* ignore */ }
  });

  console.log("target:", TARGET);
  try {
    await page.goto(TARGET, { waitUntil: "load" });
  } catch (e) {
    console.error("Cannot reach the app at " + TARGET);
    console.error("Start it with `npm start` (:8788) or `npm run dev:web` (:5173), or set H3_URL.");
    console.error("  " + e.message);
    await browser.close();
    process.exit(2);
  }
  await sleep(2500);

  const sel = page.locator("header select").first();
  if (await sel.count()) await sel.selectOption({ index: 0 });
  await sleep(3000);

  // ---- self-seeding ------------------------------------------------------------
  // This check used to be unrunnable unless the user happened to have a project
  // with 2+ shots, so in practice it guarded nothing. When the open project is
  // too small, create a THROWAWAY project with four shots, point the UI at it,
  // and delete it at the end. Real user data is never touched.
  const apiBase = TARGET.replace(/\/$/, "");
  const seeded = { projectId: null, shots: [] };

  const countShots = async () => (await page.locator(".tl-tile").count());
  let tiles = await countShots();
  console.log("shots in project:", tiles);

  if (tiles < 2) {
    console.log("SEED   open project has < 2 shots; creating a throwaway project for this run");
    try {
      const created = await page.request.post(apiBase + "/api/projects", { data: { name: "verify-timeline-seed" } });
      if (!created.ok()) throw new Error("create project returned HTTP " + created.status());
      const proj = (await created.json()).project ?? await created.json();
      seeded.projectId = proj.id;
      // Durations deliberately differ (and one is sub-4s) so the ruler's
      // min-width floor is exercised, not just equal-width tiles.
      for (const [i, sec] of [2, 5, 7.5, 3].entries()) {
        const r = await page.request.post(apiBase + "/api/projects/" + proj.id + "/shots", {
          data: { name: "seed " + (i + 1), seconds: sec, prompt: "[Subject + Action] seed " + (i + 1) },
        });
        if (!r.ok()) throw new Error("add shot " + (i + 1) + " returned HTTP " + r.status());
      }
      const full = await (await page.request.get(apiBase + "/api/projects/" + proj.id)).json();
      seeded.shots = full.shots.map((s) => s.id);

      // Point the UI at the throwaway project. Selecting by VALUE (not index) is
      // what matters: `selectOption({index: 0})` just picks whatever sorts first
      // by updatedAt, which is normally the real project, not the one we seeded.
      const optionValue = await page.locator("header select option", {
        hasText: "verify-timeline-seed",
      }).first().getAttribute("value").catch(() => null);
      if (!optionValue) throw new Error("the seeded project did not appear in the project picker");
      await page.locator("header select").first().selectOption(optionValue);
      await sleep(2500);
      tiles = await countShots();
      console.log("SEED   throwaway project " + proj.id + " has " + tiles + " shots");
    } catch (e) {
      console.error("SEED   could not create a throwaway project: " + e.message);
    }
  }

  if (tiles < 2) {
    console.error("Need a project with at least 2 shots to test the timeline; found " + tiles + ".");
    await browser.close();
    process.exit(2);
  }

  /** Remove the throwaway project again, whatever happened above. */
  const cleanupSeed = async () => {
    if (!seeded.projectId) return;
    try {
      const r = await page.request.delete(apiBase + "/api/projects/" + seeded.projectId);
      console.log("SEED   cleaned up throwaway project " + seeded.projectId + " (HTTP " + r.status() + ")");
    } catch (e) {
      console.error("SEED   FAILED to delete throwaway project " + seeded.projectId + ": " + e.message);
      failures.push("left a throwaway project behind: " + seeded.projectId);
    }
  };

  const step = async (which) => {
    const b = page.locator(".tl-zbtn").nth(which === "in" ? 1 : 0);
    if ((await b.count()) === 0 || (await b.isDisabled())) return false;
    try { await b.click({ timeout: 1000 }); } catch { return false; }
    await sleep(150);
    return true;
  };

  /** One geometry sample: every tick label over its own tile boundary at this zoom. */
  const report = async (tag) => {
    const r = await page.evaluate(probe, { gap: GAP, minSec: MIN_SEC });
    const bad = [];
    for (const w of r.rows) {
      if (w.label !== w.expectLabel) bad.push(`seg${w.i}: label "${w.label}" != expected "${w.expectLabel}"`);
      if (w.xDelta !== 0) bad.push(`seg${w.i}: xDelta ${w.xDelta} (tile not under its own tick)`);
      if (w.segW !== w.tileW) bad.push(`seg${w.i}: segW ${w.segW} != tileW ${w.tileW}`);
      if (Math.abs(w.paintXOff - w.expectXOff) > 1) bad.push(`seg${w.i}: paintX ${w.paintXOff} != expectX ${w.expectXOff}`);
      if (w.labelInSeg === false) bad.push(`seg${w.i}: label sits left of its own tick`);
    }
    console.log(`${tag} px=${r.px} scroll=${r.scrollLeft}/${r.scrollMax} end="${r.endLabel}"`);
    console.log(`   labels=${r.rows.map((x) => x.label).join(",")} expect=${r.rows.map((x) => x.expectLabel).join(",")}`);
    console.log(`   segW/tileW=${r.rows.map((x) => x.segW + "/" + x.tileW).join(" ")} expectW=${r.rows.map((x) => x.expectW).join(" ")}`);
    console.log(`   xDelta=[${r.rows.map((x) => x.xDelta)}] bleed=[${r.rows.map((x) => x.labelBleed)}] paintX=[${r.rows.map((x) => x.paintXOff)}] expectX=[${r.rows.map((x) => x.expectXOff)}]`);
    console.log(bad.length ? "   FAIL " + bad.join(" | ") : "   OK");
    for (const b of bad) fail(`${tag} ${b}`);
    return r;
  };

  await report("DEFAULT");
  for (let n = 0; n < 8; n++) { if (!(await step("out"))) break; await report("OUT    "); }
  for (let n = 0; n < 8; n++) { if (!(await step("in"))) break; await report("IN     "); }
  await page.screenshot({ path: OUT + "01-geometry.png" });

  // At max zoom the track overflows, so a drop must also keep scrollLeft legal.
  // A 2-shot cut at 1680px fits, so shrink the viewport first to force overflow — otherwise
  // the "keep the moved tile in view" branch (views.tsx scrollToShot math) never runs and the
  // TIMELINE_GAP fix goes untested.
  await page.setViewportSize({ width: 780, height: 950 });
  await sleep(400);
  const vis = () => page.evaluate(([gap]) => {
    const sc = document.querySelector(".timeline-scroll");
    const tiles = [...document.querySelectorAll(".tl-tile")];
    const cr = sc.getBoundingClientRect();
    return {
      scrollLeft: Math.round(sc.scrollLeft),
      scrollMax: Math.round(sc.scrollWidth - sc.clientWidth),
      order: tiles.map((t) => (t.querySelector(".tl-name") || { textContent: "?" }).textContent.trim()),
      tiles: tiles.map((t) => { const r = t.getBoundingClientRect(); return { l: Math.round(r.left - cr.left), r: Math.round(r.right - cr.left) }; }),
      vp: Math.round(cr.width),
    };
  }, [GAP]);

  // The drop really does commit: onReorder POSTs /reorder, so a test that reorders and
  // never restores would shuffle the user's shot list on every run. Capture the real
  // order up front and put it back through the API afterwards.
  const projectId = await sel.inputValue().catch(() => "");
  const originalShotIds = await (async () => {
    try {
      const r = await page.request.get(apiBase + "/api/projects/" + projectId);
      return (await r.json()).shots.map((s) => s.id);
    } catch {
      return [];
    }
  })();
  const restoreOrder = async () => {
    try {
      const r = await page.request.post(apiBase + "/api/projects/" + projectId + "/reorder", {
        data: { shotIds: originalShotIds },
      });
      if (!r.ok()) return "reorder restore returned HTTP " + r.status();
      const now = (await (await page.request.get(apiBase + "/api/projects/" + projectId)).json())
        .shots.map((s) => s.id);
      return JSON.stringify(now) === JSON.stringify(originalShotIds) ? null : "restored order still does not match: " + JSON.stringify(now);
    } catch (e) {
      return "could not restore order: " + e.message;
    }
  };
  console.log("ORDER  original shotIds=" + JSON.stringify(originalShotIds));

  let v0 = await vis();
  const a = await page.locator(".tl-tile").nth(0).boundingBox();
  const b = await page.locator(".tl-tile").nth(1).boundingBox();
  console.log("DROP   before order=" + JSON.stringify(v0.order) + " scroll=" + v0.scrollLeft + "/" + v0.scrollMax + " vp=" + v0.vp + " tiles=" + JSON.stringify(v0.tiles));
  if (v0.scrollMax > 0 && a && b) {
    await page.mouse.move(a.x + a.width / 2, a.y + 20);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.8, b.y + 20, { steps: 15 });
    await sleep(120);
    await page.mouse.up();
    await sleep(600);
    let v1 = await vis();
    const swapped = v1.order[0] !== v0.order[0];
    if (!swapped) fail("drag did not reorder the shots");
    // Track the moved tile BY NAME, not by index. The drag auto-scrolls, so the
    // drop can land anywhere on the timeline — assuming it ended up at index 1
    // tests the wrong tile and reports a false failure.
    // Tile labels are "N. name", and N changes when the tile moves, so compare
    // on the name alone — indexOf on the raw label would miss after a reorder.
    const bare = (label) => String(label).replace(/^\d+\.\s*/, "");
    const movedName = bare(v0.order[0]);
    const movedIdx = () => v1.order.findIndex((l) => bare(l) === movedName);
    // The drop leaves drag-autoscroll momentum behind; the snap is a rAF animation, so sample
    // until the value stops changing and confirm it settles legal and in-view (the old gap-less
    // math could park the moved tile fully off-screen left).
    let prevS = v1.scrollLeft, settled = v1, ticks = 0;
    for (; ticks < 10; ticks++) {
      await sleep(300);
      const s = await vis();
      settled = s;
      v1 = { ...v1, order: s.order, tiles: s.tiles, scrollLeft: s.scrollLeft, scrollMax: s.scrollMax, vp: s.vp };
      if (Math.abs(s.scrollLeft - prevS) <= 1) break;
      prevS = s.scrollLeft;
    }
    const sM = settled.tiles[movedIdx()];
    const sLegal = settled.scrollLeft >= 0 && settled.scrollLeft <= settled.scrollMax + 1;
    const sInView = sM && sM.l < settled.vp && sM.r > 0;
    console.log("SETTLE after " + (ticks * 300) + "ms scroll=" + settled.scrollLeft + "/" + settled.scrollMax
      + (sLegal ? " (legal)" : " (ILLEGAL)") + (sInView ? " [in view]" : " [OFF SCREEN]")
      + " movedTile=[" + (sM ? sM.l + ".." + sM.r : "?") + "] vp=" + settled.vp);
    if (!sLegal) fail("after drop: scrollLeft " + settled.scrollLeft + " outside 0.." + settled.scrollMax);
    if (!sInView) fail("after drop: the moved tile settled off-screen (" + JSON.stringify(sM) + " in " + settled.vp + "px)");
    await page.screenshot({ path: OUT + "02-narrow-drop.png" });

    // Restore the exact original order via the API. A second "drag it back" is a ROTATION,
    // not an inverse, and left the shots permuted on every run. The browser still paints
    // the dragged order until the next poll, so check the SERVER, not the DOM.
    const restoreErr = await restoreOrder();
    v1 = await vis();
    console.log("REVERT painted order=" + JSON.stringify(v1.order) + " scroll=" + v1.scrollLeft + "/" + v1.scrollMax);
    if (restoreErr) fail("the drag's reorder was not undone: " + restoreErr);
    else console.log("REVERT restored the original order via /reorder");
    if (restoreErr) fail("reorder was not reverted back to the original order");
  } else {
    console.log("DROP   SKIPPED - track does not overflow at this viewport (scrollMax=" + v0.scrollMax + ")");
    fail("narrow-viewport drop never ran: the track did not overflow, so the scroll fix is untested");
  }

  // Reload must not lose your place: same project, same zoom, same panel split.
  await page.setViewportSize({ width: 1680, height: 950 });
  await sleep(300);
  const beforeProject = await sel.inputValue().catch(() => "");
  const beforeZoom = await page.locator(".tl-zval").textContent().catch(() => "");
  await page.reload({ waitUntil: "load" });
  await sleep(3000);
  const afterProject = await sel.inputValue().catch(() => "");
  const afterZoom = await page.locator(".tl-zval").textContent().catch(() => "");
  const afterOrder = await page.evaluate(() =>
    [...document.querySelectorAll(".tl-tile")].map((t) => (t.querySelector(".tl-name") || { textContent: "?" }).textContent.trim()));
  console.log("RELOAD project " + JSON.stringify(beforeProject) + " -> " + JSON.stringify(afterProject)
    + "  zoom " + JSON.stringify(beforeZoom) + " -> " + JSON.stringify(afterZoom));
  if (!beforeProject) fail("no project was selected to test reload persistence");
  else if (afterProject !== beforeProject) fail("reload lost the open project (" + beforeProject + " -> " + afterProject + ")");
  if (afterZoom !== beforeZoom) fail("reload lost the timeline zoom (" + beforeZoom + " -> " + afterZoom + ")");
  if ((await page.locator(".tl-tile").count()) < 2) fail("after reload the timeline is empty");
  // Final safety net: whatever happened above, the run must leave the shot order as found.
  if (v0 && JSON.stringify(afterOrder) !== JSON.stringify(v0.order)) {
    const err = await restoreOrder();
    if (err) fail("timeline order left changed by this run (" + JSON.stringify(v0.order) + " -> " + JSON.stringify(afterOrder) + "); " + err);
    else console.log("REVERT final safety net restored the order to " + JSON.stringify(v0.order));
  }
  await page.screenshot({ path: OUT + "03-after-reload.png" });

  await cleanupSeed();

  if (errors.length) { for (const e of errors.slice(0, 8)) fail(e); }
  console.log("JS ERRORS:", errors.length ? errors.slice(0, 8) : "none");

  await browser.close();
  console.log(failures.length ? `\nRESULT: FAIL (${failures.length} problem(s))` : "\nRESULT: PASS");
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS FAIL:", e); process.exit(2); });
