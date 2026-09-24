FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8088

CMD ["node", "server.js"]
