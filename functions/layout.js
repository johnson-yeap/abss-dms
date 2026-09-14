/*
 * What a layout is, and what the admin API will accept as one.
 *
 * A layout is a grid of a physical space the temple allots to donors — the
 * lamps along a wall, the seats in a hall, the niches on a floor. One layout
 * is a specification that several campaigns can each draw on, so it describes
 * the space and not the giving: no campaign, no donor and no price is in here.
 *
 * Pure, like donation.js: no Firestore, no clock it is not handed. The two
 * modules do not share a helper between them even where the code is the same
 * three lines, because a shared utils module would be a third place to look
 * for the answer to "what does this project consider a name".
 *
 * The counts are the thing to be careful about. A layout stores its rows, its
 * columns and which of the two it allots by, and *nothing else* — the number
 * of cells, the number of intersection nodes and the picture on the card are
 * all derived from those three every time they are wanted. A stored count is
 * a second copy of a fact that can disagree with the first.
 */

// A grid's limits, per side. A hundred rows of a hundred columns is ten
// thousand cells, which is far past anything this temple lays out and still
// small enough to draw as one thumbnail without thinking about it.
const SIDE_MIN = 1;
const SIDE_MAX = 100;

// How a layout hands out its space.
//
//   cell   the space a row and a column enclose between them.
//   node   the point where a row line and a column line cross.
//
// The distinction is not pedantry: a hall of seats is allotted by cell, and a
// wall of lamps mounted where the shelf rails cross is allotted by node. The
// same 8 × 5 grid is 40 of the first and 54 of the second.
const ALLOTMENTS = ["cell", "node"];

const NAME_MAX = 80;

// Building, floor and location. Shorter than the name because they are read
// as a single line under it on a card, not as a heading.
const PLACE_MAX = 60;

// What the list route will return. The temple has a handful of spaces; this
// is a guard against a runaway query, not a paging scheme.
const LIST_LIMIT = 200;

/**
 * @param {*} value - Anything.
 * @returns {string} The value as a trimmed string, or "".
 */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Counts what a person would call characters.
 *
 * [...string] rather than .length: a layout named in Chinese is half as long
 * to .length's UTF-16 code units as it is to the person who typed it.
 *
 * @param {string} value - The text.
 * @returns {number} Characters, as counted by a reader.
 */
function countCharacters(value) {
  return [...value].length;
}

/**
 * @param {*} value - Anything.
 * @returns {number|null} The value as a whole number, or null if it is not one.
 */
function whole(value) {
  const number = typeof value === "number" ? value : Number(text(value));
  return Number.isInteger(number) ? number : null;
}

/**
 * The letter a row is addressed by: A, B ... Z, AA, AB.
 *
 * Rows are letters and columns are numbers because that is how the temple
 * already writes them down — a donor at the Mid-Autumn lantern table is told
 * their lantern is at D5, and the plan pinned to the wall is lettered down the
 * side and numbered across the top. A layout whose addresses did not match
 * that sheet would be a second naming of the same wall.
 *
 * Beyond Z it doubles, spreadsheet-fashion. Real plans also carry hand-made
 * labels — the lantern table has a part-row between C and D that its planner
 * called CA — and those are a layout carrying its own labels, which is a later
 * pass. This is the default every layout starts with.
 *
 * @param {number} index - Zero-based row number.
 * @returns {string} Its label.
 */
