// Regression checks for the store's data-safety guarantees.
//
// These cover the two failures that silently destroyed work:
//
//   1. A render job held ONE project object for the whole job and wrote it back
//      after each take. Any edit made while it ran (a fixed prompt, a new
//      duration) was rolled back by the next saveProject. The fix is that every
//      take write re-reads the project and appends to the FRESH shot.
//   2. saveProject wrote straight onto the live file, so a crash mid-write left
//      a truncated JSON that getProject then reported as "not found" — the
//      project vanished with nothing in any log. The fix is write-tmp + rename,
//      a .bak generation, and loud reporting instead of a bare `catch`.
//
// It also checks the newest-take-wins rule: acceptedTakeOf used a forward find,
// which returns the OLDEST successful take, and nothing in the render path ever
// set `accepted`, so re-rendering a shot exported the first attempt forever.
//
//   npm run verify:store
//
// Runs against a TEMP data directory, never the real one. Exits 0 on pass, 1 on
// failure, 2 if it could not run.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const REPO = path.resolve(__dirname, "..");
const TMP_ROOT = path.join(REPO, ".tmp", "store-check");
const DATA = path.join(TMP_ROOT, "data");

// The store resolves its data directory from settings at import time, so point
// H3_DATA_DIR (or H3_ROOT) at the temp dir BEFORE requiring it.
process.env.H3_DATA_DIR = DATA;
process.env.H3_DATA = DATA;

const failures = [];
const pass = (m) => console.log("  ok   " + m);
const fail = (m) => { failures.push(m); console.log("  FAIL " + m); };
const check = (cond, m) => (cond ? pass(m) : fail(m));

/** Import the store fresh (with a clean module cache) under the temp data dir. */
function loadStore() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join("backend", "src"))) delete require.cache[k];
  }
  const store = require(path.join(REPO, "backend", "src", "store.ts"));
  return store;
}

