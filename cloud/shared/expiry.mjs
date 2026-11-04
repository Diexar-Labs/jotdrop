// Finding the expiry date on a scanned paper, in the languages written in the Latin alphabet
// (the text recognition on Android reads only that script). The words below are the single
// source: `npm run build:paper-words` writes them into android/.../ExpiryWords.kt, and
// cloud/shared/fixtures/expiry-cases.tsv holds the cases both platforms must agree on.

/**
 * Words before a date that ends something: a validity, a best-before date, a payment, a contract.
 * The first date after the words counts (or on the next line, where scans often put it).
 */
export const END_WORDS = {
  en: ['valid until', 'valid till', 'valid through', 'valid thru', 'valid to', 'good thru', 'good through', 'expiry date', 'expiration date', 'date of expiry', 'expiry', 'expires on', 'expires', 'expiration', 'exp date', 'exp', 'best before end', 'best before', 'best by', 'use by', 'use before', 'due date', 'payment due', 'due by', 'pay by', 'renewal date', 'renews on', 'end date', 'ends on', 'warranty until', 'warranty expires', 'guaranteed until'],
  nl: ['geldig tot en met', 'geldig t/m', 'geldig tm', 'geldig tot', 'vervaldatum', 'vervalt op', 'verloopt op', 'verloopt', 'einddatum', 'eindigt op', 'ten minste houdbaar tot', 'tenminste houdbaar tot', 'houdbaar tot', 'tht', 'te gebruiken tot', 'tgt', 'uiterste betaaldatum', 'uiterlijk betalen voor', 'te betalen voor', 'betalen voor', 'verlengingsdatum', 'looptijd tot', 'garantie tot'],
  de: ['gültig bis', 'ablaufdatum', 'läuft ab am', 'verfällt am', 'verfallsdatum', 'mindestens haltbar bis', 'mhd', 'zu verbrauchen bis', 'haltbar bis', 'fällig am', 'fällig bis', 'zahlbar bis', 'zahlungsziel', 'enddatum', 'endet am', 'gültigkeit bis', 'garantie bis', 'verlängerung am'],
  fr: ["valable jusqu'au", "valable jusqu'à", "valide jusqu'au", "date d'expiration", 'expire le', 'date de fin', 'à consommer de préférence avant', "à consommer jusqu'au", 'à consommer avant', 'dlc', 'dluo', 'ddm', 'date limite', "date d'échéance", 'échéance', 'à payer avant le', 'payable avant le', "garantie jusqu'au", 'fin de validité'],
  es: ['válido hasta', 'válida hasta', 'fecha de caducidad', 'caducidad', 'caduca el', 'fecha de vencimiento', 'vence el', 'vencimiento', 'vigente hasta', 'vigencia hasta', 'consumir preferentemente antes del', 'consumir preferentemente antes de', 'consumir antes del', 'consumir antes de', 'fecha límite', 'fecha de expiración', 'fecha de fin', 'pagar antes del', 'garantía hasta', 'fecha de renovación'],
  ca: ['vàlid fins a', 'vàlida fins a', 'data de caducitat', 'caduca el', 'consumir preferentment abans de', 'data de venciment'],
  it: ['valido fino al', 'valida fino al', 'valido fino a', 'data di scadenza', 'scadenza', 'scade il', 'da consumarsi preferibilmente entro il', 'da consumarsi preferibilmente entro', 'da consumarsi entro il', 'da consumarsi entro', 'consumare entro', 'data di fine', 'pagare entro il', 'garanzia fino al', 'data di rinnovo'],
  pt: ['válido até', 'válida até', 'data de validade', 'validade', 'expira em', 'data de vencimento', 'vence em', 'consumir de preferência antes de', 'consumir antes de', 'data limite', 'pagar até', 'garantia até', 'data de expiração', 'data de término'],
  pl: ['ważny do', 'ważne do', 'ważna do', 'data ważności', 'termin ważności', 'najlepiej spożyć przed', 'należy spożyć do', 'termin płatności', 'płatne do', 'data wygaśnięcia', 'wygasa', 'gwarancja do', 'data zakończenia'],
  cs: ['platnost do', 'platí do', 'platný do', 'datum platnosti', 'spotřebujte do', 'minimální trvanlivost do', 'datum splatnosti', 'splatnost', 'záruka do', 'datum ukončení', 'platnost končí'],
  sk: ['platnosť do', 'platný do', 'dátum platnosti', 'spotrebujte do', 'minimálna trvanlivosť do', 'dátum splatnosti', 'splatnosť'],
  sl: ['veljavno do', 'velja do', 'rok uporabe', 'uporabno najmanj do', 'porabiti do', 'datum zapadlosti', 'rok plačila', 'garancija do'],
  hr: ['vrijedi do', 'važi do', 'važeće do', 'rok valjanosti', 'upotrijebiti do', 'najbolje upotrijebiti do', 'datum isteka', 'ističe', 'rok plaćanja', 'dospijeće', 'jamstvo do'],
  hu: ['érvényes', 'lejárat', 'lejárati idő', 'lejárati dátum', 'minőségét megőrzi', 'fogyasztható', 'felhasználható', 'fizetési határidő', 'határidő', 'garancia'],
  ro: ['valabil până la', 'valabilă până la', 'data expirării', 'expiră la', 'a se consuma de preferință înainte de', 'a se consuma înainte de', 'data scadenței', 'scadență', 'termen de plată', 'garanție până la'],
  sv: ['giltig till', 'giltig t.o.m.', 'giltig tom', 'giltigt till', 'utgångsdatum', 'går ut', 'bäst före', 'sista förbrukningsdag', 'förbrukas senast', 'förfallodatum', 'förfallodag', 'betala senast', 'garanti till', 'slutdatum'],
  da: ['gyldig til', 'gyldig indtil', 'udløbsdato', 'udløber', 'bedst før', 'mindst holdbar til', 'sidste anvendelsesdato', 'anvendes senest', 'forfaldsdato', 'betales senest', 'slutdato'],
  no: ['gyldig til og med', 'utløpsdato', 'utløper', 'best før', 'siste forbruksdag', 'forfallsdato', 'betales innen', 'sluttdato'],
  fi: ['voimassa asti', 'viimeinen voimassaolopäivä', 'voimassa', 'vanhenee', 'parasta ennen', 'viimeinen käyttöpäivä', 'eräpäivä', 'maksettava viimeistään', 'päättymispäivä'],
  et: ['kehtib kuni', 'kehtivuse lõpp', 'aegumiskuupäev', 'parim enne', 'kõlblik kuni', 'tasumise tähtaeg', 'maksetähtaeg', 'garantii kuni'],
  lv: ['derīgs līdz', 'derīga līdz', 'derīguma termiņš', 'ieteicams līdz', 'izlietot līdz', 'apmaksas termiņš', 'garantija līdz'],
  lt: ['galioja iki', 'galiojimo pabaiga', 'tinka vartoti iki', 'geriausias iki', 'mokėjimo terminas', 'apmokėti iki', 'garantija iki'],
  tr: ['son kullanma tarihi', 'skt', 'son geçerlilik tarihi', 'geçerlilik tarihi', 'son tüketim tarihi', 'tavsiye edilen tüketim tarihi', 'ttt', 'son ödeme tarihi', 'vade tarihi', 'garanti bitiş'],
  id: ['berlaku hingga', 'berlaku sampai', 'tanggal kedaluwarsa', 'kedaluwarsa', 'baik digunakan sebelum', 'tarikh luput', 'sah sehingga', 'tanggal jatuh tempo', 'jatuh tempo', 'garansi hingga'],
};

