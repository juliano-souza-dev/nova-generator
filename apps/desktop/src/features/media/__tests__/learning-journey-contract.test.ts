import test from "node:test";
import assert from "node:assert/strict";
import { validateLearningJourney, LEARNING_JOURNEY_CONTRACT } from "../src/features/media/learning-journey-contract";

const base = {
  contract: LEARNING_JOURNEY_CONTRACT,
  version: 1,
  source: { projectId: "project-1", assetId: "asset-1", sourceSignature: "sha256:abc" },
  language: { source: "en", support: "pt-BR" },
  days: [
    { day: 1, title: "Explore & Understand", mode: "existing-stages", stageKeys: ["english", "word", "shadowing", "audio", "practice"] },
    { day: 2, title: "Listening Recall", mode: "listening-recall", activities: [{ id: "a", type: "identify" }, { id: "b", type: "gap" }, { id: "c", type: "detail" }] },
    { day: 3, title: "Notice in Context", mode: "micro-lessons", lessons: [{ id: "lesson-1" }] },
    { day: 4, title: "Deep Listening", mode: "deep-listening", tasks: [{ id: "task-1" }] },
    { day: 5, title: "Speak & Compare", mode: "speaking", prompts: [{ id: "speak-1" }] },
    { day: 6, title: "Listening & Speaking Challenge", mode: "mixed-challenge", listening: [{ id: "a" }], speaking: [{ id: "b" }] },
    { day: 7, title: "Final Challenge", mode: "final-challenge", listening: [{ id: "a" }], speaking: [{ id: "b" }], successCriteria: ["understand", "speak"] }
  ]
};

test("accepts a complete seven-day learning journey package", () => {
  assert.deepEqual(validateLearningJourney(base), []);
});

test("rejects a journey without enough listening practice or a Day 3 lesson", () => {
  const invalid = structuredClone(base);
  invalid.days[1].activities = [];
  invalid.days[2].lessons = [];
  assert.equal(validateLearningJourney(invalid).length, 2);
});
