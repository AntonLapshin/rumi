import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../dist/lib/normalize.js";

function baseSession(overrides = {}) {
  return {
    url: "https://example.com",
    description: "",
    status: "initialized",
    useCases: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("empty session stays 'initialized'", () => {
  const s = normalize(baseSession());
  assert.equal(s.status, "initialized");
});

test("description without use cases → 'scoping'", () => {
  const s = normalize(baseSession({ description: "hi" }));
  assert.equal(s.status, "scoping");
});

test("use cases without actions → 'scoping'", () => {
  const s = normalize(
    baseSession({
      description: "x",
      useCases: [{ id: "", title: "Sign in", description: "Log in." }],
    }),
  );
  assert.equal(s.status, "scoping");
  assert.equal(s.useCases[0].id, "sign_in");
});

test("all use cases with actions → 'ready' (both session and use case)", () => {
  const s = normalize(
    baseSession({
      description: "x",
      useCases: [
        {
          id: "",
          title: "Sign in",
          description: "Log in.",
          actions: ["a", "b"],
        },
      ],
    }),
  );
  assert.equal(s.status, "ready");
  assert.equal(s.useCases[0].status, "ready");
});

test("any testing status → session 'testing'", () => {
  const s = normalize(
    baseSession({
      description: "x",
      useCases: [
        {
          id: "",
          title: "A",
          description: "A.",
          actions: ["x"],
          status: "testing",
        },
      ],
    }),
  );
  assert.equal(s.status, "testing");
  assert.equal(s.useCases[0].status, "testing"); // preserved
});

test("all terminal → 'complete'", () => {
  const s = normalize(
    baseSession({
      description: "x",
      useCases: [
        { id: "", title: "A", description: "A.", actions: ["x"], status: "passed" },
        { id: "", title: "B", description: "B.", actions: ["x"], status: "failed", reason: "oops" },
      ],
    }),
  );
  assert.equal(s.status, "complete");
});

test("slug collisions get numeric suffix", () => {
  const s = normalize(
    baseSession({
      description: "x",
      useCases: [
        { id: "", title: "Sign in", description: "A." },
        { id: "", title: "sign-in", description: "B." },
      ],
    }),
  );
  assert.equal(s.useCases[0].id, "sign_in");
  assert.equal(s.useCases[1].id, "sign_in_2");
});
