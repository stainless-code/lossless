import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import { createWindowLookup, modelKey, selectCompactableRange } from "../src/util/token-window.ts";

test("token window: modelKey spells the OpenCode providerID spelling", () => {
  assert.equal(modelKey({ providerID: "test", id: "m1" }), "test/m1");
});

test("token window: modelKey spells the Pi provider spelling", () => {
  assert.equal(modelKey({ provider: "test", id: "m1" }), "test/m1");
});

test("token window: modelKey unwraps a {model} ref to the same spelling", () => {
  assert.equal(modelKey({ model: { providerID: "test", id: "m1" } }), "test/m1");
  assert.equal(
    modelKey({ key: "ignored", reasoning: false, model: { providerID: "test", id: "m1" } }),
    "test/m1",
  );
});

test("token window: modelKey names no model for missing or empty parts", () => {
  assert.equal(modelKey(undefined), "");
  assert.equal(modelKey(null), "");
  assert.equal(modelKey({}), "");
  assert.equal(modelKey({ providerID: "test" }), "");
  assert.equal(modelKey({ id: "m1" }), "");
  assert.equal(modelKey({ providerID: "", id: "m1" }), "");
  assert.equal(modelKey({ providerID: "test", id: "" }), "");
  assert.equal(modelKey({ model: undefined }), "");
});

test("token window: lookup falls back with no catalogue domain", async () => {
  const windowOf = createWindowLookup({}, 200_000);
  assert.equal(await windowOf({ providerID: "test", id: "m1" }), 200_000);
});

test("token window: lookup reads the catalogue window and falls back on a miss", async () => {
  const windowOf = createWindowLookup(
    {
      model: {
        list: () =>
          Promise.resolve({
            data: [{ providerID: "test", id: "m1", limit: { context: 131_072 } }],
          }),
      },
    },
    200_000,
  );
  assert.equal(await windowOf({ providerID: "test", id: "m1" }), 131_072);
  assert.equal(await windowOf({ providerID: "test", id: "m2" }), 200_000);
});

test("token window: lookup asks the catalogue once for the lookup lifetime", async () => {
  let calls = 0;
  const windowOf = createWindowLookup(
    {
      model: {
        list: () => {
          calls += 1;
          return Promise.resolve({
            data: [{ providerID: "test", id: "m1", limit: { context: 131_072 } }],
          });
        },
      },
    },
    200_000,
  );
  assert.equal(await windowOf({ providerID: "test", id: "m1" }), 131_072);
  assert.equal(await windowOf({ providerID: "test", id: "m2" }), 200_000);
  assert.equal(calls, 1);
});

test("token window: lookup asks again after a catalogue failure", async () => {
  let calls = 0;
  const windowOf = createWindowLookup(
    {
      model: {
        list: () => {
          calls += 1;
          if (calls === 1) return Promise.reject(new Error("host starting"));
          return Promise.resolve({
            data: [{ providerID: "test", id: "m1", limit: { context: 131_072 } }],
          });
        },
      },
    },
    200_000,
  );
  assert.equal(await windowOf({ providerID: "test", id: "m1" }), 200_000);
  assert.equal(await windowOf({ providerID: "test", id: "m1" }), 131_072);
  assert.equal(calls, 2);
});

test("token window: lookup filters invalid catalogue entries", async () => {
  const windowOf = createWindowLookup(
    {
      model: {
        list: () =>
          Promise.resolve({
            data: [
              { providerID: "test", id: "bad-missing-limit" },
              { providerID: "test", id: "bad-zero", limit: { context: 0 } },
              { providerID: "test", id: "bad-negative", limit: { context: -5 } },
              {
                providerID: "test",
                id: "bad-infinite",
                limit: { context: Number.POSITIVE_INFINITY },
              },
              { providerID: "test", id: "bad-nan", limit: { context: Number.NaN } },
              { id: "bad-no-provider", limit: { context: 131_072 } },
              { providerID: "test", id: "m1", limit: { context: 131_072 } },
            ],
          }),
      },
    },
    200_000,
  );
  assert.equal(await windowOf({ providerID: "test", id: "m1" }), 131_072);
  assert.equal(await windowOf({ providerID: "test", id: "bad-zero" }), 200_000);
  assert.equal(await windowOf({ providerID: "test", id: "bad-missing-limit" }), 200_000);
});

test("token window: empty nodes select no range", () => {
  assert.equal(
    selectCompactableRange([], 0, 100, () => true),
    null,
  );
});

test("token window: retain reaching the head selects no range", () => {
  const nodes = [
    { seq: "a", tokens: 10 },
    { seq: "b", tokens: 10 },
  ];
  assert.equal(
    selectCompactableRange(nodes, 0, 100, () => true),
    null,
  );
});

test("token window: unbalanced boundary selects no range", () => {
  const nodes = [
    { seq: "a", tokens: 50 },
    { seq: "b", tokens: 50 },
  ];
  assert.equal(
    selectCompactableRange(nodes, 0, 10, () => false),
    null,
  );
});

test("token window: balanced boundary selects the head range", () => {
  const nodes = [
    { seq: "a", tokens: 50 },
    { seq: "b", tokens: 50 },
  ];
  assert.deepEqual(
    selectCompactableRange(nodes, 0, 10, (seq) => seq === "b"),
    {
      start: "a",
      end: "a",
    },
  );
});
