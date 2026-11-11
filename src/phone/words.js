// What the phone line says. The fixed prompts (P01 to P53) are recorded once and uploaded to Fonory under their
// codes; the script is the "Phone system setup" tab of the build plan doc, and this list must match it.
// Everything else (words, numbers, names, places, times) is a spoken piece: a saved recording when we have one,
// otherwise Fonory's own Yiddish voice says the text, and we make the recording for next time (audio.js).

export const LINE_NAME = "פארשעי משפחת רבינו טראנספארטעישן";

export const PROMPTS = {
  P01: `שלום עליכם, איר האט אנגערופן ${LINE_NAME}.`,
  P02: "סארי, דער נאמבער פון וואו איר רופט איז נישט רעדזשיסטערט.",
  P03: "דער סיסטעם איז יעצט נישט אוועילעבל. רופט גלייך דעם דרייווער.",
  P04: "צו באשטעלן א רייד, דריקט 1. צו הערן אייערע ריידס, דריקט 2. צו קענסלען א רייד, דריקט 3. צו הערן ווען עס זענען דא ריידס, דריקט 4. צו הערן נאכאמאל, דריקט 9.",
  P05: "אויב איר רופט צו קאנפירמען אייער רייד, דריקט 1.",
  P06: "פאר זיך אליין, דריקט 1. פאר איינעם אנדערש, דריקט 2.",
  P07: "פאר וועמען איז די רייד?",
  P08: "וויפיל מענער דארפן די רייד? דריקט די צאל.",
  P09: "וויפיל פרויען דארפן די רייד? דריקט די צאל.",
  P10: "מעגן די מענער און פרויען זיצן צוזאמען? יא, דריקט 1. ניין, דריקט 2.",
  P11: "פון וואו? פון שטוב, דריקט 1. פון אן אנדער פלאץ, דריקט 2.",
  P12: "וואוהין? אהיים, דריקט 1. צו אן אנדער פלאץ, דריקט 2.",
  P13: "דריקט דעם קאוד פונעם פלאץ, און דערנאך פאונד.",
  P14: "צו הערן די ליסט פון פלעצער, דריקט 0.",
  P15: "ווען? יעצט, דריקט 1. שפעטער היינט, דריקט 2.",
  P16: "דריקט די צייט מיט פיר נאמבערס. למשל, פאר האלב דריי, דריקט 0 2 3 0.",
  P17: "פאר א פערטל שעה ווינדאו, דריקט 1. פאר א האלבע שעה ווינדאו, דריקט 2.",
  P18: "ווילט איר אויך א רייד צוריק? יא, דריקט 1. ניין, דריקט 2.",
  P19: "איר האט באשטעלט:",
  P20: "אויב עס שטימט, דריקט 1. צו אנהייבן פון פריש, דריקט 2.",
  P21: "אייער רייד איז געשיקט געווארן צום דרייווער. איר וועט באלד באקומען א קאנפירמעישן.",
  P22: "דער דרייווער איז יעצט נישט אוועילעבל. אייער רייד ווארט, און איז נאך נישט קאנפירמט. איר וועט באקומען א מעסעדזש.",
  P23: "סארי, עס זענען נישטא קיין פאסיגע זיצן אין יענע צייט.",
  P24: "ריידס קען מען באשטעלן נאר פאר היינט, און נישט פאר א צייט וואס איז שוין פארביי.",
  P25: "סארי, דער פלאץ איז אינדרויסן פון די געגנט.",
  P26: "סארי, די רייד איז לענגער ווי א האלבע שעה.",
  P27: "די נעקסטע אוועילעבל צייט איז",
  P27b: "צו נעמען, דריקט 1.",
  P28: "איר האט נישט קיין ריידס היינט.",
  P29: "רייד נאמבער",
  P30a: "קאנפירמט.",
  P30b: "ווארט נאך אויף קאנפירמעישן.",
  P31: "דער דרייווער קומט אן ארום",
  P32: "וועלכע רייד ווילט איר קענסלען? דריקט איר נאמבער.",
  P33: "צו קענסלען, דריקט 1. צוריק, דריקט 2.",
  P34: "די רייד איז געקענסלט.",
  P35: "צו טוישן פון וואו מען נעמט אייך, דריקט 2. צוריק צום מעניו, דריקט 0.",
  P36: "עס איז שוין ווייניגער ווי א האלבע שעה. רופט גלייך דעם דרייווער.",
  P37a: "דער דרייווער קומט אן אין בערך פינף מינוט פאר",
  P37b: "צו קאנפירמען, דריקט 1. צו קענסלען, דריקט 2.",
  P38a: "דער דרייווער בעט צו טוישן די צייט.",
  P38b: "איר זענט מסכים, דריקט 1. נישט מסכים, דריקט 2.",
  P39: "אייער רייד איז קאנפירמט.",
  P40: "סארי, דער דרייווער קען נישט נעמען די רייד.",
  P41: "יישר כח, א גוטן טאג.",
  P42: "דאס איז נישט קיין ריכטיגע אויסוואל.",
  P43: "מיר האבן נישט באקומען קיין אויסוואל.",
  P44: `א מעלדונג פון ${LINE_NAME}:`,
  P45: "דער דרייווער האט זיך פארשפעטיגט. די נייע צייט איז",
  P46: "דער פלאץ איז געטוישט.",
  P47: "וועלכע רייד ווילט איר טוישן? דריקט איר נאמבער.",
  // The schedule (schedule.js): today's hours, the usual hours and the changes coming up. Times and dates come after.
  P48: "היינט זענען דא ריידס פון",
  P49: "היינט זענען נישטא קיין ריידס.",
  P50: "געווענליך זענען דא ריידס פון",
  P51: "טוישונגען אין די קומענדיגע טעג:",
  P52: "זענען דא ריידס פון",
  P53: "זענען נישטא קיין ריידס.",
};