/** Words before a period ("valid from 01-01-2026 to 31-12-2026"): the latest date after them counts. */
export const PERIOD_WORDS = {
  en: ['valid from', 'validity period', 'period of validity', 'period of cover', 'coverage period', 'policy period', 'insurance period', 'contract term'],
  nl: ['geldig van', 'geldigheidsduur', 'geldigheid', 'looptijd', 'dekkingsperiode', 'verzekeringsperiode', 'contractduur'],
  de: ['gültig von', 'gültig ab', 'gültigkeitsdauer', 'gültigkeit', 'laufzeit', 'versicherungszeitraum', 'vertragslaufzeit'],
  fr: ['période de validité', 'valable du', 'validité', 'durée du contrat', "période d'assurance"],
  es: ['período de validez', 'periodo de validez', 'vigencia', 'validez', 'válido desde', 'período de cobertura'],
  it: ['periodo di validità', 'valido dal', 'validità', 'periodo di copertura', 'durata del contratto'],
  pt: ['período de validade', 'vigência', 'válido de'],
  pl: ['okres ważności', 'ważny od', 'okres ubezpieczenia'],
  cs: ['doba platnosti', 'platnost od', 'pojistné období'],
  sk: ['obdobie platnosti', 'platnosť od'],
  sv: ['giltighetstid', 'giltig från', 'avtalsperiod'],
  da: ['gyldighedsperiode', 'gyldig fra'],
  no: ['gyldighetsperiode', 'gyldig fra'],
  fi: ['voimassaoloaika', 'vakuutuskausi'],
  hu: ['érvényességi idő'],
  ro: ['perioada de valabilitate', 'valabil de la'],
  tr: ['geçerlilik süresi', 'poliçe süresi'],
  id: ['masa berlaku', 'tempoh sah'],
};

