FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY push-gateway.mjs ./

USER node
EXPOSE 8790
CMD ["node", "push-gateway.mjs"]