function rowLabel(index) {
  let label = "";
  let n = index;
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

/**
 * @param {number} index - Zero-based column number.
 * @returns {string} Its label, one-based, as a number.
 */
function columnLabel(index) {
  return String(index + 1);
}

/**
 * Where one unit of a layout is, written the way it is said out loud.
 *
 * The same form addresses both allotments: a cell is named by the row and
 * column that enclose it, a node by the row line and column line that cross
 * at it. "D5" either way — which is the point, since the donor hears the
 * address and never hears which of the two a layout was built from.
 *
 * @param {number} row - Zero-based row.
 * @param {number} column - Zero-based column.
 * @returns {string} e.g. "D5".
 */
function unitLabel(row, column) {
  return `${rowLabel(row)}${columnLabel(column)}`;
}

/**
 * How many of each unit a grid of this size forms.
 *
 * Cells are the spaces enclosed: rows × columns.
 *
 * Nodes are the crossings of the grid's *lines*, and a grid of r rows has r+1
 * horizontal lines — one above each row and one below the last — so the count
 * is (rows + 1) × (columns + 1). The four corners are nodes. This is the sum
 * that is easy to get wrong by one line in each direction, and it is the
 * number the person creating a layout is looking at when they decide how big
 * to make it.
 *
 * @param {number} rows - How many rows.
 * @param {number} columns - How many columns.
 * @returns {Object} {cells, nodes}.
 */
function layoutCounts(rows, columns) {
  return {
    cells: rows * columns,
    nodes: (rows + 1) * (columns + 1),
  };
}

/**
 * How many things this layout actually has to hand out.
 *
 * @param {Object} layout - Anything with rows, columns and allottedBy.
 * @returns {number} The count of whichever unit it allots by.
 */
function unitCount(layout) {
  const counts = layoutCounts(layout.rows || 0, layout.columns || 0);
  return layout.allottedBy === "node" ? counts.nodes : counts.cells;
}

/**
 * Checks one submitted layout.
 *
 * Errors are field/code pairs rather than sentences, which is the shape
 * validateDonation() uses and for a related reason: the portal is the half
 * that knows how to word a refusal next to the box that caused it, and a
 * server sending English prose is a server holding a piece of the interface.
 *
 * Name, rows, columns and the allotment are required. Building, floor and
 * location are not — a temple with one hall should not have to invent a
 * building to name — and a card draws an em dash where one is missing.
 *
 * @param {Object} body - The posted JSON.
 * @returns {Object} {ok, errors: [{field, code}], value}.
 */
function validateLayout(body) {
  const errors = [];
  const input = body && typeof body === "object" ? body : {};

  const name = text(input.name);
  if (!name) {
    errors.push({ field: "name", code: "required" });
  } else if (countCharacters(name) > NAME_MAX) {
    errors.push({ field: "name", code: "too-long" });
  }

  const place = {};
  for (const field of ["building", "floor", "location"]) {
    const value = text(input[field]);
    if (countCharacters(value) > PLACE_MAX) {
      errors.push({ field, code: "too-long" });
    }
    place[field] = value;
  }

  const size = {};
  for (const field of ["rows", "columns"]) {
    const value = whole(input[field]);
    if (value === null) {
      errors.push({ field, code: "required" });
    } else if (value < SIDE_MIN || value > SIDE_MAX) {
      errors.push({ field, code: "out-of-range" });
    }
    size[field] = value;
  }

  const allottedBy = text(input.allottedBy);
  if (!ALLOTMENTS.includes(allottedBy)) {
    errors.push({ field: "allottedBy", code: "required" });
  }

  if (errors.length) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    value: {
      name,
      ...place,
      rows: size.rows,
      columns: size.columns,
      allottedBy,
      // A new layout is active. The alternative — created switched off, to be
      // turned on in a second step — means the ordinary path through this
      // form ends with a layout that no campaign can use and nothing on
      // screen saying why.
      active: true,
    },
  };
}

/**
 * Checks a change to a layout that already exists.
 *
 * Only `active` today. The grid itself is not editable here on purpose: a
 * layout that has been allotted from cannot lose a row without deciding what
 * happens to whoever was in it, and that decision belongs with the module
 * that does the allotting rather than with this form.
 *
 * @param {Object} body - The posted JSON.
 * @returns {Object} {ok, errors: [{field, code}], value}.
 */
function validateLayoutPatch(body) {
  const input = body && typeof body === "object" ? body : {};

  if (typeof input.active !== "boolean") {
    return { ok: false, errors: [{ field: "active", code: "required" }] };
  }
  return { ok: true, errors: [], value: { active: input.active } };
}

/**
 * @param {*} value - A Firestore Timestamp, an ISO string, or nothing.
 * @returns {string|null} An ISO instant, or null.
 */
function isoInstant(value) {
  if (!value) {
    return null;
  }
  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  return String(value);
}

/**
 * One layout as the portal reads it.
 *
 * The counts are attached here rather than left to the browser so that the
 * arithmetic above is done in exactly one place — the page that draws a card
 * and the form that previews a grid would otherwise each carry their own copy
 * of the (rows + 1) that is the easiest thing in this file to get wrong.
 *
 * @param {string} id - The document id.
 * @param {Object} doc - What is stored.
 * @returns {Object} The layout, with its derived counts.
 */
function adminLayout(id, doc) {
  const rows = doc.rows || 0;
  const columns = doc.columns || 0;
  const allottedBy = ALLOTMENTS.includes(doc.allottedBy) ? doc.allottedBy : "cell";
  const counts = layoutCounts(rows, columns);

  return {
    id,
    name: doc.name || "",
    building: doc.building || "",
    floor: doc.floor || "",
    location: doc.location || "",
    rows,
    columns,
    allottedBy,
    active: doc.active === true,
    cells: counts.cells,
    nodes: counts.nodes,
    units: allottedBy === "node" ? counts.nodes : counts.cells,
    createdAt: isoInstant(doc.createdAt),
    updatedAt: isoInstant(doc.updatedAt),
  };
}

module.exports = {
  ALLOTMENTS,
  LIST_LIMIT,
  NAME_MAX,
  PLACE_MAX,
  SIDE_MAX,
  SIDE_MIN,
  adminLayout,
  columnLabel,
  layoutCounts,
  rowLabel,
  unitCount,
  unitLabel,
  validateLayout,
  validateLayoutPatch,
};
