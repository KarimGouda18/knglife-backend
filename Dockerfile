# Dockerfile
# path: Dockerfile

FROM node:24-alpine

WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
CMD ["npm", "start"]
