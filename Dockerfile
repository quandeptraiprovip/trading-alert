# ---- Builder: bundle TS -> 1 file JS/đầu vào bằng esbuild ----
# Bot + chart chỉ dùng axios + dotenv (đã nhúng vào bundle). KHÔNG cần next/react/ts-node.
FROM node:20-alpine AS builder
WORKDIR /src
COPY package.json ./
# Chỉ cài thứ cần để BUNDLE — bỏ qua next/react/react-dom (web UI không chạy trong container).
RUN npm install --no-save --no-package-lock axios@1 dotenv@16 esbuild@0.24
COPY . .
# BUILD_ID = hash toàn bộ source .ts + thời điểm build, nhúng vào bundle qua --define (xem build-info.ts).
# Fingerprint luật chỉ chứng minh LUẬT nào đang chạy; cái này chứng minh CODE nào đang chạy — cần cả hai,
# vì thay đổi code không đụng tham số luật sẽ để fingerprint y nguyên.
# Dùng hash SOURCE thay vì git SHA: `.git` bị loại khỏi build context (.dockerignore) và hash source còn
# đúng hơn — nó phản ánh code thật đã build, kể cả thay đổi chưa commit.
RUN set -eu; \
    BUILD_ID="$(find . -type f -name '*.ts' -not -path './node_modules/*' | LC_ALL=C sort | xargs cat | sha256sum | cut -c1-7)"; \
    BUILD_TIME="$(date -u +%Y-%m-%dT%H:%MZ)"; \
    echo "BUILD_ID=$BUILD_ID BUILD_TIME=$BUILD_TIME"; \
    npx esbuild btc-alert-bot.ts   --bundle --platform=node --target=node20 --format=cjs --define:__BUILD_ID__="\"$BUILD_ID\"" --define:__BUILD_TIME__="\"$BUILD_TIME\"" --outfile=dist/bot.js; \
    npx esbuild chart-server.ts     --bundle --platform=node --target=node20 --format=cjs --define:__BUILD_ID__="\"$BUILD_ID\"" --define:__BUILD_TIME__="\"$BUILD_TIME\"" --outfile=dist/chart.js; \
    npx esbuild dashboard-server.ts --bundle --platform=node --target=node20 --format=cjs --define:__BUILD_ID__="\"$BUILD_ID\"" --define:__BUILD_TIME__="\"$BUILD_TIME\"" --outfile=dist/dashboard.js

# ---- Runtime: chỉ node + 2 file JS + public (không node_modules) ----
FROM node:20-alpine
RUN apk add --no-cache tzdata
ENV TZ=Asia/Ho_Chi_Minh \
    NODE_ENV=production
WORKDIR /app
COPY --from=builder /src/dist/ ./
COPY --from=builder /src/public/ ./public/

# Chart server 3847 · dashboard giao dịch 3848 (bot không cần cổng nào).
EXPOSE 3847 3848

# Mặc định chạy bot alert; chart override bằng `command: node chart.js`.
CMD ["node", "bot.js"]
