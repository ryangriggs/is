FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Create runtime directories
RUN mkdir -p data uploads

EXPOSE 3000

# DNS port is bound inside the container on 5300 (non-privileged)
# docker-compose maps host :53/udp → container :5300/udp
EXPOSE 5300/udp

CMD ["node", "--experimental-sqlite", "src/server.js"]
