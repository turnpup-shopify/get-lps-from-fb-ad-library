# Runs the full app (Node server + headless Chromium) in one container.
# The official Playwright image already includes Chromium and all system
# libraries it needs, at $PLAYWRIGHT_BROWSERS_PATH (=/ms-playwright), which
# src/scraper.js auto-detects. Keep this tag in sync with the "playwright"
# version in package.json.
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Most hosts inject PORT; the server falls back to 3000 locally.
EXPOSE 3000

CMD ["npm", "start"]
