FROM node:22-slim

RUN sed -i "s|deb.debian.org|mirrors.aliyun.com|g" /etc/apt/sources.list.d/debian.sources && apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

# W0 服务化（t18）：cloud/server.js 纯 Node 实现（静态 UI + 全部 API 自托管），
# 零外部依赖（仅 node 内置模块 + src/index.js 本地 ESM 导入），
# 无需 wrangler 全局安装 / npm install——删除原 npm install -g wrangler 步骤。
WORKDIR /app/cloud
COPY cloud/ /app/cloud/
COPY deploy/aliyun/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && rm -rf /app/cloud/.wrangler /app/cloud/.dev.vars   # 本地沙箱残留（KV sqlite / dev secret）不进镜像

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
