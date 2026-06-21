# Swing Alert Bot + Chart server — chạy bằng ts-node (không build sang JS).
# Cùng 1 image dùng cho cả 2 process; lệnh chạy do compose/CMD quyết định.
FROM node:20-slim

# tzdata để TZ=Asia/Ho_Chi_Minh hoạt động (giờ VN trong log/alert).
RUN apt-get update \
  && apt-get install -y --no-install-recommends tzdata \
  && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Ho_Chi_Minh \
    NODE_ENV=production

WORKDIR /app

# Cài deps trước (tận dụng cache layer khi chỉ đổi code).
# --include=dev: app chạy trực tiếp bằng ts-node nên ts-node/typescript
# (đang ở devDependencies) là dependency RUNTIME, không được bỏ qua dù NODE_ENV=production.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Copy phần code còn lại (.dockerignore loại node_modules, .env*, .git...).
COPY . .

# Chart server lắng nghe 3847 (bot không cần cổng nào).
EXPOSE 3847

# Mặc định chạy bot alert; chart override bằng `command: npm run chart`.
CMD ["npm", "start"]
