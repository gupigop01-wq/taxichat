const Order = require("../../models/Order");
const Membership = require("../../models/Membership");
const DriverProfile = require("../../models/DriverProfile");
const ApiError = require("../../utilities/errors");
const { getConfig } = require("./config");
const { chatJson, parseJson, LlmError } = require("./llmClient");
const { buildMessages } = require("./prompt");
const { getTool } = require("./tools");
const router = require("./router");
const { ACTIVE_STATUSES } = require("./labels");

// Orchestrator of one dispatcher turn:
//   1. deterministic router — instant commands, no model
//   2. LLM with a compact prompt — free text and complex phrasing
//   3. tool execution — zod + role + state machine, confirmations for danger
// The model never touches Mongo directly, only through tools.

const FALLBACK = {
  passenger:
    "🤔 Не понял. Скажите «нужна машина от вокзала до центра», «мои заказы» или «отменить заказ».",
  driver:
    "🤔 Не понял. Скажите «на линии», «доступные заказы» или «выехал».",
  dispatcher:
    "🤔 Не понял. Скажите «обстановка», «свободные водители» или «назначь Ивана».",
};

const DEFAULT_QUICK = {
  passenger: ["Нужна машина", "Мои заказы", "Помощь"],
  driver: ["На линии", "Доступные заказы", "Мои заказы"],
  dispatcher: ["Обстановка", "Свободные водители", "Очередь заказов"],
};

const zodMessage = (error) =>
  error?.issues?.length ? error.issues[0].message : error.message;

const normalizeQuick = (value) =>
  Array.isArray(value)
    ? value
        .filter((item) => typeof item === "string" && item.trim())
        .slice(0, 3)
        .map((item) => item.trim().slice(0, 40))
    : [];

const toResult = (result) => ({
  text: String(result.text ?? "").trim() || "✅ Готово.",
  quick: normalizeQuick(result.quick),
  ...(result.orderId && { orderId: String(result.orderId) }),
  ...(result.confirm && { confirm: result.confirm }),
});

const executeTool = async (ctx, name, rawArgs = {}) => {
  const tool = getTool(name, ctx.role);
  if (!tool) throw new ApiError(400, "Так я не умею");

  let args;
  try {
    args = tool.schema.parse(rawArgs ?? {});
  } catch (error) {
    throw new ApiError(400, zodMessage(error));
  }

  if (tool.confirm) {
    const preview = tool.preview
      ? await tool.preview(ctx, args)
      : { args, summary: `Выполнить «${name}»` };
    ctx.session.pending = {
      tool: name,
      args: preview.args ?? args,
      summary: preview.summary,
      createdAt: new Date(),
    };
    return {
      text: `❓ ${preview.summary}. Подтверждаете?`,
      quick: [],
      confirm: { tool: name, summary: preview.summary },
    };
  }

  return tool.run(ctx, args);
};

// Executes the action stored by a confirmable tool, or drops it
const confirmPending = async (ctx, approve) => {
  const pending = ctx.session.pending;
  if (!pending) throw new ApiError(400, "Нет действия, ожидающего подтверждения");

  // Clear first: a double tap must never run the action twice
  ctx.session.pending = null;
  if (!approve) {
    return { text: "👌 Хорошо, отменил. Ничего не меняю.", quick: DEFAULT_QUICK[ctx.role] };
  }

  const tool = getTool(pending.tool, ctx.role);
  if (!tool) throw new ApiError(400, "Действие больше недоступно");
  const result = await tool.run(ctx, pending.args ?? {});
  return toResult(result);
};

const buildState = async (ctx) => {
  const filter = { cityId: ctx.cityId, status: { $in: ACTIVE_STATUSES } };
  if (ctx.role === "passenger") filter.passengerId = ctx.user._id;
  if (ctx.role === "driver") filter.driverId = ctx.user._id;

  const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(3);
  const lastOrder = ctx.session.lastOrderId
    ? await Order.findById(ctx.session.lastOrderId)
    : null;

  let driverProfile = null;
  if (ctx.role === "driver") {
    const membership = await Membership.findOne({
      userId: ctx.user._id,
      cityId: ctx.cityId,
      role: "driver",
      status: "ACTIVE",
    }).select("_id");
    if (membership) {
      driverProfile = await DriverProfile.findOne({ membershipId: membership._id }).lean();
    }
  }

  return {
    cityName: ctx.city?.name,
    cityTz: ctx.city?.tz,
    userName: ctx.user?.name,
    orders,
    lastOrder,
    driverProfile,
    pending: ctx.session.pending,
  };
};

