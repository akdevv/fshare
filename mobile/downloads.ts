// Where received files end up.
// Android: a folder inside the public Download folder, granted once via the system picker
//   (Android 11+ forbids apps from writing to the root of Download, so a subfolder like
//   Download/fshare is the closest we can get). The grant persists across launches.
// iOS: there is no Downloads folder, so files go to the app's Documents folder,
//   which shows up in the Files app under "On My iPhone › fshare" (in a real build).
import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import { readPrefs, writePrefs } from './prefs';

const ANDROID_DOWNLOAD = 'content://com.android.externalstorage.documents/document/primary%3ADownload';

export function getSaveDir(): Directory | null {
  if (Platform.OS !== 'android') return new Directory(Paths.document);
  try {
    const dir = new Directory(readPrefs().saveDir!);
    return dir.exists ? dir : null; // null if the user revoked access or deleted the folder
  } catch {
    return null;
  }
}

export async function pickSaveDir(): Promise<Directory | null> {
  try {
    const dir = await Directory.pickDirectoryAsync(ANDROID_DOWNLOAD);
    writePrefs({ saveDir: dir.uri });
    return dir;
  } catch {
    return null;
  } // picker cancelled
}

// "content://…/tree/primary%3ADownload%2Ffshare" -> "Download/fshare"
export function label(dir: Directory | null) {
  if (!dir) return 'not set';
  if (Platform.OS !== 'android') return 'Files › On My iPhone › fshare';
  return decodeURIComponent(dir.uri)
    .split('/tree/')
    .pop()!
    .replace(/^primary:/, '');
}

// An empty file at "a/b/file.ext" in the save folder, for a received file to be opened straight
// into. Never overwrites: picks "file (1).ext" if the name is taken.
export function placeFor(root: Directory, relPath: string): File {
  const parts = relPath.split('/').filter((p) => p && p !== '..');
  const fileName = parts.pop()!;
  let dir = root;
  for (const part of parts) {
    const found = dir.list().find((e) => e instanceof Directory && e.name === part) as Directory | undefined;
    dir = found ?? dir.createDirectory(part);
  }
  const taken = new Set(dir.list().map((e) => e.name));
  const dot = fileName.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [fileName.slice(0, dot), fileName.slice(dot)] : [fileName, ''];
  let name = fileName;
  for (let i = 1; taken.has(name); i++) name = `${stem} (${i})${ext}`;
  // octet-stream: Android keeps the name exactly as given (with text/plain it would add ".txt");
  // the media scanner still goes by the extension
  return dir.createFile(name, 'application/octet-stream');
}
