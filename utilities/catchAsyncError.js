const ApiError = require("./errors");

// Wraps an async route handler and forwards errors to the error middleware
function catchAsyncError(fn) {
  return function (req, res, next) {
    fn(req, res, next).catch(next);
  };
}

// Builds a zod-validated request body handler; messages come from the schema
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const first = result.error.issues[0];
      return next(
        new ApiError(400, first?.message ?? "Некорректные данные запроса", {
          issues: result.error.issues,
        })
      );
    }
    req.body = result.data;
    next();
  };
}

// Socket.IO does not await listeners: rejected promises must be contained.
function catchSocketError(socket, handler) {
  return (...args) => Promise.resolve()
    .then(() => handler(...args))
    .catch((error) => {
      console.error("Socket handler failed:", error.message ?? error);
      const response = { error: "Не удалось обработать запрос чата" };
      const ack = args[args.length - 1];
      if (typeof ack === "function") ack(response);
      else socket.emit("chat:error", response);
    });
}

module.exports = catchAsyncError;
module.exports.validateBody = validateBody;
module.exports.catchSocketError = catchSocketError;
