import test from "node:test";
import assert from "node:assert/strict";
import { buildLearningJourneyPackage, validateLearningJourney, LEARNING_JOURNEY_CONTRACT } from "../learning-journey-contract";

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

test("builds a varied listening, micro-lesson, deep-listening and speaking journey", () => {
  const cues = [
    { id: "cue-1", text: "I thought we could try something different.", startMs: 0, endMs: 2200 },
    { id: "cue-2", text: "You know what I mean when I say that.", startMs: 2300, endMs: 4200 },
    { id: "cue-3", text: "We should have talked about it earlier.", startMs: 4300, endMs: 6500 }
  ];
  const cards = [{
    id: "card-1", sourceCueId: "cue-1", focus: "I thought we could",
    meaning: "Uma forma de sugerir algo.", highlightEn: "I thought we could",
    explanation: "A expressão introduz uma sugestão de forma indireta.",
    exampleEn: "I thought we could try again.", examplePt: "Pensei que poderíamos tentar novamente.",
    status: "approved" as const
  }];
  const journey = buildLearningJourneyPackage({
    projectId: "project-1", assetId: "asset-1", sourceSignature: "signature",
    cues, cards
  });
  assert.deepEqual(validateLearningJourney(journey), []);
  assert.ok(journey.days[1].activities.some(item => item.type === "gap"));
  assert.ok(journey.days[1].activities.some(item => item.type === "reconstruct"));
  assert.equal(journey.days[2].lessons.length, 1);
  assert.ok(journey.days[3].tasks.length > 0);
  assert.ok(journey.days[4].prompts.length > 0);
});
