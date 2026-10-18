FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV HOST=0.0.0.0 PORT=3000 AUTH_DIR=/data/auth
EXPOSE 3000
CMD ["node", "index.js"]
