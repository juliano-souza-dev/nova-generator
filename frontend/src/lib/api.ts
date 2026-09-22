export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, { headers: { "Content-Type": "application/json", ...init?.headers }, ...init });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const detail = typeof body === "object" && body !== null && "detail" in body ? String(body.detail) : `Erro ${response.status}`;
    throw new ApiError(detail, response.status);
  }
  return response.json() as Promise<T>;
}
