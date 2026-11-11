// A copy of the database once a day (VACUUM INTO, safe while the server runs), kept in data/backups, the newest
// BACKUP_KEEP (14) kept. On Railway data/ is the volume, so a copy survives a restart; download one now and then
// (or point BACKUP_DIR at another disk) so a lost volume doesn't lose everything.
import fs from "node:fs";
import path from "node:path";

export function backupNow(db, dir, keep = 14, now = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `dispatch-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.db`;
  const file = path.join(dir, name);
  if (fs.existsSync(file)) return file;
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(dir).filter((f) => /^dispatch-.*\.db$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.rmSync(path.join(dir, f));
  return file;
}

// Due when the newest copy is from another day (UTC) than now.
export function backupDue(dir, now = new Date()) {
  if (!fs.existsSync(dir)) return true;
  const newest = fs.readdirSync(dir).filter((f) => /^dispatch-.*\.db$/.test(f)).sort().pop();
  return !newest || newest.slice(9, 19) !== now.toISOString().slice(0, 10);
}
