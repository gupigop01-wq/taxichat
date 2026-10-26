// Region -> IANA zone for Russia. A city may override its own `tz` (a republic
// like Yakutia spans several zones), but the region map is the sane default for
// imports and for cities added from the registration screen. Without it every
// city outside Moscow silently lived on Moscow time.

const REGION_TZ = {
  // UTC+2
  "Калининградская область": "Europe/Kaliningrad",

  // UTC+3
  "Москва": "Europe/Moscow",
  "Московская область": "Europe/Moscow",
  "Санкт-Петербург": "Europe/Moscow",
  "Ленинградская область": "Europe/Moscow",
  "Республика Адыгея": "Europe/Moscow",
  "Адыгея": "Europe/Moscow",
  "Республика Карелия": "Europe/Moscow",
  "Карелия": "Europe/Moscow",
  "Республика Коми": "Europe/Moscow",
  "Коми": "Europe/Moscow",
  "Республика Марий Эл": "Europe/Moscow",
  "Марий Эл": "Europe/Moscow",
  "Республика Мордовия": "Europe/Moscow",
  "Мордовия": "Europe/Moscow",
  "Республика Татарстан": "Europe/Moscow",
  "Татарстан": "Europe/Moscow",
  "Чувашская Республика": "Europe/Moscow",
  "Чувашия": "Europe/Moscow",
  "Республика Башкортостан": "Asia/Yekaterinburg",
  "Башкортостан": "Asia/Yekaterinburg",
  "Республика Дагестан": "Europe/Moscow",
  "Дагестан": "Europe/Moscow",
  "Республика Ингушетия": "Europe/Moscow",
  "Ингушетия": "Europe/Moscow",
  "Кабардино-Балкарская Республика": "Europe/Moscow",
  "Карачаево-Черкесская Республика": "Europe/Moscow",
  "Республика Северная Осетия — Алания": "Europe/Moscow",
  "Чеченская Республика": "Europe/Moscow",
  "Чечня": "Europe/Moscow",
  "Ставропольский край": "Europe/Moscow",
  "Краснодарский край": "Europe/Moscow",
  "Ростовская область": "Europe/Moscow",
  "Республика Калмыкия": "Europe/Moscow",
  "Калмыкия": "Europe/Moscow",
  "Архангельская область": "Europe/Moscow",
  "Вологодская область": "Europe/Moscow",
  "Белгородская область": "Europe/Moscow",
  "Брянская область": "Europe/Moscow",
  "Владимирская область": "Europe/Moscow",
  "Воронежская область": "Europe/Moscow",
  "Ивановская область": "Europe/Moscow",
  "Калужская область": "Europe/Moscow",
  "Костромская область": "Europe/Moscow",
  "Курская область": "Europe/Moscow",
  "Липецкая область": "Europe/Moscow",
  "Орловская область": "Europe/Moscow",
  "Рязанская область": "Europe/Moscow",
  "Смоленская область": "Europe/Moscow",
  "Тамбовская область": "Europe/Moscow",
  "Тверская область": "Europe/Moscow",
  "Тульская область": "Europe/Moscow",
  "Ярославская область": "Europe/Moscow",
  "Ненецкий автономный округ": "Europe/Moscow",
  "Кировская область": "Europe/Kirov",
  "Волгоградская область": "Europe/Volgograd",
  "Республика Крым": "Europe/Simferopol",
  "Крым": "Europe/Simferopol",
  "Севастополь": "Europe/Simferopol",
  "Донецкая Народная Республика": "Europe/Moscow",
  "Луганская Народная Республика": "Europe/Moscow",
  "Запорожская область": "Europe/Moscow",
  "Херсонская область": "Europe/Moscow",

  // UTC+4
  "Самарская область": "Europe/Samara",
  "Удмуртская Республика": "Europe/Samara",
  "Удмуртия": "Europe/Samara",
  "Ульяновская область": "Europe/Ulyanovsk",
  "Саратовская область": "Europe/Saratov",
  "Астраханская область": "Europe/Astrakhan",
  "Пензенская область": "Europe/Moscow",

  // UTC+5
  "Свердловская область": "Asia/Yekaterinburg",
  "Челябинская область": "Asia/Yekaterinburg",
  "Курганская область": "Asia/Yekaterinburg",
  "Оренбургская область": "Asia/Yekaterinburg",
  "Тюменская область": "Asia/Yekaterinburg",
  "Пермский край": "Asia/Yekaterinburg",
  "Ханты-Мансийский автономный округ — Югра": "Asia/Yekaterinburg",
  "Ямало-Ненецкий автономный округ": "Asia/Yekaterinburg",

  // UTC+6
  "Омская область": "Asia/Omsk",

  // UTC+7
  "Новосибирская область": "Asia/Novosibirsk",
  "Томская область": "Asia/Tomsk",
  "Кемеровская область — Кузбасс": "Asia/Novokuznetsk",
  "Кемеровская область": "Asia/Novokuznetsk",
  "Красноярский край": "Asia/Krasnoyarsk",
  "Республика Хакасия": "Asia/Krasnoyarsk",
  "Хакасия": "Asia/Krasnoyarsk",
  "Республика Тыва": "Asia/Krasnoyarsk",
  "Тыва": "Asia/Krasnoyarsk",
  "Алтайский край": "Asia/Barnaul",
  "Республика Алтай": "Asia/Barnaul",

  // UTC+8
  "Иркутская область": "Asia/Irkutsk",
  "Республика Бурятия": "Asia/Irkutsk",
  "Бурятия": "Asia/Irkutsk",

  // UTC+9
  "Забайкальский край": "Asia/Chita",
  "Республика Саха (Якутия)": "Asia/Yakutsk",
  "Республика Саха": "Asia/Yakutsk",
  "Якутия": "Asia/Yakutsk",
  "Амурская область": "Asia/Yakutsk",

  // UTC+10
  "Приморский край": "Asia/Vladivostok",
  "Хабаровский край": "Asia/Vladivostok",
  "Еврейская автономная область": "Asia/Vladivostok",

  // UTC+11
  "Магаданская область": "Asia/Magadan",
  "Сахалинская область": "Asia/Sakhalin",

  // UTC+12
  "Камчатский край": "Asia/Kamchatka",
  "Чукотский автономный округ": "Asia/Anadyr",
};

// "Иркутская область", "иркутская", "Республика Бурятия" and "бурятия" must
// all land on the same key.
const normalizeRegion = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[—–-]/g, " ")
    // ASCII \b does not see Cyrillic as word characters, so the boundaries here
    // are explicit lookarounds
    .replace(/(?<![а-я])(республика|область|край|автономный|автономная|округ|город|г)(?![а-я])/g, " ")
    .replace(/[^a-zа-я0-9() ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const TZ_BY_REGION = new Map(
  Object.entries(REGION_TZ).map(([name, tz]) => [normalizeRegion(name), tz])
);

const tzForRegion = (name) => TZ_BY_REGION.get(normalizeRegion(name)) ?? null;

module.exports = { REGION_TZ, normalizeRegion, tzForRegion };
