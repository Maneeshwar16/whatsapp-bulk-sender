# Use Node.js 20 on Debian Bullseye Slim
FROM node:20-bullseye-slim

# Install Google Chrome Stable and necessary system libraries for Puppeteer
RUN apt-get update \
    && apt-get install -y wget gnupg ca-certificates procps \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Create working directory
WORKDIR /app

# Configure Puppeteer environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
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
