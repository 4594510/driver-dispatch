// The greeting at the start of a call (Shloime, 2026-11-13): no line name, a greeting for the day or the time of day.
// The Jewish date comes from the Hebrew calendar built into Intl.

const DAY = 86400000;

function jewishDate(when, timeZone) {
  const parts = new Intl.DateTimeFormat("en-u-ca-hebrew", { timeZone, day: "numeric", month: "long" }).formatToParts(when);
  return { day: Number(parts.find((p) => p.type === "day").value), month: parts.find((p) => p.type === "month").value };
}
function localHourAndWeekday(when, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(when);
  return { hour: Number(parts.find((p) => p.type === "hour").value), weekday: parts.find((p) => p.type === "weekday").value };
}

// The prompt code to greet with at `now` (a Date) in `timeZone`.
export function greetingPrompt(now, timeZone = "America/New_York") {
  const { day, month } = jewishDate(now, timeZone);
  // Chanukah: the 8 days from 25 Kislev (it ends on 2 or 3 Teves, by Kislev's length).
  for (let k = 0; k < 8; k++) {
    const d = jewishDate(new Date(now.getTime() - k * DAY), timeZone);
    if (d.month === "Kislev" && d.day === 25) return "P78"; // א לעכטיגן חנוכה
  }
  if ((month === "Adar" || month === "Adar II") && (day === 14 || day === 15)) return "P79"; // א פרייליכן פורים
  if ((month === "Tishri" && day >= 17 && day <= 21) || (month === "Nisan" && day >= 17 && day <= 20)) return "P77"; // א גוטן מועד
  if (month === "Tishri" && day >= 3 && day <= 9) return "P81"; // א גמר חתימה טובה
  if (day === 30 || (day === 1 && month !== "Tishri")) return "P76"; // א גוטן חודש
  if (month === "Iyar" && day === 18) return "P82"; // א פרייליכן לג בעומר
  if (month === "Elul") return "P80"; // א כתיבה וחתימה טובה
  const { hour, weekday } = localHourAndWeekday(now, timeZone);
  if (weekday === "Sun") return "P75"; // א גוטע וואך
  if (hour < 12) return "P72"; // גוט מארגן
  if (hour < 17) return "P73"; // א גוטן טאג
  return "P74"; // א גוטן אוונט
}
