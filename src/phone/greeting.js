// The greeting at the start of a call (Shloime, 2026-11-13): no line name, a greeting for the day or the time of day.
// The Jewish date comes from the Hebrew calendar built into Intl.

const DAY = 86400000;

const formats = new Map(); // making a formatter is slow; one per kind and time zone is kept
const format = (locale, opts) => {
  const key = `${locale}|${opts.timeZone}`;
  if (!formats.has(key)) formats.set(key, new Intl.DateTimeFormat(locale, opts));
  return formats.get(key);
};
function jewishDate(when, timeZone) {
  const parts = format("en-u-ca-hebrew", { timeZone, day: "numeric", month: "long" }).formatToParts(when);
  return { day: Number(parts.find((p) => p.type === "day").value), month: parts.find((p) => p.type === "month").value };
}
function localHourAndWeekday(when, timeZone) {
  const parts = format("en-US", { timeZone, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(when);
  return { hour: Number(parts.find((p) => p.type === "hour").value), weekday: parts.find((p) => p.type === "weekday").value };
}

// Erev Yom Tov: erev Rosh Hashana, Yom Kippur, Sukkos, Pesach, Shavuos. Erev Shmini Atzeres (Hoshana Rabba) and erev
// the last days of Pesach fall in Chol Hamoed and get "a gutn moed" (Shloime, 2026-11-15).
const EREV_YOM_TOV = { Elul: [29], Tishri: [9, 14], Nisan: [14], Sivan: [5] };
// Chol Hamoed (outside Eretz Yisroel): Sukkos 17-21 Tishri (21 = Hoshana Rabba), Pesach 17-20 Nisan.
const CHOL_HAMOED = { Tishri: [17, 21], Nisan: [17, 20] };

// The prompt code to greet with at `now` (a Date) in `timeZone` (Shloime, 2026-11-13).
export function greetingPrompt(now, timeZone = "America/New_York") {
  const { day, month } = jewishDate(now, timeZone);
  // Chanukah: the 8 days from 25 Kislev (it ends on 2 or 3 Teves, by Kislev's length).
  for (let k = 0; k < 8; k++) {
    const d = jewishDate(new Date(now.getTime() - k * DAY), timeZone);
    if (d.month === "Kislev" && d.day === 25) return "P78"; // א לעכטיגן חנוכה
  }
  if ((month === "Adar" || month === "Adar II") && (day === 14 || day === 15)) return "P79"; // א פרייליכן פורים
  const moed = CHOL_HAMOED[month];
  if (moed && day >= moed[0] && day <= moed[1]) return "P77"; // א גוטן מועד
  if (EREV_YOM_TOV[month]?.includes(day)) return "P83"; // א גוטן ערב יום טוב
  const { hour, weekday } = localHourAndWeekday(now, timeZone);
  if (weekday === "Fri") return "P82"; // א גוטן ערב שבת
  if (day === 30 || (day === 1 && month !== "Tishri")) return "P76"; // א גוטן חודש
  if (weekday === "Sat") return "P75"; // א גוטע וואך: motzei Shabbos (nobody calls on Shabbos itself)
  if (hour < 12) return "P72"; // גוט מארגן
  if (hour < 17) return "P73"; // א גוטן טאג
  return "P74"; // א גוטן אוונט
}

// The goodbye (Shloime, 2026-11-15): from 15 Av until Rosh Hashana "a kesiva vachasima tova", from Rosh Hashana through
// Yom Kippur "a gmar chasima tova", after Yom Kippur until before Hoshana Rabba "gmar chosem chaim", on Hoshana Rabba
// "a gut kvitel", else P41.
export function farewellPrompt(now, timeZone = "America/New_York") {
  const { day, month } = jewishDate(now, timeZone);
  if ((month === "Av" && day >= 15) || month === "Elul") return "P80"; // יישר כח, א כתיבה וחתימה טובה
  if (month === "Tishri" && day <= 10) return "P81"; // יישר כח, א גמר חתימה טובה
  if (month === "Tishri" && day <= 20) return "P84"; // יישר כח, גמר חותם חיים
  if (month === "Tishri" && day === 21) return "P85"; // יישר כח, א גוט קוויטל
  return "P41";
}
