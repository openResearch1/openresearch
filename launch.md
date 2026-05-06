# 后端服务器（在一个终端）

cd /home/zj45/openresearch/packages/opencode && \
bun run --conditions=browser ./src/index.ts serve --port 4096

# 前端开发服务器（在另一个终端）

cd /home/zj45/openresearch/packages/app && \
bun dev -- --port 4444

# 启动后：

- 后端 API: http://localhost:4096
- 前端 UI: http://localhost:4444
