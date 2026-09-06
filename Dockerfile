# Official Puppeteer image with Node.js and Google Chrome pre-installed
FROM ghcr.io/puppeteer/puppeteer:22

USER root

WORKDIR /app

# Copy dependency files and postinstall patch script
COPY package*.json patch-wwebjs.js ./

# Install production dependencies and trigger postinstall patch
RUN npm ci --omit=dev || npm install --omit=dev

# Copy application source code
COPY . .

# Set permissions for the application folder
RUN chown -R pptruser:pptruser /app

USER pptruser

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
