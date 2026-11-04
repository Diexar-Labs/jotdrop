// Finding the expiry date on a scanned paper: the languages written in the Latin alphabet,
// plus Hindi and Chinese (the scripts Android's text recognition reads). The words below are
// the single source: `npm run build:paper-words` writes them into android/.../ExpiryWords.kt,
// and cloud/shared/fixtures/expiry-cases.tsv holds the cases both platforms must agree on.
// Chinese words have no spaces around them, so they match anywhere; the others only as words.

/**
 * Words before a date that ends something: a validity, a best-before date, a payment, a contract.
 * The first date after the words counts (or on the next line, where scans often put it).
 */
export const END_WORDS = {
  en: ['valid until', 'valid till', 'valid through', 'valid thru', 'valid upto', 'valid up to', 'valid to', 'exp dt', 'expiry dt','good thru', 'good through', 'expiry date', 'expiration date', 'date of expiry', 'expiry', 'expires on', 'expires', 'expiration', 'exp date', 'exp', 'best before end', 'best before', 'best by', 'use by', 'use before', 'due date', 'payment due', 'due by', 'pay by', 'renewal date', 'renews on', 'end date', 'ends on', 'warranty until', 'warranty expires', 'guaranteed until'],
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
  hi: ['समाप्ति तिथि', 'समाप्ति की तिथि', 'समाप्ति की तारीख', 'अंतिम तिथि', 'उपयोग की अंतिम तिथि', 'देय तिथि', 'भुगतान की अंतिम तिथि', 'एक्सपायरी डेट', 'एक्सपायरी तिथि'],
  zh: ['有效期至', '有效期到', '有效期截止', '有效至', '有效日期', '有效期限至', '截止日期', '截至日期', '到期日', '到期日期', '失效日期', '保质期至', '保存期限至', '最佳食用日期', '限用日期', '使用期限', '最后还款日', '还款日', '付款截止日期', '缴费截止日期', '保修期至', '终止日期', '繳費截止日', '付款期限', '最後還款日'],
};

/** Words after a date ("31/12/2030 तक", "2027年6月1日前使用"): the date right before them counts. */
export const BEFORE_WORDS = {
  hi: ['तक', 'से पहले', 'के बाद उपयोग न करें'],
  zh: ['之前', '以前', '前', '到期', '截止', '止'],
};

/** Words before a shelf life ("best before 9 months from mfg", "保质期：12个月"): the made-on date plus that term counts. */
export const SHELF_WORDS = {
  en: ['best before', 'use before', 'use by', 'use within', 'consume within', 'shelf life'],
  hi: ['निर्माण से', 'निर्माण की तिथि से', 'पैकिंग से'],
  zh: ['保质期', '保存期', '保存期限', '保質期'],
};

/** Words before the date a product was made or packed, the start of a shelf life. */
export const MADE_WORDS = {
  en: ['mfg', 'mfd', 'mfg date', 'mfg dt', 'date of manufacture', 'manufactured on', 'manufacturing date', 'mfg/pkd', 'pkd', 'packed on', 'date of packing', 'packing date', 'production date'],
  hi: ['निर्माण तिथि', 'निर्माण की तिथि', 'पैकिंग तिथि', 'उत्पादन तिथि'],
  zh: ['生产日期', '制造日期', '出厂日期', '包装日期', '生產日期', '製造日期'],
};

/** Units of a shelf life after its number: d(ays), w(eeks), m(onths), y(ears). */
export const TERM_UNITS = {
  d: ['days', 'day', 'दिन', '天', '日'],
  w: ['weeks', 'week', 'wks', 'सप्ताह', '周', '星期'],
  m: ['months', 'month', 'mths', 'mth', 'mo', 'महीने', 'महीना', 'माह', '个月', '個月', '月'],
  y: ['years', 'year', 'yrs', 'yr', 'वर्ष', 'साल', '年'],
};

/** Words before a period ("valid from 01-01-2026 to 31-12-2026"): the latest date after them counts. */
export const PERIOD_WORDS = {
  en: ['valid from', 'validity period', 'validity','period of validity', 'period of cover', 'coverage period', 'policy period', 'insurance period', 'contract term'],
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
  hi: ['वैधता अवधि', 'वैधता', 'अवधि'],
  zh: ['有效期限', '有效期', '有效期間', '合同期限', '保险期间', '保险期限', '保險期間', '至'],
};

