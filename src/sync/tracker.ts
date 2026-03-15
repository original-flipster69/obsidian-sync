export interface FileRecord {
  mtime: number;
  size: number;
  etag: string;
}

export interface SyncMetadata {
  files: Record<string, FileRecord>;
  lastFullSync: number;
}

export function emptyMetadata(): SyncMetadata {
  return { files: {}, lastFullSync: 0 };
}

export type SyncAction =
  | { type: "upload"; path: string }
  | { type: "download"; path: string }
  | { type: "deleteLocal"; path: string }
  | { type: "deleteRemote"; path: string }
  | { type: "conflict"; path: string; resolution: "upload" | "download" };

export interface LocalFile {
  path: string;
  mtime: number;
  size: number;
}

export interface RemoteFile {
  path: string;
  mtime: number;
  size: number;
  etag: string;
}

const MTIME_TOLERANCE_MS = 1000;

export function computeSyncActions(
  localFiles: LocalFile[],
  remoteFiles: RemoteFile[],
  tracked: SyncMetadata
): SyncAction[] {
  const actions: SyncAction[] = [];
  const localMap = new Map(localFiles.map((f) => [f.path, f]));
  const remoteMap = new Map(remoteFiles.map((f) => [f.path, f]));
  const allPaths = new Set([
    ...localMap.keys(),
    ...remoteMap.keys(),
    ...Object.keys(tracked.files),
  ]);

  for (const path of allPaths) {
    const local = localMap.get(path);
    const remote = remoteMap.get(path);
    const prev = tracked.files[path];

    if (local && remote && prev) {
      const localChanged =
        local.mtime > prev.mtime + MTIME_TOLERANCE_MS ||
        local.size !== prev.size;
      const remoteChanged = remote.etag !== prev.etag;

      if (localChanged && remoteChanged) {
        actions.push({
          type: "conflict",
          path,
          resolution: local.mtime >= remote.mtime ? "upload" : "download",
        });
      } else if (localChanged) {
        actions.push({ type: "upload", path });
      } else if (remoteChanged) {
        actions.push({ type: "download", path });
      }
    } else if (local && remote && !prev) {
      actions.push({
        type: "conflict",
        path,
        resolution: local.mtime >= remote.mtime ? "upload" : "download",
      });
    } else if (local && !remote && !prev) {
      actions.push({ type: "upload", path });
    } else if (!local && remote && !prev) {
      actions.push({ type: "download", path });
    } else if (local && !remote && prev) {
      actions.push({ type: "deleteLocal", path });
    } else if (!local && remote && prev) {
      actions.push({ type: "deleteRemote", path });
    }
  }

  return actions;
}
