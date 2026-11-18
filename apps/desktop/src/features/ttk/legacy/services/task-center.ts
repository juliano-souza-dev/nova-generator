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

export const TASK_CENTER_EVENT = "framelab:task-center";

function publish(event: TaskEvent) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<TaskEvent>(TASK_CENTER_EVENT, { detail: event }));
  }
}

export async function runTrackedTask<T>(
  kind: TaskKind,
  title: string,
  action: () => Promise<T>,
): Promise<T> {
  const id = crypto.randomUUID();
  publish({ type: "started", id, kind, title, message: "Preparando tarefa...", timestamp: Date.now() });
  try {
    const result = await action();
    publish({ type: "completed", id, kind, title, message: "Tarefa concluída com sucesso.", timestamp: Date.now() });
    return result;
  } catch (error) {
    publish({
      type: "failed",
      id,
      kind,
      title,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    });
    throw error;
  }
}