/** Month names and their usual short forms. Croatian "listopad" (October) is left out: in Czech and Polish it is November. */
export const MONTH_WORDS = [
  ['jan', 'january', 'januari', 'januar', 'janvier', 'janv', 'enero', 'ene', 'gennaio', 'gen', 'janeiro', 'styczen', 'stycznia', 'sty', 'leden', 'ledna', 'januara', 'januára', 'sijecanj', 'sijecnja', 'tammikuu', 'tammikuuta', 'tammi', 'jaanuar', 'janvaris', 'janvara', 'sausis', 'sausio', 'ocak', 'ianuarie', 'ian', 'gener', 'január', 'जनवरी'],
  ['feb', 'february', 'februari', 'februar', 'fevrier', 'fevr', 'fev', 'febrero', 'febbraio', 'fevereiro', 'luty', 'lutego', 'lut', 'unor', 'unora', 'februara', 'februára', 'veljaca', 'veljace', 'helmikuu', 'helmikuuta', 'helmi', 'veebruar', 'februaris', 'vasaris', 'vasario', 'subat', 'februarie', 'febr', 'febrer', 'február', 'फ़रवरी', 'फरवरी'],
  ['mar', 'march', 'maart', 'mrt', 'marz', 'maerz', 'mars', 'marzo', 'marco', 'marzec', 'marca', 'brezen', 'brezna', 'marec', 'ozujak', 'ozujka', 'mart', 'marta', 'maaliskuu', 'maaliskuuta', 'maalis', 'marts', 'kovas', 'kovo', 'maret', 'martie', 'marc', 'március', 'marcius', 'marts', 'मार्च'],
  ['apr', 'april', 'avril', 'avr', 'abril', 'abr', 'aprile', 'kwiecien', 'kwietnia', 'kwi', 'duben', 'dubna', 'travanj', 'travnja', 'aprila', 'apríl', 'huhtikuu', 'huhtikuuta', 'huhti', 'aprill', 'aprilis', 'balandis', 'balandzio', 'nisan', 'aprilie', 'április', 'aprilis', 'अप्रैल'],
  ['may', 'mei', 'mai', 'mayo', 'maggio', 'mag', 'maio', 'maj', 'maja', 'kveten', 'kvetna', 'máj', 'mája', 'svibanj', 'svibnja', 'toukokuu', 'toukokuuta', 'touko', 'maijs', 'maija', 'geguze', 'geguzes', 'mayis', 'maig', 'május', 'majus', 'मई'],
  ['jun', 'june', 'juni', 'juin', 'junio', 'giugno', 'giu', 'junho', 'czerwiec', 'czerwca', 'cze', 'cerven', 'cervna', 'jún', 'júna', 'lipanj', 'lipnja', 'junij', 'junija', 'kesakuu', 'kesakuuta', 'kesa', 'juuni', 'junijs', 'birzelis', 'birzelio', 'haziran', 'iunie', 'iun', 'juny', 'június', 'junius', 'jun', 'जून'],
  ['jul', 'july', 'juli', 'juillet', 'juil', 'julio', 'luglio', 'lug', 'julho', 'lipiec', 'lipca', 'lip', 'cervenec', 'cervence', 'júl', 'júla', 'srpanj', 'srpnja', 'julij', 'julija', 'heinakuu', 'heinakuuta', 'heina', 'juuli', 'julijs', 'liepa', 'liepos', 'temmuz', 'iulie', 'iul', 'juliol', 'július', 'julius', 'जुलाई'],
  ['aug', 'august', 'augustus', 'augusti', 'aout', 'agosto', 'ago', 'sierpien', 'sierpnia', 'sie', 'srpen', 'srpna', 'augusta', 'kolovoz', 'kolovoza', 'avgust', 'avgusta', 'elokuu', 'elokuuta', 'elo', 'augusts', 'rugpjutis', 'rugpjucio', 'agustos', 'agustus', 'agost', 'augusztus', 'अगस्त'],
  ['sep', 'sept', 'september', 'septembre', 'septiembre', 'settembre', 'set', 'setembro', 'wrzesien', 'wrzesnia', 'wrz', 'zari', 'septembra', 'septembar', 'rujan', 'rujna', 'syyskuu', 'syyskuuta', 'syys', 'septembris', 'rugsejis', 'rugsejo', 'eylul', 'septembrie', 'setembre', 'szeptember', 'szept', 'सितंबर', 'सितम्बर'],
  ['oct', 'october', 'oktober', 'octobre', 'octubre', 'ottobre', 'ott', 'outubro', 'out', 'pazdziernik', 'pazdziernika', 'paz', 'rijen', 'rijna', 'októbra', 'oktobra', 'oktobar', 'lokakuu', 'lokakuuta', 'loka', 'oktoober', 'oktobris', 'spalis', 'spalio', 'ekim', 'octombrie', 'okt', 'október', 'अक्टूबर', 'अक्तूबर'],
  ['nov', 'november', 'novembre', 'noviembre', 'novembro', 'listopad', 'listopada', 'listopadu', 'lis', 'novembra', 'novembar', 'studeni', 'studenog', 'marraskuu', 'marraskuuta', 'marras', 'novembris', 'lapkritis', 'lapkricio', 'kasim', 'noiembrie', 'noi', 'नवंबर', 'नवम्बर'],
  ['dec', 'december', 'decembre', 'diciembre', 'dicembre', 'dic', 'dezembro', 'dez', 'dezember', 'grudzien', 'grudnia', 'gru', 'prosinec', 'prosince', 'decembra', 'decembar', 'prosinac', 'prosinca', 'joulukuu', 'joulukuuta', 'joulu', 'detsember', 'decembris', 'gruodis', 'gruodzio', 'aralik', 'desember', 'decembrie', 'desembre', 'दिसंबर', 'दिसम्बर'],
];

