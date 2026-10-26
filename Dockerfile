# TaxiChat: API + sockets + Agenda + prebuilt client in one container
# Build:  docker build -t taxichat .
# Run:    see docker-compose.yml (mongo + coturn + app) or any Node host

# ---- Stage 1: build the CRA client ----
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
ARG REACT_APP_CLOUDINARY_NAME
ENV REACT_APP_CLOUDINARY_NAME=$REACT_APP_CLOUDINARY_NAME
RUN npm run build

# ---- Stage 2: runtime ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY index.js server.js app.js socket.js jest.config.js ./
COPY controllers ./controllers
COPY routers ./routers
COPY models ./models
COPY services ./services
COPY utilities ./utilities
COPY socketControllers ./socketControllers
COPY jobs ./jobs
COPY data ./data
COPY scripts ./scripts
COPY --from=client-build /app/client/build ./client/build

# A container has no proxy of its own, so the app answers on every interface
ENV HOST=0.0.0.0
EXPOSE 4000
CMD ["node", "index.js"]