/** Month names and their usual short forms. Croatian "listopad" (October) is left out: in Czech and Polish it is November. */
export const MONTH_WORDS = [
  ['jan', 'january', 'januari', 'januar', 'janvier', 'janv', 'enero', 'ene', 'gennaio', 'gen', 'janeiro', 'styczen', 'stycznia', 'sty', 'leden', 'ledna', 'januara', 'januára', 'sijecanj', 'sijecnja', 'tammikuu', 'tammikuuta', 'tammi', 'jaanuar', 'janvaris', 'janvara', 'sausis', 'sausio', 'ocak', 'ianuarie', 'ian', 'gener', 'január'],
  ['feb', 'february', 'februari', 'februar', 'fevrier', 'fevr', 'fev', 'febrero', 'febbraio', 'fevereiro', 'luty', 'lutego', 'lut', 'unor', 'unora', 'februara', 'februára', 'veljaca', 'veljace', 'helmikuu', 'helmikuuta', 'helmi', 'veebruar', 'februaris', 'vasaris', 'vasario', 'subat', 'februarie', 'febr', 'febrer', 'február'],
  ['mar', 'march', 'maart', 'mrt', 'marz', 'maerz', 'mars', 'marzo', 'marco', 'marzec', 'marca', 'brezen', 'brezna', 'marec', 'ozujak', 'ozujka', 'mart', 'marta', 'maaliskuu', 'maaliskuuta', 'maalis', 'marts', 'kovas', 'kovo', 'maret', 'martie', 'marc', 'március', 'marcius', 'marts'],
  ['apr', 'april', 'avril', 'avr', 'abril', 'abr', 'aprile', 'kwiecien', 'kwietnia', 'kwi', 'duben', 'dubna', 'travanj', 'travnja', 'aprila', 'apríl', 'huhtikuu', 'huhtikuuta', 'huhti', 'aprill', 'aprilis', 'balandis', 'balandzio', 'nisan', 'aprilie', 'április', 'aprilis'],
  ['may', 'mei', 'mai', 'mayo', 'maggio', 'mag', 'maio', 'maj', 'maja', 'kveten', 'kvetna', 'máj', 'mája', 'svibanj', 'svibnja', 'toukokuu', 'toukokuuta', 'touko', 'maijs', 'maija', 'geguze', 'geguzes', 'mayis', 'maig', 'május', 'majus'],
  ['jun', 'june', 'juni', 'juin', 'junio', 'giugno', 'giu', 'junho', 'czerwiec', 'czerwca', 'cze', 'cerven', 'cervna', 'jún', 'júna', 'lipanj', 'lipnja', 'junij', 'junija', 'kesakuu', 'kesakuuta', 'kesa', 'juuni', 'junijs', 'birzelis', 'birzelio', 'haziran', 'iunie', 'iun', 'juny', 'június', 'junius', 'jun'],
  ['jul', 'july', 'juli', 'juillet', 'juil', 'julio', 'luglio', 'lug', 'julho', 'lipiec', 'lipca', 'lip', 'cervenec', 'cervence', 'júl', 'júla', 'srpanj', 'srpnja', 'julij', 'julija', 'heinakuu', 'heinakuuta', 'heina', 'juuli', 'julijs', 'liepa', 'liepos', 'temmuz', 'iulie', 'iul', 'juliol', 'július', 'julius'],
  ['aug', 'august', 'augustus', 'augusti', 'aout', 'agosto', 'ago', 'sierpien', 'sierpnia', 'sie', 'srpen', 'srpna', 'augusta', 'kolovoz', 'kolovoza', 'avgust', 'avgusta', 'elokuu', 'elokuuta', 'elo', 'augusts', 'rugpjutis', 'rugpjucio', 'agustos', 'agustus', 'agost', 'augusztus'],
  ['sep', 'sept', 'september', 'septembre', 'septiembre', 'settembre', 'set', 'setembro', 'wrzesien', 'wrzesnia', 'wrz', 'zari', 'septembra', 'septembar', 'rujan', 'rujna', 'syyskuu', 'syyskuuta', 'syys', 'septembris', 'rugsejis', 'rugsejo', 'eylul', 'septembrie', 'setembre', 'szeptember', 'szept'],
  ['oct', 'october', 'oktober', 'octobre', 'octubre', 'ottobre', 'ott', 'outubro', 'out', 'pazdziernik', 'pazdziernika', 'paz', 'rijen', 'rijna', 'októbra', 'oktobra', 'oktobar', 'lokakuu', 'lokakuuta', 'loka', 'oktoober', 'oktobris', 'spalis', 'spalio', 'ekim', 'octombrie', 'okt', 'október'],
  ['nov', 'november', 'novembre', 'noviembre', 'novembro', 'listopad', 'listopada', 'listopadu', 'lis', 'novembra', 'novembar', 'studeni', 'studenog', 'marraskuu', 'marraskuuta', 'marras', 'novembris', 'lapkritis', 'lapkricio', 'kasim', 'noiembrie', 'noi'],
  ['dec', 'december', 'decembre', 'diciembre', 'dicembre', 'dic', 'dezembro', 'dez', 'dezember', 'grudzien', 'grudnia', 'gru', 'prosinec', 'prosince', 'decembra', 'decembar', 'prosinac', 'prosinca', 'joulukuu', 'joulukuuta', 'joulu', 'detsember', 'decembris', 'gruodis', 'gruodzio', 'aralik', 'desember', 'decembrie', 'desembre'],
];

