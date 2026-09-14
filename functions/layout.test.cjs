/**
 * Exercises layout.js.
 *
 * Run with `node layout.test.cjs` from functions/.
 *
 * The arithmetic is most of what is here, and it is worth the space. A layout
 * is created once and read from for as long as the space exists, so a count
 * that is wrong by one line in each direction is wrong on a printed plan, on a
 * donor's receipt, and in the number of lanterns somebody orders.
 */

const assert = require("assert");
const {
  SIDE_MAX,
  adminLayout,
  columnLabel,
  layoutCounts,
  rowLabel,
  unitCount,
  unitLabel,
  validateLayout,
  validateLayoutPatch,
} = require("./layout");

let failures = 0;

/**
 * @param {string} name - What is being checked.
 * @param {Function} body - The check, sync or async.
 * @returns {Promise<void>} When it has run.
 */
async function test(name, body) {
  try {
    await body();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

/**
 * @param {string} name - A group of checks.
 */
function suite(name) {
  console.log(`\n${name}`);
}

/**
 * @param {Object} extra - Fields to override.
 * @returns {Object} A submitted layout that would be accepted.
 */
function submitted(extra = {}) {
  return {
    name: "Lantern Table — 600×600",
    building: "Main Building",
    floor: "1",
    location: "Main Hall, upper rails",
    rows: 8,
    columns: 5,
    allottedBy: "node",
    ...extra,
  };
}

/**
 * @param {Object} body - A submitted layout.
 * @returns {Array<string>} The fields that were refused.
 */
function refused(body) {
  return validateLayout(body).errors.map((e) => e.field);
}

/* ── The counts ───────────────────────────────────────────────────────── */

/**
 * @returns {Promise<void>} When the arithmetic's checks have run.
 */
async function counts() {
  suite("layoutCounts");

  await test("cells are the spaces the lines enclose", () => {
    assert.strictEqual(layoutCounts(8, 5).cells, 40);
  });

  await test("nodes are the crossings, corners included", () => {
    // 8 rows are drawn with 9 lines and 5 columns with 6, so this is 9 × 6 and
    // not 8 × 5. The off-by-one in each direction is the whole point of the
    // check: 40 and 54 are both plausible-looking answers on a screen.
    assert.strictEqual(layoutCounts(8, 5).nodes, 54);
  });

  await test("one row by one column is one cell and four nodes", () => {
    assert.deepStrictEqual(layoutCounts(1, 1), { cells: 1, nodes: 4 });
  });

  await test("the lantern table's lower block", () => {
    // From the plan this module was built from: rows D–S over columns 1–19,
    // allotted by node.
    assert.strictEqual(layoutCounts(16, 19).nodes, 340);
  });

  await test("the allotment decides which count is the capacity", () => {
    const grid = { rows: 8, columns: 5 };
    assert.strictEqual(unitCount({ ...grid, allottedBy: "cell" }), 40);
    assert.strictEqual(unitCount({ ...grid, allottedBy: "node" }), 54);
  });
}

/* ── The addresses ────────────────────────────────────────────────────── */

/**
 * @returns {Promise<void>} When the labelling's checks have run.
 */
async function labels() {
  suite("rowLabel / columnLabel / unitLabel");

  await test("rows are letters and columns are numbers", () => {
    assert.strictEqual(rowLabel(0), "A");
    assert.strictEqual(columnLabel(0), "1");
    assert.strictEqual(unitLabel(3, 4), "D5");
  });

  await test("past Z it doubles rather than running out", () => {
    assert.strictEqual(rowLabel(25), "Z");
    assert.strictEqual(rowLabel(26), "AA");
    assert.strictEqual(rowLabel(51), "AZ");
    assert.strictEqual(rowLabel(52), "BA");
  });

  await test("every row of the largest grid has a label", () => {
    const all = new Set();
    for (let i = 0; i < SIDE_MAX; i += 1) {
      all.add(rowLabel(i));
    }
    assert.strictEqual(all.size, SIDE_MAX);
  });
}

/* ── What is accepted ─────────────────────────────────────────────────── */

/**
 * @returns {Promise<void>} When the validator's checks have run.
 */
async function validation() {
  suite("validateLayout");

  await test("a filled-in form is accepted", () => {
    const checked = validateLayout(submitted());
    assert.ok(checked.ok, JSON.stringify(checked.errors));
    assert.strictEqual(checked.value.rows, 8);
    assert.strictEqual(checked.value.allottedBy, "node");
  });

  await test("a new layout is active", () => {
    // Created switched off would mean the ordinary path through the form ends
    // with a layout no campaign can use and nothing on screen saying why.
    assert.strictEqual(validateLayout(submitted()).value.active, true);
  });

  await test("a name is required", () => {
    assert.deepStrictEqual(refused(submitted({ name: "   " })), ["name"]);
  });

  await test("building, floor and location are not", () => {
    const checked = validateLayout(
      submitted({ building: "", floor: "", location: "" })
    );
    assert.ok(checked.ok);
    assert.strictEqual(checked.value.building, "");
  });

  await test("the floor is text, because floors are called B1 and G", () => {
    assert.strictEqual(validateLayout(submitted({ floor: "B1" })).value.floor, "B1");
  });

  await test("a grid needs both of its sides", () => {
    assert.deepStrictEqual(refused(submitted({ rows: undefined })), ["rows"]);
  });

  await test("a side of nothing, or of more than the maximum, is refused", () => {
    assert.deepStrictEqual(refused(submitted({ rows: 0 })), ["rows"]);
    assert.deepStrictEqual(refused(submitted({ columns: SIDE_MAX + 1 })), ["columns"]);
  });

  await test("half a row is not a row", () => {
    assert.deepStrictEqual(refused(submitted({ rows: 2.5 })), ["rows"]);
  });

  await test("a number typed into a text input still counts", () => {
    // Every form control hands back a string; the browser sending "8" rather
    // than 8 is the normal case and not a malformed request.
    assert.strictEqual(validateLayout(submitted({ rows: "8" })).value.rows, 8);
  });

  await test("the allotment must be one of the two", () => {
    assert.deepStrictEqual(refused(submitted({ allottedBy: "seats" })), ["allottedBy"]);
  });

  await test("every bad field is named, not just the first", () => {
    // The form marks the boxes it was told about, so a validator that stopped
    // at the first error would walk somebody through one mistake at a time.
    assert.deepStrictEqual(refused({}).sort(), [
      "allottedBy", "columns", "name", "rows",
    ]);
  });

  await test("nothing that was not asked for is stored", () => {
    const checked = validateLayout(submitted({ active: false, id: "x", units: 9 }));
    assert.deepStrictEqual(Object.keys(checked.value).sort(), [
      "active", "allottedBy", "building", "columns", "floor",
      "location", "name", "rows",
    ]);
    // Including `active`: the one field this endpoint sets itself.
    assert.strictEqual(checked.value.active, true);
  });

  await test("a body that is not an object is refused, not a crash", () => {
    assert.strictEqual(validateLayout(null).ok, false);
    assert.strictEqual(validateLayout("rows=8").ok, false);
  });
}

/**
 * @returns {Promise<void>} When the patch validator's checks have run.
 */
async function patching() {
  suite("validateLayoutPatch");

  await test("a status is accepted, either way round", () => {
    assert.strictEqual(validateLayoutPatch({ active: false }).value.active, false);
    assert.strictEqual(validateLayoutPatch({ active: true }).value.active, true);
  });

  await test("only a boolean will do", () => {
    // "false" and 0 are what a form sends when nobody has thought about it,
    // and both would switch a layout on if this coerced.
    assert.strictEqual(validateLayoutPatch({ active: "false" }).ok, false);
    assert.strictEqual(validateLayoutPatch({ active: 0 }).ok, false);
    assert.strictEqual(validateLayoutPatch({}).ok, false);
  });

  await test("the grid cannot be changed through this route", () => {
    const checked = validateLayoutPatch({ active: true, rows: 400, name: "x" });
    assert.deepStrictEqual(Object.keys(checked.value), ["active"]);
  });
}

/* ── What the portal reads ────────────────────────────────────────────── */

/**
 * @returns {Promise<void>} When the read shape's checks have run.
 */
async function reading() {
  suite("adminLayout");

  await test("the counts are derived, never read from the document", () => {
    // A stored count is a second copy of a fact, and this is what happens when
    // the two disagree: the document's copy is ignored.
    const layout = adminLayout("l1", {
      name: "Lantern Table",
      rows: 8,
      columns: 5,
      allottedBy: "node",
      active: true,
      cells: 999,
      nodes: 999,
    });
    assert.strictEqual(layout.cells, 40);
    assert.strictEqual(layout.nodes, 54);
    assert.strictEqual(layout.units, 54);
  });

  await test("a Firestore timestamp is read as an instant", () => {
    const layout = adminLayout("l1", {
      rows: 1,
      columns: 1,
      createdAt: { toDate: () => new Date("2026-09-10T02:00:00.000Z") },
    });
    assert.strictEqual(layout.createdAt, "2026-09-10T02:00:00.000Z");
  });

  await test("a half-written document still draws a card", () => {
    // Whatever put it there, a card with an em dash in it is better than a
    // module that will not open.
    const layout = adminLayout("l1", {});
    assert.strictEqual(layout.rows, 0);
    assert.strictEqual(layout.active, false);
    assert.strictEqual(layout.allottedBy, "cell");
    assert.strictEqual(layout.createdAt, null);
  });

  await test("active is a boolean, not whatever was stored", () => {
    assert.strictEqual(adminLayout("l1", { active: "yes" }).active, false);
  });
}

(async () => {
  await counts();
  await labels();
  await validation();
  await patching();
  await reading();
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
