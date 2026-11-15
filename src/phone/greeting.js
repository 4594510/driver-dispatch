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

// The goodbye (Shloime, 2026-11-15), every call: "yasher koach", the wish of the day, then the wish of the season.
// The day: erev Yom Tov (also Hoshana Rabba and erev the last days of Pesach) a gut yom tov, Friday a gut Shabbos, Chol
// Hamoed a gutn moed, Chanukah, Purim, motzei Shabbos a gute voch (only then), Rosh Chodesh a gutn chodesh, else a gutn
// tog until 5 PM and a gute nacht after. The season: from 15 Av until Rosh Hashana a kesiva vachasima tova and a gut
// gebentsht yor, through Yom Kippur a gmar chasima tova, after it gmar chosem chaim, on Hoshana Rabba a gut kvitel.
// Returns the prompt codes in order.
export function farewellPrompts(now, timeZone = "America/New_York") {
  const { day, month } = jewishDate(now, timeZone);
  const { hour, weekday } = localHourAndWeekday(now, timeZone);
  const moed = CHOL_HAMOED[month];
  const inMoed = moed && day >= moed[0] && day <= moed[1];
  const erevYomTov = EREV_YOM_TOV[month]?.includes(day) || (month === "Tishri" && day === 21) || (month === "Nisan" && day === 20);
  let chanukah = false;
  for (let k = 0; k < 8; k++) {
    const d = jewishDate(new Date(now.getTime() - k * DAY), timeZone);
    if (d.month === "Kislev" && d.day === 25) chanukah = true;
  }
  const dayWish = erevYomTov ? "P89" // א גוט יום טוב
    : weekday === "Fri" ? "P88" // א גוט שבת
    : inMoed ? "P77" // א גוטן מועד
    : chanukah ? "P78" // א לעכטיגן חנוכה
    : (month === "Adar" || month === "Adar II") && (day === 14 || day === 15) ? "P79" // א פרייליכן פורים
    : weekday === "Sat" ? "P75" // א גוטע וואך (motzei Shabbos only)
    : day === 30 || (day === 1 && month !== "Tishri") ? "P76" // א גוטן חודש
    : hour < 17 ? "P73" // א גוטן טאג
    : "P87"; // א גוטע נאכט
  const season = (month === "Av" && day >= 15) || month === "Elul" ? ["P80", "P90"] // א כתיבה וחתימה טובה, א גוט געבענטשט יאר
    : month === "Tishri" && day <= 10 ? ["P81"] // א גמר חתימה טובה
    : month === "Tishri" && day <= 20 ? ["P84"] // גמר חותם חיים
    : month === "Tishri" && day === 21 ? ["P85"] // א גוט קוויטל
    : [];
  return ["P86", dayWish, ...season]; // יישר כח
}