const EXTRA = { 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ł': 'l', 'đ': 'd', 'ß': 'ss', 'ı': 'i', 'þ': 'th' };
/** Lower case without accents, so "Gültig" and an OCR'd "Gultig" read the same. */
export const fold = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[øæœłđßıþ]/g, (c) => EXTRA[c]);

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const byLength = (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0);
/** The words of all languages, folded, longest first, without repeats. */
export const wordList = (table) => [...new Set(Object.values(table).flat().map(fold))].sort(byLength);
const phrases = (table) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${wordList(table).map((w) => escape(w).replace(/ /g, '\\s+')).join('|')})(?!\\p{L})`, 'gu');
const END = phrases(END_WORDS), PERIOD = phrases(PERIOD_WORDS);

/** Every month word, folded, with its month number. */
export const monthList = () => {
  const map = new Map();
  MONTH_WORDS.forEach((words, i) => words.forEach((w) => { if (!map.has(fold(w))) map.set(fold(w), i + 1); }));
  return [...map].sort((a, b) => byLength(a[0], b[0]));
};
const MONTHS = new Map(monthList());
const M = `(${[...MONTHS.keys()].join('|')})(?!\\p{L})\\.?(?:\\s*/\\s*\\p{L}+\\.?)?`;
// Each date form with the order of its groups: year, month (number or word), day; no day = the month's last day.
const FORMS = [
  [/(?<!\d)(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})(?!\d)/gu, 'ymd'],
  [/(?<!\d)(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4}|\d{2})(?!\d)/gu, 'dmy'],
  [new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th|er|e)?\\.?\\s*(?:de\\s+|d')?${M},?\\s*(?:de\\s+|del\\s+)?(\\d{4})(?!\\d)`, 'gu'), 'dMy'],
  [new RegExp(`(?<!\\p{L})${M}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`, 'gu'), 'Mdy'],
  [new RegExp(`(?<!\\d)(\\d{4})\\.?\\s*(?:m\\.\\s*)?${M}\\s+(\\d{1,2})(?!\\d)`, 'gu'), 'yMd'],
  [new RegExp(`(?<!\\d)(\\d{4})\\.?\\s*gada\\s+(\\d{1,2})\\.?\\s*${M}`, 'gu'), 'ydM'],
  [new RegExp(`(?<!\\p{L})${M}\\s+(\\d{4})(?!\\d)`, 'gu'), 'My'],
  [/(?<![\d/.-])(\d{1,2})\s*\/\s*(\d{4}|\d{2})(?![\d/.-])|(?<![\d/.-])(\d{1,2})\s*[-.]\s*(\d{4})(?![\d/.-])/gu, 'my'],
];
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

