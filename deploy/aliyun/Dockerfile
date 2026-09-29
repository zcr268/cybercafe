FROM node:22-slim

RUN sed -i "s|deb.debian.org|mirrors.aliyun.com|g" /etc/apt/sources.list.d/debian.sources && apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

# 国内构建加速
RUN npm config set registry https://registry.npmmirror.com \
    && npm install -g wrangler@4.142.0 \
    && npm cache clean --force

WORKDIR /app/cloud
COPY cloud/ /app/cloud/
COPY deploy/aliyun/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