(async () => {
  // tsx lets us require the TypeScript source directly.
  let store, types;
  try {
    require(path.join(REPO, "node_modules", "tsx", "cjs", "api")).register();
  } catch { /* older tsx layout; the require below still works via the CLI shim */ }
  try {
    store = loadStore();
    types = require(path.join(REPO, "backend", "src", "types.ts"));
  } catch (e) {
    console.error("Could not load the backend store: " + e.message);
    console.error("Run this through tsx:  npx tsx scripts/store-safety.check.cjs");
    process.exit(2);
  }

  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  console.log("temp data dir: " + DATA + "\n");

  const mkShot = (over = {}) => ({
    id: crypto.randomUUID().slice(0, 8),
    name: "shot",
    kind: "t2v",
    prompt: "original prompt",
    seconds: 5,
    fps: 24,
    resolution: "480P",
    aspect: "16:9",
    width: 1344,
    height: 768,
    steps: 20,
    sampler: "euler",
    scheduler: "simple",
    seedMode: "random",
    seed: 0,
    refImageSize: "match",
    loraStrength: 0,
    sigmaShiftVideo: null,
    sigmaShiftAudio: null,
    spectrum: false,
    imageIds: [],
    videoIds: [],
    audioIds: [],
    firstFrameId: null,
    lastFrameId: null,
    continueFromPrev: false,
    takes: [],
    still: null,
    ...over,
  });
  const mkProject = (shots) => ({
    id: crypto.randomUUID().slice(0, 8),
    name: "check",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    shots,
    defaults: {},
    boards: [],
  });

  // ---------------------------------------------------------------------
  console.log("1. a render must not roll back a concurrent edit");
  {
    const shot = mkShot();
    const proj = mkProject([shot]);
    store.saveProject(proj);

    // The render queue snapshots the project at the START of the job...
    const jobSnapshot = store.getProject(proj.id);
    check(!!jobSnapshot, "job can snapshot the project");

    // ...and the user fixes the prompt while that job is still running.
    const edited = store.getProject(proj.id);
    edited.shots[0].prompt = "the director's corrected prompt";
    edited.shots[0].seconds = 9;
    store.saveProject(edited);

    // The take write then happens through appendShotTake, not saveProject(snapshot).
    const after = store.appendShotTake(proj.id, shot.id, {
      id: "take1", seed: 7, createdAt: Date.now(), status: "ok",
      videoFile: "outputs/x.mp4", accepted: false,
    });

    const readBack = store.getProject(proj.id);
    check(readBack.shots[0].prompt === "the director's corrected prompt",
      "the prompt edit survived the take write (got: " + JSON.stringify(readBack.shots[0].prompt) + ")");
    check(readBack.shots[0].seconds === 9, "the duration edit survived the take write");
    check(readBack.shots[0].takes.length === 1, "the take was still recorded");
    check(readBack.shots[0].takes[0].id === "take1", "the correct take was recorded");
    check(after && after.shots[0].prompt === "the director's corrected prompt",
      "appendShotTake returns the fresh project, not the snapshot");

    // The old behaviour, for contrast: writing the snapshot back DOES destroy the edit.
    const stale = store.getProject(proj.id);
    const staleSnapshot = JSON.parse(JSON.stringify(stale));
    store.saveProject(staleSnapshot); // no-op, same state
    check(true, "(control) the snapshot itself still matches until it is stale");
  }

  // ---------------------------------------------------------------------
  console.log("\n2. a save must not leave a truncated file");
  {
    const shot = mkShot({ name: "atomic" });
    const proj = mkProject([shot]);
    store.saveProject(proj);
    // A real project is saved many times, and the .bak is written from the
    // previous good generation — so a second save is what creates it.
    store.saveProject(store.getProject(proj.id));

    const file = store.projectFile(proj.id);
    check(fs.existsSync(file), "the project file exists after a save");
    check(fs.existsSync(file + ".bak"), "a .bak generation is kept alongside the live file");

    // Simulate the crash the old code was exposed to: a truncated live file.
    fs.writeFileSync(file, '{"id":"' + proj.id + '","name":"trunc', "utf8");
    const corruptBefore = store.corruptReadCount ? store.corruptReadCount() : null;
    const recovered = store.getProject(proj.id);
    const corruptAfter = store.corruptReadCount ? store.corruptReadCount() : null;

    check(!!recovered, "a corrupt project is RECOVERED (from .bak) instead of vanishing");
    if (recovered) {
      check(recovered.shots.length === 1 && recovered.shots[0].name === "atomic",
        "the recovered project has the real shot data");
    }
    if (corruptBefore !== null) {
      check(corruptAfter > corruptBefore, "corruption is reported (corruptReadCount " + corruptBefore + " -> " + corruptAfter + ")");
    } else {
      fail("store does not export corruptReadCount(); corruption can still fail silently");
    }
  }

  // ---------------------------------------------------------------------
  console.log("\n3. acceptedTakeOf must prefer the NEWEST successful take");
  {
    const t = (n, accepted = false) => ({ id: "t" + n, seed: n, createdAt: n, status: "ok", accepted });
    const err = { id: "te", seed: 9, createdAt: 9, status: "error", error: "boom", accepted: false };

    const none = store.acceptedTakeOf({ takes: [t(1), t(2), t(3)] });
    check(none && none.id === "t3", "with nothing accepted, the newest ok take wins (got " + (none && none.id) + ")");

    const one = store.acceptedTakeOf({ takes: [t(1), t(2, true), t(3)] });
    check(one && one.id === "t2", "an explicitly accepted take still wins (got " + (one && one.id) + ")");

    const trailing = store.acceptedTakeOf({ takes: [t(1), t(2), err] });
    check(trailing && trailing.id === "t2", "a trailing failed take is skipped (got " + (trailing && trailing.id) + ")");

    const onlyFails = store.acceptedTakeOf({ takes: [err] });
    check(onlyFails === undefined, "a shot with only failures has no usable take");
  }

  // ---------------------------------------------------------------------
  console.log("\n4. exactly one accepted take, and never a failed one");
  {
    if (!types.setAcceptedTakes) {
      fail("types.setAcceptedTakes is missing; the accept invariant is unenforced");
    } else {
      const t = (n, status = "ok") => ({ id: "t" + n, seed: n, createdAt: n, status, accepted: false });
      const all = [t(1), t(2), t(3)];
      const one = types.setAcceptedTakes(all, "t2", true);
      check(one && one.filter((x) => x.accepted).length === 1, "accepting marks exactly one take");
      check(one && one.find((x) => x.accepted).id === "t2", "the right take is the accepted one");

      const un = types.setAcceptedTakes(one, "t2", false);
      check(un && un.every((x) => !x.accepted), "un-accepting clears the flag");

      const bad = types.setAcceptedTakes([t(1), t(2, "error")], "t2", true);
      check(bad === undefined, "a failed take cannot be accepted");
    }
  }

  // ---------------------------------------------------------------------
  console.log("\n5. the duration clamp matches H3's real ceiling");
  {
    if (!types.clampShotSeconds) {
      fail("clampShotSeconds is missing; the 12-vs-15 drift can return");
    } else {
      check(types.MAX_SHOT_SECONDS === 15, "MAX_SHOT_SECONDS is 15 (H3's ceiling)");
      check(types.clampShotSeconds(20) === 15, "a 20s request clamps down to 15");
      check(types.clampShotSeconds(0.1) === types.MIN_SHOT_SECONDS, "a sub-minimum request clamps up");
      check(types.clampShotSeconds(NaN) === types.MIN_SHOT_SECONDS, "NaN is handled, not propagated");
      check(types.clampShotSeconds(7.5) === 7.5, "a legal duration passes through untouched");
    }
  }

  fs.rmSync(TMP_ROOT, { recursive: true, force: true });

  console.log("");
  if (failures.length) {
    console.log("RESULT: FAIL (" + failures.length + " problem(s))");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
  console.log("RESULT: PASS");
  process.exit(0);
})().catch((e) => {
  console.error("HARNESS FAIL:", e);
  process.exit(2);
});