const EXTRA = { 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ł': 'l', 'đ': 'd', 'ß': 'ss', 'ı': 'i', 'þ': 'th' };
/**
 * Lower case without Latin accents, so "Gültig" and an OCR'd "Gultig" read the same. Hindi vowel
 * signs stay (only the nukta goes); Devanagari and full-width digits and signs become plain ones.
 */
export const fold = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-़ͯ]/g, '')
  .replace(/[øæœłđßıþ]/g, (c) => EXTRA[c])
  .replace(/[०-९]/g, (c) => String(c.charCodeAt(0) - 0x966))
  .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const byLength = (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0);
/** The words of all languages, folded, longest first, without repeats. */
export const wordList = (table) => [...new Set(Object.values(table).flat().map(fold))].sort(byLength);
const HAN = /\p{Script=Han}/u;
/** The words as one pattern: Chinese anywhere, the others only between non-letters. */
const phrases = (table) => {
  const words = wordList(table).map((w) => escape(w).replace(/ /g, '\\s+'));
  const others = words.filter((w) => !HAN.test(w)), han = words.filter((w) => HAN.test(w));
  return new RegExp([others.length && `(?<![\\p{L}\\p{M}\\p{N}])(?:${others.join('|')})(?![\\p{L}\\p{M}])`, han.length && `(?:${han.join('|')})`].filter(Boolean).join('|'), 'gu');
};
const END = phrases(END_WORDS), PERIOD = phrases(PERIOD_WORDS), BEFORE = phrases(BEFORE_WORDS);
const SHELF = phrases(SHELF_WORDS), MADE = phrases(MADE_WORDS);

/** Every unit word, folded, longest first, with its kind (d, w, m or y). */
export const unitList = () => Object.entries(TERM_UNITS).flatMap(([kind, words]) => words.map((w) => [fold(w), kind])).sort((a, b) => byLength(a[0], b[0]));
const UNITS = new Map(unitList());
/** A shelf life right at the start of the text: "9 months", ": 12个月". */
const TERM = new RegExp(`^[\\s:.-]*(\\d{1,3})\\s*(${[...UNITS.keys()].map((w) => (HAN.test(w) ? escape(w) : `${escape(w)}(?![\\p{L}\\p{M}])`)).join('|')})`, 'u');

