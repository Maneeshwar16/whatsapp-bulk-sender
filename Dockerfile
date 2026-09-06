# Official Puppeteer image with Node.js and Google Chrome pre-installed
FROM ghcr.io/puppeteer/puppeteer:22

USER root

WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install production dependencies without running scripts prematurely
RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev --ignore-scripts

# Copy application source code
COPY . .

# Run patch after all files are copied
RUN node patch-wwebjs.js

# Set permissions for the application folder
RUN chown -R pptruser:pptruser /app

USER pptruser

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
