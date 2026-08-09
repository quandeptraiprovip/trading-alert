import fs from "fs";
import path from "path";

/** Temp + fsync + same-directory rename. Target must live inside a directory mount, not be a file mount. */
export function atomicWriteFileSync(
  target: string,
  data: string,
  renameFile: typeof fs.renameSync = fs.renameSync,
): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, data);
  const fd = fs.openSync(tmp, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  renameFile(tmp, target);
  let dirFd: number | undefined;
  try {
    dirFd = fs.openSync(path.dirname(target), "r");
    fs.fsyncSync(dirFd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(code)) throw error;
  } finally {
    if (dirFd != null) fs.closeSync(dirFd);
  }
}