function toDay(kind, g) {
  const num = (v) => Number(v);
  const year4 = (v) => (v.length === 2 ? 2000 + num(v) : num(v));
  let year, month, day;
  if (kind === 'ymd') [year, month, day] = [num(g[1]), num(g[2]), num(g[3])];
  else if (kind === 'dmy') {
    const a = num(g[1]), b = num(g[2]);
    year = year4(g[3]);
    [day, month] = b > 12 && a <= 12 ? [b, a] : [a, b];
  } else if (kind === 'dMy') [day, month, year] = [num(g[1]), MONTHS.get(g[2]), num(g[3])];
  else if (kind === 'Mdy') [month, day, year] = [MONTHS.get(g[1]), num(g[2]), num(g[3])];
  else if (kind === 'yMd') [year, month, day] = [num(g[1]), MONTHS.get(g[2]), num(g[3])];
  else if (kind === 'ydM') [year, day, month] = [num(g[1]), num(g[2]), MONTHS.get(g[3])];
  else if (kind === 'My') [month, year] = [MONTHS.get(g[1]), num(g[2])];
  else [month, year] = g[1] ? [num(g[1]), year4(g[2])] : [num(g[3]), num(g[4])];
  if (!(month >= 1 && month <= 12) || year < 1900 || year > 2199) return '';
  if (day === undefined) day = lastDay(year, month);
  const text = `${year}-${pad(month)}-${pad(day)}`;
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.toISOString().slice(0, 10) === text ? text : '';
}

/** The dates in folded `text`, in reading order; where two forms overlap, the earlier form in FORMS wins. */
function dates(text) {
  const taken = [];
  for (const [pattern, kind] of FORMS) {
    for (const m of text.matchAll(pattern)) {
      const start = m.index, end = start + m[0].length;
      if (taken.some((t) => start < t.end && t.start < end)) continue;
      const day = toDay(kind, m);
      if (day) taken.push({ start, end, day });
    }
  }
  return taken.sort((a, b) => a.start - b.start).map((t) => t.day);
}

const MRZ_VALUE = (c) => (c === '<' ? 0 : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55);
const mrzCheck = (field, digit) => String([...field].reduce((sum, c, i) => sum + MRZ_VALUE(c) * [7, 3, 1][i % 3], 0) % 10) === digit;
/** The expiry date in a passport (TD3) or ID card (TD1) machine-readable line, checked against its check digit. */
function mrzExpiry(lines) {
  for (const raw of lines) {
    const line = raw.replace(/\s/g, '').toUpperCase();
    let field, digit;
    if (/^[A-Z0-9<]{44}$/.test(line)) [field, digit] = [line.slice(21, 27), line[27]];
    else if (/^[0-9]{6}[0-9<][MF<][0-9]{6}[0-9][A-Z<]{3}[A-Z0-9<]{11}[0-9<]$/.test(line)) [field, digit] = [line.slice(8, 14), line[14]];
    else continue;
    if (!/^\d{6}$/.test(field) || !mrzCheck(field, digit)) continue;
    const day = toDay('ymd', [null, `20${field.slice(0, 2)}`, field.slice(2, 4), field.slice(4, 6)]);
    if (day) return day;
  }
  return '';
}

/**
 * The expiry date offered after a scan: from a passport or ID card line, else the latest date
 * that follows words that end something ("valid until", "THT", "due date") or close a period.
 */
export function findExpiry(text) {
  const raw = String(text ?? '').split(/\r?\n/);
  const mrz = mrzExpiry(raw);
  if (mrz) return mrz;
  const lines = raw.map(fold);
  let best = '';
  lines.forEach((line, i) => {
    for (const [pattern, period] of [[END, false], [PERIOD, true]]) {
      for (const hit of line.matchAll(pattern)) {
        let found = dates(line.slice(hit.index + hit[0].length));
        if (!found.length) found = dates(lines[i + 1] || '');
        const day = period ? found.reduce((a, b) => (b > a ? b : a), '') : found[0] || '';
        if (day > best) best = day;
      }
    }
  });
  return best;
}
