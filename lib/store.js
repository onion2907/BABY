// The diary on disk. One file per day of plain text lines, so a day can be
// read back, copied, or opened in any text editor years from now without this
// program being involved.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

const dayFile = (day) => path.join(DATA_DIR, `${day}.jsonl`);

// Local date, not UTC — a diary day has to match the day the household lived.
export function today(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function append(record) {
  const day = record.day ?? today();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(dayFile(day), JSON.stringify(record) + "\n");
  return record;
}

export function readDay(day) {
  try {
    return fs.readFileSync(dayFile(day), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function listDays() {
  try {
    return fs.readdirSync(DATA_DIR)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.replace(/\.jsonl$/, ""))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
