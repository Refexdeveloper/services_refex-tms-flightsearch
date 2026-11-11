FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production
# Travolution host (www.etravelvalue.biz) currently omits its Sectigo intermediate
# from the TLS handshake. Node fetch cannot AIA-fetch it, so trust it explicitly.
ENV NODE_EXTRA_CA_CERTS=/app/certs/sectigo-public-server-authentication-ca-dv-r36.pem

COPY package*.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY server ./server
COPY certs ./certs

EXPOSE 8080

CMD ["npm", "start"]
