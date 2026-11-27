import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeLegacyPracticalAnswers,
  parseSubmittedAnswers,
  validatePracticalTaskAnswer,
} from "./CandidateInterviews.routes";

const taskId = "7ea27756-08b7-4d13-9e12-26354a69c99c";

test("parses mixed question and practical-task answers", () => {
  const result = parseSubmittedAnswers(
    [
      { question_id: 6, value: true },
      { practical_task_id: taskId, value: 4 },
    ],
    new Set([6]),
    new Set([taskId]),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.questionAnswers.get(6), true);
  assert.equal(result.practicalTaskAnswers.get(taskId), 4);
});

test("requires exactly one answer target", () => {
  const result = parseSubmittedAnswers(
    [{ question_id: 6, practical_task_id: taskId, value: 4 }],
    new Set([6]),
    new Set([taskId]),
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /question ou une tâche pratique/);
});

test("rejects duplicate practical-task answers", () => {
  const result = parseSubmittedAnswers(
    [
      { practical_task_id: taskId, value: 3 },
      { practical_task_id: taskId, value: 4 },
    ],
    new Set<number>(),
    new Set([taskId]),
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /plus d'une fois/);
});

test("rejects unknown practical tasks", () => {
  const result = parseSubmittedAnswers(
    [{ practical_task_id: taskId, value: 4 }],
    new Set<number>(),
    new Set<string>(),
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /tâche pratique invalide/);
});

test("maps queued legacy practical questions to practical-task IDs", () => {
  const result = normalizeLegacyPracticalAnswers(
    [
      { question_id: 15, value: 5 },
      { question_id: 18, value: 4 },
    ],
    new Map([[15, taskId]]),
  );

  assert.deepEqual(result, [
    { practical_task_id: taskId, value: 5 },
    { question_id: 18, value: 4 },
  ]);
});

test("validates practical-task ratings on the 1 to 5 scale", () => {
  assert.equal(validatePracticalTaskAnswer(undefined), null);
  assert.equal(validatePracticalTaskAnswer(1), null);
  assert.equal(validatePracticalTaskAnswer(5), null);
  assert.match(validatePracticalTaskAnswer(0) ?? "", /1 et 5/);
  assert.match(validatePracticalTaskAnswer(6) ?? "", /1 et 5/);
  assert.match(validatePracticalTaskAnswer("5") ?? "", /1 et 5/);
});
