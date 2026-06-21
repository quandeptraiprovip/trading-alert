# ---- Builder: bundle TS -> 1 file JS/đầu vào bằng esbuild ----
# Bot + chart chỉ dùng axios + dotenv (đã nhúng vào bundle). KHÔNG cần next/react/ts-node.
FROM node:20-alpine AS builder
WORKDIR /src
COPY package.json ./
# Chỉ cài thứ cần để BUNDLE — bỏ qua next/react/react-dom (web UI không chạy trong container).
RUN npm install --no-save --no-package-lock axios@1 dotenv@16 esbuild@0.24
COPY . .
RUN npx esbuild btc-alert-bot.ts --bundle --platform=node --target=node20 --format=cjs --outfile=dist/bot.js \
 && npx esbuild chart-server.ts  --bundle --platform=node --target=node20 --format=cjs --outfile=dist/chart.js

# ---- Runtime: chỉ node + 2 file JS + public (không node_modules) ----
FROM node:20-alpine
RUN apk add --no-cache tzdata
ENV TZ=Asia/Ho_Chi_Minh \
    NODE_ENV=production
WORKDIR /app
COPY --from=builder /src/dist/ ./
COPY --from=builder /src/public/ ./public/

# Chart server lắng nghe 3847 (bot không cần cổng nào).
EXPOSE 3847

# Mặc định chạy bot alert; chart override bằng `command: node chart.js`.
CMD ["node", "bot.js"]
