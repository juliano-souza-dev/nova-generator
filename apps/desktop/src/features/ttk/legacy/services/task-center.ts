export type TaskKind = "download" | "trim" | "export" | "transcription" | "installation";
export type TaskStatus = "running" | "completed" | "failed";
export type TaskEvent = {
  type: "started" | "completed" | "failed";
  id: string;
  kind: TaskKind;
  title: string;
  message: string;
  timestamp: number;
};

export const TASK_CENTER_EVENT = "nova:task-center";

// The legacy TTK editor delegates task tracking to the single Nova task center.
export { runTrackedTask } from "../../../tasks/TaskCenter";