const runModel = async (ctx, text) => {
  const config = getConfig();
  if (config.disabled || !config.configured)
    return { text: FALLBACK[ctx.role], quick: DEFAULT_QUICK[ctx.role], degraded: true };

  const state = await buildState(ctx);
  const messages = buildMessages({
    role: ctx.role,
    compact: config.name === "local",
    context: state,
    recent: ctx.session.recent ?? [],
    text,
  });

  let response;
  try {
    response = await chatJson({ messages });
  } catch (error) {
    if (error instanceof LlmError) {
      const busy =
        error.code === "LLM_TIMEOUT" ||
        error.code === "LLM_BUSY" ||
        error.code === "LLM_COOLDOWN" ||
        error.code === "LLM_RATE_LIMIT";
      return {
        text: busy
          ? "⏳ Секунду, диспетчер перегружен. Повторите, пожалуйста."
          : "⚠️ Не могу связаться с моделью. Скажите проще: «мои заказы», «нужна машина», «отменить заказ».",
        quick: DEFAULT_QUICK[ctx.role],
        degraded: true,
      };
    }
    throw error;
  }

  const parsed = parseJson(response.text);
  if (!parsed) {
    // The model ignored the JSON protocol but still said something useful
    const clean = String(response.text ?? "").replace(/```[\s\S]*?```/g, "").trim();
    if (clean && !clean.startsWith("{")) {
      return { text: clean.slice(0, 500), quick: DEFAULT_QUICK[ctx.role] };
    }
    return { text: FALLBACK[ctx.role], quick: DEFAULT_QUICK[ctx.role] };
  }

  const quick = normalizeQuick(parsed.quick);
  const toolName =
    parsed.tool && String(parsed.tool).toLowerCase() !== "null"
      ? String(parsed.tool)
      : null;

  if (toolName) {
    try {
      const result = await executeTool(ctx, toolName, parsed.args ?? {});
      const output = toResult(result);
      return {
        ...output,
        quick: output.quick.length > 0 ? output.quick : quick,
      };
    } catch (error) {
      return {
        text: error.message,
        quick: quick.length > 0 ? quick : DEFAULT_QUICK[ctx.role],
      };
    }
  }

  const reply = String(parsed.reply ?? "").trim();
  if (!reply) return { text: FALLBACK[ctx.role], quick: DEFAULT_QUICK[ctx.role] };
  return { text: reply.slice(0, 500), quick };
};

const CONFIRM_YES = /^(да|ага|подтверждаю|подтвердить|верно|ок|окей|хорошо|yes)\b/i;
const CONFIRM_NO = /^(нет|не надо|не нужно|отмена|отмени|no)\b/i;

const runTurn = async ({ ctx, text }) => {
  const value = String(text ?? "").trim();

  // A typed "да/нет" answers the confirmation card
  if (ctx.session.pending) {
    if (CONFIRM_YES.test(value)) return confirmPending(ctx, true);
    if (CONFIRM_NO.test(value)) return confirmPending(ctx, false);
    // Any other message abandons the pending action
    ctx.session.pending = null;
  }

  let direct = null;
  try {
    direct = router.route(ctx, value);
  } catch {
    direct = null;
  }

  if (direct?.reply) return { text: direct.reply, quick: normalizeQuick(direct.quick) };

  if (direct?.tool) {
    try {
      return toResult(await executeTool(ctx, direct.tool, direct.args));
    } catch (error) {
      return { text: error.message, quick: DEFAULT_QUICK[ctx.role] };
    }
  }

  return runModel(ctx, value);
};

// Short-term memory for the next turn: the last three exchanges only
const remember = (session, userText, replyText) => {
  session.recent = [
    ...(session.recent ?? []),
    { role: "user", text: String(userText).slice(0, 300) },
    { role: "bot", text: String(replyText).slice(0, 300) },
  ].slice(-6);
  session.turns = (session.turns ?? 0) + 1;
  session.lastUserAt = new Date();
};

module.exports = { runTurn, confirmPending, remember, executeTool, DEFAULT_QUICK };
