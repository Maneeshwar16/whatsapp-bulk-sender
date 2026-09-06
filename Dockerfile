# Use Node.js 20 on Debian Bullseye Slim
FROM node:20-bullseye-slim

# Install Chromium and fonts directly from official Debian repositories
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       chromium \
       fonts-ipafont-gothic \
       fonts-wqy-zenhei \
       fonts-thai-tlwg \
       fonts-kacst \
       fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*

# Create working directory
WORKDIR /app

# Configure Puppeteer environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=3000

# Copy package descriptors
COPY package*.json ./

# Install production dependencies and run postinstall patch
RUN npm ci --omit=dev || npm install --omit=dev

# Copy project files
COPY . .

# Expose default port
EXPOSE 3000

# Run the WhatsApp server
CMD ["node", "server.js"]
