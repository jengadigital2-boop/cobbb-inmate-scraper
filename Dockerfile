# Use official Playwright image — comes with Chromium + all deps pre-installed
# No permission issues, no su failures
FROM mcr.microsoft.com/playwright:v1.41.0-jammy

WORKDIR /app

# Copy package files and install Node dependencies only (browsers already in base image)
COPY package.json ./
RUN npm install --omit=dev

# Copy app
COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
