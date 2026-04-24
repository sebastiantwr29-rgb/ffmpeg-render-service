FROM node:20-alpine

# Install FFmpeg + fonts
RUN apk add --no-cache ffmpeg ttf-dejavu

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY server.js .

RUN mkdir -p /tmp/renders

EXPOSE 3000

CMD ["node", "server.js"]
