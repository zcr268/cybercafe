FROM node:22-slim

# 国内构建加速
RUN npm config set registry https://registry.npmmirror.com \
    && npm install -g wrangler@4.143.0 \
    && npm cache clean --force

WORKDIR /app/cloud
COPY cloud/ /app/cloud/
COPY deploy/aliyun/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