/** Every month word, folded, with its month number. */
export const monthList = () => {
  const map = new Map();
  MONTH_WORDS.forEach((words, i) => words.forEach((w) => { if (!map.has(fold(w))) map.set(fold(w), i + 1); }));
  return [...map].sort((a, b) => byLength(a[0], b[0]));
};
const MONTHS = new Map(monthList());
const M = `(${[...MONTHS.keys()].join('|')})(?![\\p{L}\\p{M}])\\.?(?:\\s*/\\s*\\p{L}+\\.?)?`;
// Each date form with the order of its groups: year, month (number or word), day; no day = the month's last day.
const FORMS = [
  [/(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})(?!\d)\s*[日号號]?/gu, 'ymd'],
  [/(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月/gu, 'ym'],
  [/(?<!\d)(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})(?!\d)/gu, 'ymd'],
  [/(?<!\d)(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4}|\d{2})(?!\d)/gu, 'dmy'],
  [new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th|er|e)?\\.?[\\s-]*(?:de\\s+|d')?${M},?[\\s-]*(?:de\\s+|del\\s+)?(\\d{4})(?!\\d)`, 'gu'), 'dMy'],
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
  else if (kind === 'ym') [year, month] = [num(g[1]), num(g[2])];
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

/** The dates in folded `text` with where they stand, in reading order; where two forms overlap, the earlier form in FORMS wins. */
function spans(text) {
  const taken = [];
  for (const [pattern, kind] of FORMS) {
    for (const m of text.matchAll(pattern)) {
      const start = m.index, end = start + m[0].length;
      if (taken.some((t) => start < t.end && t.start < end)) continue;
      const day = toDay(kind, m);
      if (day) taken.push({ start, end, day });
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}
const dates = (text) => spans(text).map((t) => t.day);

/** `day` plus a shelf life of `n` days, weeks, months or years; a month too short keeps its last day. */
function addTerm(day, n, unit) {
  const [y, m, d] = day.split('-').map(Number);
  if (unit === 'd' || unit === 'w') return new Date(Date.UTC(y, m - 1, d + n * (unit === 'w' ? 7 : 1))).toISOString().slice(0, 10);
  const total = m - 1 + n * (unit === 'y' ? 12 : 1);
  const year = y + Math.floor(total / 12), month = (total % 12) + 1;
  return `${year}-${pad(month)}-${pad(Math.min(d, lastDay(year, month)))}`;
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

/** The first date after a word for the day something was made or packed (same line, else the next). */
function madeOn(lines) {
  for (let i = 0; i < lines.length; i++) {
    for (const hit of lines[i].matchAll(MADE)) {
      const found = dates(lines[i].slice(hit.index + hit[0].length));
      if (found.length) return found[0];
      const next = dates(lines[i + 1] || '');
      if (next.length) return next[0];
    }
  }
  return '';
}

/**
 * The expiry date offered after a scan: from a passport or ID card line, else the latest date
 * that follows words that end something ("valid until", "THT", "due date") or close a period,
 * that stands right before words like "तक" or "前", or that a shelf life gives from the made-on date.
 */
export function findExpiry(text) {
  const raw = String(text ?? '').split(/\r?\n/);
  const mrz = mrzExpiry(raw);
  if (mrz) return mrz;
  const lines = raw.map(fold);
  let best = '';
  const offer = (day) => { if (day > best) best = day; };
  lines.forEach((line, i) => {
    for (const [pattern, period] of [[END, false], [PERIOD, true]]) {
      for (const hit of line.matchAll(pattern)) {
        const after = line.slice(hit.index + hit[0].length);
        let found = dates(after);
        // "Best before 9 months from mfg": a shelf life, not a date on the next line.
        if (!found.length && !TERM.test(after)) found = dates(lines[i + 1] || '');
        offer(period ? found.reduce((a, b) => (b > a ? b : a), '') : found[0] || '');
      }
    }
    for (const hit of line.matchAll(BEFORE)) {
      const before = line.slice(0, hit.index).replace(/[\s:,]+$/u, '');
      const last = spans(before).at(-1);
      if (last && last.end === before.length) offer(last.day);
    }
    for (const hit of line.matchAll(SHELF)) {
      const term = TERM.exec(line.slice(hit.index + hit[0].length));
      const made = term && madeOn(lines);
      if (made) offer(addTerm(made, Number(term[1]), UNITS.get(term[2])));
    }
  });
  return best;
}
