// L0 deterministic dispatcher: the commands people actually type most often
// are recognised by patterns and executed without the model. That keeps the
// answer instant even while the phone is busy, and the LLM only handles free
// text. Each rule returns { tool, args } or { reply, quick }.

const { cityParts, zonedToUtc, DEFAULT_TZ } = require("../time");

const orderIdIn = (text) => {
  const match = text.match(/#\s*([0-9a-f]{4,24})\b/i);
  return match ? match[1] : undefined;
};

const stripPoliteness = (value) =>
  String(value ?? "")
    .replace(/\s+(пожалуйста|плиз|срочно|быстрее|давай|давайте|мне).*$/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();

const extractRoute = (text) => {
  const match = String(text).match(/(?:^|\s)(от|из|с)\s+(.+?)\s+(до|в)\s+(.+)/i);
  if (match) {
    const from = stripPoliteness(match[2]);
    const to = stripPoliteness(match[4]);
    // Keep the original prepositions: "из Слюдянки в Иркутск" must not turn
    // into "от Слюдянки до Иркутск"
    if (from.length >= 2 && to.length >= 2) return `${match[1]} ${from} ${match[3]} ${to}`;
  }
  const arrow = String(text).match(/(.+?)\s*(?:→|->|—>)\s*(.+)/);
  if (arrow) {
    const from = stripPoliteness(arrow[1].replace(/^(нужна|нужно|хочу|закажи|закажите|вызови|вызовите|машина|такси)\s+/i, ""));
    const to = stripPoliteness(arrow[2]);
    if (from.length >= 2 && to.length >= 2) return `${from} → ${to}`;
  }
  // An address pair without a leading preposition: "Ленина 10 до Пушкина 8".
  // Both halves must carry a house number, so "до центра" is never mistaken
  // for the second address.
  const pair = String(text).match(
    /(?:^|\s)([А-ЯЁA-Z][^,]*?\d[^,]*?)\s+(?:до|в)\s+([А-ЯЁA-Z][^,]*?\d[^,]*)\s*$/i
  );
  if (pair) {
    const from = stripPoliteness(pair[1]);
    const to = stripPoliteness(pair[2]);
    if (
      from.length >= 4 &&
      to.length >= 4 &&
      /[А-ЯЁA-Z]{3}/i.test(from) &&
      /[А-ЯЁA-Z]{3}/i.test(to)
    )
      return `от ${from} до ${to}`;
  }
  return null;
};

const extractPrice = (text) => {
  const match =
    String(text).match(/(\d{2,6})\s*(?:₽|руб|рублей|р(?![а-яё]))/i) ??
    String(text).match(/за\s+(\d{2,6})(?!\d)/i);
  return match ? `${match[1]} ₽` : null;
};

const extractEta = (text) => {
  const match = String(text).match(/(?:через\s+)?(\d{1,3})\s*мин/i);
  return match ? Number(match[1]) : null;
};

const extractIndex = (text) => {
  if (/втор/i.test(text)) return 2;
  if (/трет/i.test(text)) return 3;
  if (/четверт/i.test(text)) return 4;
  return 1;
};

// --- booking (a ride in advance) -------------------------------------------
// "Завтра в 8:30" is the city's wall clock, not the server's: Irkutsk is eight
// hours ahead of UTC and five ahead of Moscow, so every calculation goes
// through the city timezone (services/time.js).

const hasBookingIntent = (text) => {
  const value = String(text ?? "");
  if (/(забронир|предзаказ|бронь|брони)/i.test(value)) return true;
  if (/(завтра|послезавтра)/i.test(value)) return true;
  if (/через\s+\d{1,2}\s*(?:минут|мин|час|часа|часов|ч)/i.test(value)) return true;
  if (/(?:^|[^\d])(?:в|к|на)\s*\d{1,2}(?::\d{2})?\s*(?:часов|часа|час|ч|утра|дня|вечера|ночи)/i.test(value))
    return true;
  return /(?:^|[^\d])\d{1,2}:\d{2}(?!\d)/.test(value);
};

const PERIOD_HOUR = { утра: 0, ночи: 0, дня: 12, вечера: 12 };

// "завтра в 8:30", "сегодня к 18:00", "через 2 часа", "06.11 в 9"
const parseWhen = (text, { now = new Date(), tz = DEFAULT_TZ } = {}) => {
  const value = String(text ?? "");

  const relative = value.match(/через\s+(\d{1,2})\s*(минут(?:у|ы)?|мин|час(?:а|ов)?|ч)/i);
  if (relative) {
    const amount = Number(relative[1]);
    const minutes = /мин/i.test(relative[2]) ? amount : amount * 60;
    return { at: new Date(now.getTime() + minutes * 60_000) };
  }

  let dayOffset = null;
  if (/послезавтра/i.test(value)) dayOffset = 2;
  else if (/завтра/i.test(value)) dayOffset = 1;
  else if (/сегодня/i.test(value)) dayOffset = 0;

  let hour = null;
  let minute = 0;
  const withPreposition = value.match(
    /(?:^|[^\d])(?:в|к|на)\s*(\d{1,2})(?::(\d{2}))?(?:\s*(часов|часа|час|ч|утра|дня|вечера|ночи))?(?![а-яё\d])/i
  );
  if (withPreposition) {
    const unit = (withPreposition[3] ?? "").toLowerCase();
    // "на 15 минут" is a duration, not a clock time
    if (withPreposition[2] || unit || dayOffset !== null) {
      hour = Number(withPreposition[1]);
      minute = Number(withPreposition[2] ?? 0);
      if (unit && PERIOD_HOUR[unit] !== undefined && hour < 12) hour += PERIOD_HOUR[unit];
      if (unit === "ночи" && hour === 12) hour = 0;
    }
  }
  if (hour === null) {
    const bare = value.match(/(?:^|[^\d])(\d{1,2}):(\d{2})(?!\d)/);
    if (bare) {
      hour = Number(bare[1]);
      minute = Number(bare[2]);
    }
  }

  if (hour === null || hour > 23 || minute > 59) return { error: "notime" };

  const base = cityParts(now, tz);
  const day = new Date(Date.UTC(base.year, base.month - 1, base.day + (dayOffset ?? 0)));
  const at = zonedToUtc(
    {
      year: day.getUTCFullYear(),
      month: day.getUTCMonth() + 1,
      day: day.getUTCDate(),
      hour,
      minute,
    },
    tz
  );
  if (at.getTime() <= now.getTime() + 60_000) return { error: "past" };
  return { at };
};

// The booking phrase must not leak into the route text: the model once sent
// "от Бронь на завтра 07:00 Пушкина 8 до Ленина 7" as a route.
const BOOKING_WORD = /(?:бронь|бронирование|забронировать|забронируй|заброни|предзаказ)/i;
const DATE_WORD = /(?:завтра|послезавтра|сегодня)/i;

const cleanBookingRoute = (route) => {
  let value = String(route ?? "").trim();

  // A fragment can sit at the start or right after "от/из/с". A bare clock
  // must contain "HH:MM" or a time word ("в 8 утра"): "5-я Советская" is an
  // address, not a time.
  const anchor = (body) => new RegExp(`^(\\s*(?:(?:от|из|с)\\s+)?)${body}[\\s,.:;—-]*`, "i");
  // \b is ASCII-only and never matches after a Cyrillic word, so the
  // lookahead is spelled out explicitly
  const anchors = [
    anchor(`${BOOKING_WORD.source}(?![а-яё])`),
    anchor(`(?:на\\s+)?${DATE_WORD.source}(?![а-яё])`),
    anchor(`(?:на|к|в)\\s*\\d{1,2}(?::\\d{2})?\\s*(?:часов|часа|час|ч|утра|дня|вечера|ночи)(?![а-яё])`),
    anchor(`(?:на|к|в)?\\s*\\d{1,2}:\\d{2}(?![0-9])`),
  ];
  for (let pass = 0; pass < 4; pass += 1) {
    let next = value;
    for (const pattern of anchors) next = next.replace(pattern, "$1");
    next = next.replace(/\s{2,}/g, " ").trim();
    if (next === value) break;
    value = next;
  }

  return value
    .replace(/\s+(?:на\s+)?(?:завтра|послезавтра|сегодня)(?![а-яё])[\s\S]*$/i, "")
    .replace(/\s+через\s+\d{1,2}\s*(?:минут(?:у|ы)?|мин|час(?:а|ов)?|ч)(?![а-яё])[\s\S]*$/i, "")
    .replace(/\s+(?:в|к|на)\s*\d{1,2}(?::\d{2})?\s*(?:часов|часа|час|ч|утра|дня|вечера|ночи)?\s*$/i, "")
    .replace(/[,\s]+$/g, "")
    .trim();
};

const RULES = [
  {
    name: "help",
    test: (text) => /(что ты умеешь|твои возможности|как ты работаешь|^помощь$|^help$)/i.test(text),
    build: () => ({ tool: "help", args: {} }),
  },

  {
    name: "greeting",
    role: "any",
    test: (text) => /^(привет|здравствуй|добрый (день|вечер)|доброе утро|хай|ку)(?=\s|$|[,!?.])/i.test(text.trim()),
    build: () => ({
      reply: "🚕 На связи. Скажите, что нужно: заказ, статус поездки или вопрос по водителю.",
      quick: ["Нужна машина", "Мои заказы", "Помощь"],
    }),
  },

  // --------------------------------------------------------------- passenger
  {
    name: "accept-offer",
    role: "passenger",
    test: (text) => /(прими|принять|выбери|выбрать|подтверди).*(отклик|перв|втор|трет|водител)|^(прими|бери)(?=\s|$)/i.test(text),
    build: (text) => ({ tool: "accept_offer", args: { offerIndex: extractIndex(text) } }),
  },
  {
    name: "passenger-cancel",
    role: "passenger",
    test: (text) => /(отмен|отменить|отмена).*(заказ|поездк)|^отмени(?=\s|$)/i.test(text),
    build: (text) => ({
      tool: "cancel_order",
      args: { ...(orderIdIn(text) && { orderId: orderIdIn(text) }) },
    }),
  },
  {
    name: "passenger-dispute",
    role: "passenger",
    test: (text) => /(спор|жалоб|водитель не приехал|не приехал|нахамил|проблема с поездкой)/i.test(text),
    build: (text) => ({ tool: "open_dispute", args: { reason: stripPoliteness(text) } }),
  },
  {
    name: "passenger-offers",
    role: "passenger",
    test: (text) => /^(отклики|отклик|кто откликнулся|есть отклики|предложения)\??$/i.test(text.trim()),
    build: () => ({ tool: "list_offers", args: {} }),
  },
  {
    name: "passenger-status",
    role: "passenger",
    test: (text) => /(где (моя|мой) (машина|заказ|водитель)|статус|что с заказом|когда приедет|долго ещё|где водитель)/i.test(text),
    build: (text) => ({ tool: "order_status", args: { orderId: orderIdIn(text) } }),
  },
  {
    name: "my-orders",
    role: "any",
    test: (text) => /^(мои|моя)\s+(заказы|поездк|заказ)|^мои заказы$/i.test(text.trim()),
    build: () => ({ tool: "my_orders", args: {} }),
  },
  {
    name: "passenger-booking",
    role: "passenger",
    test: (text) => hasBookingIntent(text),
    build: (text, ctx) => {
      const when = parseWhen(text, { tz: ctx?.city?.tz || DEFAULT_TZ });
      if (when.error === "notime") {
        return {
          reply: extractRoute(text)
            ? "🕒 На какое время бронь? Например: «завтра в 8:30»."
            : "🕒 Куда едем и на какое время? Например: «завтра в 8:30 от вокзала до центра».",
          quick: ["Завтра в 8:30", "Сегодня в 18:00"],
        };
      }
      if (when.error === "past") {
        return {
          reply: "⌛ Это время уже прошло. Назовите будущее время, например «завтра в 8:30».",
          quick: ["Завтра в 8:30", "Через час"],
        };
      }
      const route = cleanBookingRoute(extractRoute(text));
      if (!route) {
        return {
          reply: "🚕 Время понял. Куда едем? Напишите маршрут: «от вокзала до центра».",
          quick: ["От вокзала до центра"],
        };
      }
      const paxMatch = text.match(/(\d)\s*(?:чел|пассажир|человек)/i);
      return {
        tool: "create_order",
        args: {
          route,
          whenAt: when.at.toISOString(),
          ...(paxMatch && { pax: Number(paxMatch[1]) }),
        },
      };
    },
  },
  {
    name: "passenger-new-order",
    role: "passenger",
    test: (text) =>
      !hasBookingIntent(text) &&
      (/(нужна|нужно|хочу|закажи|закажите|вызови|вызовите|машину|такси|отвези|отвезти)/i.test(text) ||
        Boolean(extractRoute(text))),
    build: (text) => {
      const route = extractRoute(text);
      if (!route) {
        return {
          reply: "📍 Куда едем? Напишите маршрут одной строкой: «от вокзала до центра».",
          quick: ["От вокзала до центра", "Нужна машина сейчас"],
        };
      }
      const paxMatch = text.match(/(\d)\s*(?:чел|пассажир|человек)/i);
      return {
        tool: "create_order",
        args: { route, ...(paxMatch && { pax: Number(paxMatch[1]) }) },
      };
    },
  },

  // ------------------------------------------------------------------ driver
  {
    name: "shift-back",
    role: "driver",
    test: (text) => /(вернуться на линию|подтверждаю возврат|выйти обратно|снова на линии)/i.test(text),
    build: () => ({ tool: "driver_shift", args: { shift: "online", confirmBack: true } }),
  },
  {
    name: "shift-offline",
    role: "driver",
    test: (text) => /(уйти с линии|с линии|закончить смену|завершить смену|со смены|не работаю|ухожу)/i.test(text),
    build: () => ({ tool: "driver_shift", args: { shift: "offline" } }),
  },
  {
    name: "shift-online",
    role: "driver",
    test: (text) => /(на линию|на смену|выйти на смену|начать смену|^на линии$|я на линии|работаю)/i.test(text),
    build: () => ({ tool: "driver_shift", args: { shift: "online" } }),
  },
  {
    name: "order-action",
    role: "driver",
    test: (text) =>
      /(выехал|выехала|еду к вам|уже еду|на месте|жду у подъезда|жду вас|поехали|начали поездку|в пути|завершил|закончил поездку|приехали|пассажир не вышел|отмени начало|ещё не началась|еще не началась)/i.test(text),
    build: (text) => {
      const orderId = orderIdIn(text);
      const action = /пассажир не вышел|не вышел/i.test(text)
        ? "no_show"
        : /отмени начало|ещё не началась|еще не началась/i.test(text)
          ? "undo_start"
          : /завершил|закончил поездку|приехали/i.test(text)
            ? "finish"
            : /поехали|начали поездку|в пути/i.test(text)
              ? "start"
              : /на месте|жду у подъезда|жду вас/i.test(text)
                ? "wait"
                : "arrive";
      return { tool: "order_action", args: { action, ...(orderId && { orderId }) } };
    },
  },
  {
    name: "driver-price",
    role: "driver",
    test: (text) => /^\s*\d{2,6}\s*(?:₽|руб|рублей|р(?![а-яё]))[,\s]+(?:через\s+)?\d{1,3}\s*мин/i.test(text),
    build: (text) => ({
      tool: "send_offer",
      args: {
        priceText: extractPrice(text),
        etaMin: extractEta(text) ?? 10,
        orderIndex: 1,
      },
    }),
  },
  {
    name: "driver-offer",
    role: "driver",
    test: (text) => /(отклик|откликнусь|предлагаю|предложу|готов взять|свободен|свободна)/i.test(text),
    build: (text) => {
      const price = extractPrice(text);
      if (!price) {
        return {
          reply: "💰 Сколько назвать и через сколько минут подача?",
          quick: ["300 ₽, 5 минут", "500 ₽, 10 минут"],
        };
      }
      const orderId = orderIdIn(text);
      return {
        tool: "send_offer",
        args: {
          priceText: price,
          etaMin: extractEta(text) ?? 10,
          orderIndex: extractIndex(text),
          ...(orderId && { orderId }),
        },
      };
    },
  },
  {
    name: "take-order",
    role: "driver",
    test: (text) => /(возьму|беру|взять|забираю).*(заказ|перв|втор|трет)|^(возьму|беру)(?=\s|$)/i.test(text),
    build: (text) => ({
      tool: "take_order",
      args: {
        orderIndex: extractIndex(text),
        ...(orderIdIn(text) && { orderId: orderIdIn(text) }),
      },
    }),
  },
  {
    name: "available-orders",
    role: "driver",
    test: (text) => /(доступные заказы|какие заказы|есть заказы|свободные заказы|что есть)/i.test(text),
    build: () => ({ tool: "available_orders", args: {} }),
  },
  {
    name: "driver-status",
    role: "driver",
    test: (text) => /(мой заказ|где заказ|статус|что с заказом|куда ехать)/i.test(text),
    build: (text) => ({ tool: "order_status", args: { orderId: orderIdIn(text) } }),
  },
  {
    name: "driver-cancel",
    role: "driver",
    test: (text) => /(отмен|отменить|отмена).*(заказ|поездк)/i.test(text),
    build: (text) => ({
      tool: "cancel_order",
      args: { ...(orderIdIn(text) && { orderId: orderIdIn(text) }) },
    }),
  },
  {
    name: "driver-dispute",
    role: "driver",
    test: (text) => /(спор|жалоб|пассажир не вышел|нахамил|проблема с поездкой)/i.test(text),
    build: (text) => ({ tool: "open_dispute", args: { reason: stripPoliteness(text) } }),
  },

  // -------------------------------------------------------------- dispatcher
  {
    name: "resolve-dispute",
    role: "dispatcher",
    test: (text) => /(закрой|закрыть|реши|решить|заверши).*(спор)|поездка состоялась|закрыть спор|отмени спор/i.test(text),
    build: (text) => ({
      tool: "resolve_dispute",
      args: {
        outcome: /отмен|не состоял/i.test(text) ? "cancel" : "complete",
        ...(orderIdIn(text) && { orderId: orderIdIn(text) }),
      },
    }),
  },
  {
    name: "assign-driver",
    role: "dispatcher",
    test: (text) => /(назначь|назначить|отдай)/i.test(text),
    build: (text) => {
      const match = text.match(
        /(?:назначь|назначить|отдай)\s+(?:заказ\s+)?(.+?)(?:\s+(?:на|к)\s+заказ|\s*#|$)/i
      );
      const driver = stripPoliteness(match?.[1] ?? "");
      if (!driver)
        return { reply: "🚗 Какому водителю назначить? Назовите имя.", quick: ["Свободные водители"] };
      return {
        tool: "assign_driver",
        args: { driver, ...(orderIdIn(text) && { orderId: orderIdIn(text) }) },
      };
    },
  },
  {
    name: "offer-to-drivers",
    role: "dispatcher",
    test: (text) => /(предложи|предложить|отправь|скинь).*(заказ|водител)/i.test(text),
    build: (text) => {
      const match = text.match(
        /(?:предложи|предложить|отправь|скинь)\s+(?:заказ\s+)?(.+?)(?:\s+на\s+|\s*#|$)/i
      );
      const drivers = stripPoliteness(match?.[1] ?? "");
      if (!drivers)
        return { reply: "📨 Кому предложить заказ? Назовите водителя.", quick: ["Свободные водители"] };
      return {
        tool: "offer_order",
        args: {
          drivers: [drivers],
          ...(orderIdIn(text) && { orderId: orderIdIn(text) }),
        },
      };
    },
  },
  {
    name: "city-snapshot",
    role: "dispatcher",
    test: (text) => /(обстановка|сводка|как дела в городе|что по городу|ситуация|как обстановка)/i.test(text),
    build: () => ({ tool: "city_snapshot", args: {} }),
  },
  {
    name: "free-drivers",
    role: "dispatcher",
    test: (text) => /(свободные водители|кто на линии|водители на линии|кто свободен)/i.test(text),
    build: () => ({ tool: "list_drivers", args: { onlineOnly: true } }),
  },
  {
    name: "order-queue",
    role: "dispatcher",
    test: (text) => /(очередь|заказы в городе|какие заказы|список заказов|очередь заказов)/i.test(text),
    build: () => ({ tool: "list_orders", args: {} }),
  },
  {
    name: "escalate",
    role: "any",
    test: (text) => /(передай|переключи|позови).*(диспетчер|человек)|нужен человек|позови диспетчера|позвать диспетчера/i.test(text),
    build: (text) => ({
      tool: "escalate",
      args: {
        text: stripPoliteness(text),
        ...(orderIdIn(text) && { orderId: orderIdIn(text) }),
      },
    }),
  },
  {
    name: "dispatcher-cancel",
    role: "dispatcher",
    test: (text) => /(отмен|отменить|отмена).*(заказ|поездк)/i.test(text),
    build: (text) => ({
      tool: "cancel_order",
      args: { ...(orderIdIn(text) && { orderId: orderIdIn(text) }) },
    }),
  },
];

const route = (ctx, text) => {
  const value = String(text ?? "").trim();
  if (!value) return { reply: "📝 Напишите, что нужно сделать.", quick: [] };

  for (const rule of RULES) {
    if (rule.role && rule.role !== "any" && rule.role !== ctx.role) continue;
    if (!rule.test(value)) continue;
    const result = rule.build(value, ctx);
    if (!result) continue;
    return { ...result, intent: rule.name };
  }

  // Any message that names an order id is a status question
  const orderId = orderIdIn(value);
  if (orderId) return { tool: "order_status", args: { orderId }, intent: "order-by-id" };

  return null;
};

module.exports = {
  route,
  extractRoute,
  extractPrice,
  extractEta,
  orderIdIn,
  hasBookingIntent,
  parseWhen,
  cleanBookingRoute,
};
