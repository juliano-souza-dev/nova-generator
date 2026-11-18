export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  width: number;
  height: number;
};

export type MediaAsset = {
  id: string;
  name: string;
  originalName: string;
  kind: "video" | "audio" | "image";
  mimeType: string;
  sizeBytes: number;
  relativePath: string;
  source: "local" | "youtube";
  sourceUrl?: string | null;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  createdAt: string;
};

export type YoutubeQuality = {
  height: number;
  label: string;
};

export type YoutubeInspection = {
  videoId: string;
  url: string;
  title: string;
  channel?: string | null;
  durationMs?: number | null;
  thumbnail?: string | null;
  qualities: YoutubeQuality[];
};

export type DownloadProgress = {
  projectId: string;
  percent?: number | null;
  speed?: string | null;
  eta?: string | null;
  status: string;
};

export type YoutubeCacheEntry = {
  videoId: string;
  title: string;
  durationMs?: number | null;
  filePath: string;
  lastAttemptAt: number;
  expiresAt: number;
};