// Small words between pieces, recorded once like the numbers.
export const W = {
  from: "פון",
  to: "קיין",
  at: "אום",
  until: "ביז",
  and: "און",
  men: "מענער",
  women: "פרויען",
  man: "מאן",
  woman: "פרוי",
  morning: "אינדערפרי",
  afternoon: "נאכמיטאג",
  minutes: "מינוט",
  press: "דריקט",
  back: "צוריק",
  instead: "אנשטאט",
  home: "שטוב",
  today: "היינט",
  tomorrow: "מארגן",
};

// Dates for the schedule: "מאנטאג", or "מאנטאג נאוועמבער זעכצן" further ahead.
export const WEEKDAYS = ["זונטאג", "מאנטאג", "דינסטאג", "מיטוואך", "דאנערשטאג", "פרייטאג", "שבת"];
export const MONTHS = ["יאנואר", "פעברואר", "מערץ", "אפריל", "מאי", "יוני", "יולי", "אויגוסט", "סעפטעמבער", "אקטאבער", "נאוועמבער", "דעצעמבער"];

const ONES = ["נול", "איינס", "צוויי", "דריי", "פיר", "פינף", "זעקס", "זיבן", "אכט", "ניין", "צען", "עלף", "צוועלף", "דרייצן", "פערצן", "פופצן", "זעכצן", "זיבעצן", "אכצן", "ניינצן"];
const TENS = { 20: "צוואנציג", 30: "דרייסיג", 40: "פערציג", 50: "פופציג" };

// 0 to 59 in words: 23 = "דריי און צוואנציג" ("איין און" for 21, 31...).
export function numberWords(n) {
  if (n < 20) return ONES[n];
  const tens = Math.floor(n / 10) * 10;
  const one = n % 10;
  if (!one) return TENS[tens];
  return `${one === 1 ? "איין" : ONES[one]} ${W.and} ${TENS[tens]}`;
}

// A time of day as pieces: 14:30 → ["צוויי", "דרייסיג", "נאכמיטאג"]; 10:05 → ["צען", "נול", "פינף", "אינדערפרי"].
export function timePieces(minute) {
  const h24 = Math.floor(minute / 60);
  const m = minute % 60;
  const hour = ((h24 + 11) % 12) + 1;
  const out = [numberWords(hour)];
  if (m > 0 && m < 10) out.push(ONES[0], ONES[m]);
  else if (m) out.push(numberWords(m));
  out.push(h24 < 12 ? W.morning : W.afternoon);
  return out;
}
export const timeText = (minute) => timePieces(minute).join(" ");

// A day as pieces, said from today: tomorrow → ["מארגן"]; within the week → ["מאנטאג"]; later → ["מאנטאג",
// "נאוועמבער", "זעכצן"].
export function dayPieces(day, today) {
  const at = (d) => new Date(`${d}T12:00:00Z`);
  const diff = Math.round((at(day) - at(today)) / 864e5);
  if (diff === 0) return [W.today];
  if (diff === 1) return [W.tomorrow];
  const d = at(day);
  const weekday = WEEKDAYS[d.getUTCDay()];
  if (diff > 1 && diff < 7) return [weekday];
  return [weekday, MONTHS[d.getUTCMonth()], numberWords(d.getUTCDate())];
}

// Every fixed piece, to make ahead (scripts/make-recordings.mjs).
export function allPieces() {
  const out = new Set(Object.values(W));
  for (let n = 0; n < 60; n++) out.add(numberWords(n));
  for (const n of ONES) out.add(n);
  for (const d of [...WEEKDAYS, ...MONTHS]) out.add(d);
  return [...out];
}

// Text messages, the same news in writing.
export const TEXTS = {
  booked: (r) => `${LINE_NAME}: אייער רייד ${r.name ? `פאר ${r.name} ` : ""}${W.at} ${r.time} איז געשיקט געווארן צום דרייווער. איר וועט באקומען א קאנפירמעישן.`,
  accepted: (r) => `${PROMPTS.P39} ${r.name ? `${r.name}, ` : ""}${W.from} ${r.from} ${W.to} ${r.to}. ${PROMPTS.P31} ${r.time}.`,
  not_taken: (r) => `${PROMPTS.P40}${r.name ? ` (${r.name}, ${r.time})` : ""}`,
  time_change: (r) => `${PROMPTS.P38a} ${r.name ? `${r.name}: ` : ""}${r.oldTime} → ${r.newTime}. רופט אן ${LINE_NAME} צו זאגן יא אדער ניין.`,
  reminder: (r) => `${PROMPTS.P37a} ${r.name ? `${r.name}, ` : ""}${r.time}.`,
  late: (r) => `${PROMPTS.P45} ${r.time}${r.name ? ` (${r.name})` : ""}.`,
  cancelled: (r) => `${PROMPTS.P34}${r.name ? ` (${r.name}, ${r.time})` : ""}`,
  announcement: (r) => `${PROMPTS.P44} ${r.text}`,
};
